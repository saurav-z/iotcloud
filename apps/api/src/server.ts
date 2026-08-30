import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import bcrypt from 'bcryptjs';
import { Aedes } from 'aedes';
import { createWebSocketStream } from 'ws';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import nodemailer from 'nodemailer';
import { createServer as createTcpServer } from 'node:net';
import { z } from 'zod';

import { pool, migrate } from './db.js';
import { encrypt, decrypt, token } from './crypto.js';
import {
  allowedTopic,
  deviceTopic,
  parseTopic,
} from './topics.js';
import {
  executeWorkflow,
  Event,
  Definition,
} from './workflow.js';

const app = Fastify({
  logger: true,
  bodyLimit: 1024 * 1024,
});

/*
 * ============================================================
 * ENVIRONMENT
 * ============================================================
 */

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required');
}

const FRONTEND_ORIGIN = process.env.ALLOWED_ORIGIN;

if (!FRONTEND_ORIGIN) {
  throw new Error('ALLOWED_ORIGIN environment variable is required');
}

/*
 * ============================================================
 * FASTIFY PLUGINS
 * ============================================================
 */

function isAuthRoute(url: string): boolean {
  const pathname = url.split('?')[0];

  return (
    pathname === '/api/auth/register' ||
    pathname === '/api/auth/login' ||
    pathname.startsWith('/api/auth/')
  );
}

app.addHook('onRequest', async (req, reply) => {
  const origin = req.headers.origin;

  if (!origin) {
    return;
  }

  const isAuth = isAuthRoute(req.url);
  const allowOrigin = isAuth ? FRONTEND_ORIGIN : origin;

  reply.header('Access-Control-Allow-Origin', allowOrigin);
  reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Webhook-Secret');
  reply.header('Access-Control-Max-Age', '86400');
  reply.header('Vary', 'Origin');

  if (isAuth && origin !== FRONTEND_ORIGIN) {
    return reply.code(403).send({
      error: 'origin not allowed',
    });
  }

  if (req.method === 'OPTIONS') {
    return reply.code(204).send();
  }
});

await app.register(jwt, {
  secret: JWT_SECRET,
});

await app.register(websocket, {
  options: {
    maxPayload: 1024 * 1024,
    perMessageDeflate: true,
  },
});

/*
 * ============================================================
 * BROKER / EVENT BUS
 * ============================================================
 */

const broker = await Aedes.createBroker({
  concurrency: 100,
  drainTimeout: 5000,
});

const bus = new EventEmitter();

const wsClients = new Map<string, Set<any>>();
const sseClients = new Map<string, Set<any>>();

const rate = new Map<
  string,
  {
    n: number;
    t: number;
  }
>();

/*
 * ============================================================
 * RATE LIMITING
 * ============================================================
 */

function limited(ip: string): boolean {
  const now = Date.now();
  const current = rate.get(ip);

  if (!current || now - current.t > 60_000) {
    rate.set(ip, {
      n: 1,
      t: now,
    });

    return false;
  }

  current.n++;

  return current.n > 300;
}

app.addHook('onRequest', async (req, reply) => {
  if (limited(req.ip)) {
    return reply.code(429).send({
      error: 'rate limit exceeded',
    });
  }
});

/*
 * ============================================================
 * HELPERS
 * ============================================================
 */

async function deviceByToken(t: string) {
  const { rows } = await pool.query(
    `
      SELECT
        d.*,
        p.name AS project_name
      FROM devices d
      JOIN projects p
        ON p.id = d.project_id
      WHERE d.token = $1
    `,
    [t],
  );

  return rows[0];
}

async function projectOwned(
  projectId: string,
  userId: string,
) {
  const { rows } = await pool.query(
    `
      SELECT
        id,
        name,
        api_key
      FROM projects
      WHERE id = $1
        AND user_id = $2
    `,
    [projectId, userId],
  );

  return rows[0];
}

function emit(
  projectId: string,
  event: Event,
) {
  bus.emit(projectId, event);

  /*
   * WebSocket dashboard clients
   */
  for (
    const socket of wsClients.get(projectId) || []
  ) {
    if (socket.readyState === 1) {
      socket.send(
        JSON.stringify({
          type: 'event',
          event,
        }),
      );
    }
  }

  /*
   * SSE dashboard clients
   */
  for (
    const response of sseClients.get(projectId) || []
  ) {
    try {
      response.raw.write(
        `event: ${event.type}\n` +
        `data: ${JSON.stringify(event)}\n\n`,
      );
    } catch (error) {
      app.log.error(error);
    }
  }
}

function render(
  s: string,
  e: Event,
): string {
  return s.replace(
    /\{\{\s*([^}]+)\s*\}\}/g,
    (_, p) =>
      String(
        p
          .split('.')
          .reduce(
            (
              value: string | object,
              key: string,
            ) =>
              value &&
              typeof value === 'object'
                ? (value as any)[key]
                : undefined,
            e as any,
          ) ?? '',
      ),
  );
}

async function credential(
  projectId: string,
  id: string | undefined,
  kind: string,
) {
  if (!id) {
    return null;
  }

  const { rows } = await pool.query(
    `
      SELECT secret
      FROM credentials
      WHERE id = $1
        AND project_id = $2
        AND kind = $3
    `,
    [id, projectId, kind],
  );

  if (!rows[0]) {
    return null;
  }

  return JSON.parse(
    decrypt(rows[0].secret),
  );
}

/*
 * ============================================================
 * WORKFLOWS
 * ============================================================
 */

async function runWorkflows(event: Event) {
  const { rows } = await pool.query(
    `
      SELECT
        id,
        project_id,
        definition
      FROM workflows
      WHERE project_id = $1
        AND enabled = true
    `,
    [event.projectId],
  );

  for (const workflow of rows) {
    const run = await pool.query(
      `
        INSERT INTO workflow_runs(
          workflow_id,
          status,
          trigger_event
        )
        VALUES($1, $2, $3)
        RETURNING id
      `,
      [
        workflow.id,
        'running',
        event,
      ],
    );

    try {
      await executeWorkflow(
        workflow.definition as Definition,
        event,
        {
          async 'action.telegram.send'(node, currentEvent) {
            const c = await credential(
              currentEvent.projectId,
              node.data?.credentialId,
              'telegram',
            );

            if (!c) {
              console.error('[Telegram Action Error] Credential not found.');
              return;
            }

            const targetRecipient = node.data?.recipient || node.data?.chatId || c.chatId || c.chat_id;
            let targetChatIds: string[] = [];

            if (targetRecipient === 'all' || targetRecipient === 'broadcast') {
              if (Array.isArray(c.subscribers) && c.subscribers.length > 0) {
                targetChatIds = c.subscribers.map((s: any) => String(s.chatId));
              } else if (c.chatId) {
                targetChatIds = [String(c.chatId)];
              }
            } else if (targetRecipient) {
              targetChatIds = [String(targetRecipient)];
            } else if (c.chatId) {
              targetChatIds = [String(c.chatId)];
            }

            if (targetChatIds.length === 0) {
              console.error('[Telegram Action Error] No target Chat IDs or subscribers available.');
              return;
            }

            const messageText = render(
              node.data?.text || JSON.stringify(currentEvent.data),
              currentEvent,
            );

            for (const chatId of targetChatIds) {
              try {
                const res = await fetch(
                  `https://api.telegram.org/bot${c.token}/sendMessage`,
                  {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                      chat_id: chatId,
                      text: messageText,
                      parse_mode: node.data?.parseMode && node.data?.parseMode !== 'None' ? node.data.parseMode : undefined,
                      disable_notification: Boolean(node.data?.disableNotification),
                      disable_web_page_preview: Boolean(node.data?.disableWebPagePreview),
                    }),
                  },
                );

                if (!res.ok) {
                  console.error('[Telegram API Error]', chatId, res.status, await res.text());
                }
              } catch (err) {
                console.error('[Telegram Send Exception]', chatId, err);
              }
            }
          },

          async 'action.discord.send'(node, currentEvent) {
            const c = await credential(
              currentEvent.projectId,
              node.data?.credentialId,
              'discord',
            );

            if (!c) {
              return;
            }

            await fetch(c.webhookUrl, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                content: render(
                  node.data?.text ||
                    JSON.stringify(currentEvent.data),
                  currentEvent,
                ),
              }),
            });
          },

          async 'action.email.send'(node, currentEvent) {
            const c = await credential(
              currentEvent.projectId,
              node.data?.credentialId,
              'smtp',
            );

            if (!c) {
              return;
            }

            const transporter =
              nodemailer.createTransport({
                host: c.host,
                port: Number(c.port),
                secure: Boolean(c.secure),
                auth: {
                  user: c.user,
                  pass: c.pass,
                },
              });

            await transporter.sendMail({
              from: c.from || c.user,
              to: node.data?.to,
              subject: render(
                node.data?.subject ||
                  'IoTCloud alert',
                currentEvent,
              ),
              text: render(
                node.data?.text ||
                  JSON.stringify(currentEvent.data),
                currentEvent,
              ),
            });
          },

          async 'action.webhook.send'(node, currentEvent) {
            if (!node.data?.url) {
              return;
            }

            await fetch(node.data.url, {
              method:
                node.data?.method || 'POST',
              headers: {
                'content-type':
                  'application/json',
                ...(node.data?.headers || {}),
              },
              body: JSON.stringify(currentEvent),
            });
          },

          async 'iot.mqtt.publish'(node, currentEvent) {
            if (!node.data?.topic) {
              return;
            }

            const topic = deviceTopic(
              currentEvent.projectId,
              node.data.deviceId ||
                currentEvent.deviceId ||
                'gateway',
              node.data.topic,
            );

            broker.publish(
              {
                cmd: 'publish',
                topic,
                payload: Buffer.from(
                  JSON.stringify(
                    node.data.payload ??
                      currentEvent.data,
                  ),
                ),
                qos: 0,
                retain: false,
                dup: false,
              },
              () => {},
            );
          },
        },
      );

      await pool.query(
        `
          UPDATE workflow_runs
          SET
            status = $1,
            finished_at = now()
          WHERE id = $2
        `,
        [
          'success',
          run.rows[0].id,
        ],
      );
    } catch (error) {
      await pool.query(
        `
          UPDATE workflow_runs
          SET
            status = $1,
            finished_at = now(),
            error = $2
          WHERE id = $3
        `,
        [
          'error',
          String(error),
          run.rows[0].id,
        ],
      );

      app.log.error(error);
    }
  }
}

/*
 * ============================================================
 * MQTT AUTHORIZATION
 * ============================================================
 */

broker.authenticate = async (
  client,
  username,
  password,
  callback,
) => {
  try {
    const deviceToken = Buffer.isBuffer(username)
      ? username.toString()
      : String(username || '');

    const device =
      await deviceByToken(deviceToken);

    if (!device) {
      return callback(null, false);
    }

    (client as any).userdata = device;

    callback(null, true);
  } catch (error) {
    const err = Object.assign(
      error instanceof Error
        ? error
        : new Error(String(error)),
      {
        returnCode: 5 as any,
      },
    );

    callback(err, false);
  }
};

broker.authorizePublish = async (
  client,
  packet,
  callback,
) => {
  const device = (client as any).userdata;

  if (
    !device ||
    !allowedTopic(
      packet.topic,
      device.project_id,
      device.id,
    )
  ) {
    return callback(
      new Error('publish not authorized'),
    );
  }

  callback(null);
};

broker.authorizeSubscribe = async (
  client,
  sub,
  callback,
) => {
  const device = (client as any).userdata;
  const parsed = parseTopic(sub.topic);

  if (
    !device ||
    !parsed ||
    parsed.projectId !== device.project_id ||
    parsed.deviceId !== device.id
  ) {
    return callback(
      new Error('subscribe not authorized'),
    );
  }

  callback(null, sub);
};

/*
 * ============================================================
 * MQTT DEVICE EVENTS
 * ============================================================
 */

broker.on(
  'clientReady',
  async (client) => {
    const device =
      (client as any).userdata;

    if (!device) {
      return;
    }

    await pool.query(
      `
        UPDATE devices
        SET
          online = true,
          last_seen = now()
        WHERE id = $1
      `,
      [device.id],
    );

    emit(
      device.project_id,
      {
        id: crypto.randomUUID(),
        type: 'device.online',
        deviceId: device.id,
        projectId: device.project_id,
        data: {},
        timestamp:
          new Date().toISOString(),
      },
    );
  },
);

broker.on(
  'clientDisconnect',
  async (client) => {
    const device =
      (client as any).userdata;

    if (!device) {
      return;
    }

    await pool.query(
      `
        UPDATE devices
        SET
          online = false,
          last_seen = now()
        WHERE id = $1
      `,
      [device.id],
    );

    emit(
      device.project_id,
      {
        id: crypto.randomUUID(),
        type: 'device.offline',
        deviceId: device.id,
        projectId: device.project_id,
        data: {},
        timestamp:
          new Date().toISOString(),
      },
    );
  },
);

broker.on(
  'publish',
  async (packet, client) => {
    if (
      packet.topic.startsWith('$SYS')
    ) {
      return;
    }

    const parsed =
      parseTopic(packet.topic);

    if (!parsed) {
      return;
    }

    let data: any;

    try {
      data = JSON.parse(
        packet.payload.toString(),
      );
    } catch {
      data = {
        value:
          packet.payload.toString(),
      };
    }

    const event: Event = {
      id: crypto.randomUUID(),
      type: 'mqtt.message',
      topic: parsed.topic,
      deviceId: parsed.deviceId,
      projectId: parsed.projectId,
      data,
      timestamp:
        new Date().toISOString(),
    };

    try {
      await pool.query(
        `
          INSERT INTO telemetry(
            project_id,
            device_id,
            topic,
            payload
          )
          VALUES($1, $2, $3, $4)
        `,
        [
          parsed.projectId,
          parsed.deviceId,
          parsed.topic,
          data,
        ],
      );

      await pool.query(
        `
          UPDATE devices
          SET
            last_seen = now(),
            online = true
          WHERE id = $1
        `,
        [parsed.deviceId],
      );
    } catch (error) {
      app.log.error(error);
    }

    emit(
      parsed.projectId,
      event,
    );

    runWorkflows(event).catch(
      (error) => app.log.error(error),
    );
  },
);

/*
 * ============================================================
 * SCHEDULED WORKFLOWS
 * ============================================================
 */

const scheduleLast =
  new Map<string, number>();

setInterval(async () => {
  try {
    const { rows } =
      await pool.query(`
        SELECT
          id,
          project_id,
          definition
        FROM workflows
        WHERE enabled = true
          AND definition::text
            LIKE '%schedule.trigger%'
      `);

    for (const workflow of rows) {
      for (
        const node of
          workflow.definition?.nodes || []
      ) {
        if (
          node.type !==
          'schedule.trigger'
        ) {
          continue;
        }

        const seconds = Math.max(
          5,
          Number(
            node.data?.intervalSeconds ||
              60,
          ),
        );

        const key =
          `${workflow.id}:${node.id}`;

        const now = Date.now();

        if (
          now -
            (scheduleLast.get(key) || 0) >=
          seconds * 1000
        ) {
          scheduleLast.set(
            key,
            now,
          );

          runWorkflows({
            id: crypto.randomUUID(),
            type: 'schedule',
            projectId:
              workflow.project_id,
            data: {
              schedule:
                node.data || {},
            },
            timestamp:
              new Date().toISOString(),
          }).catch((error) =>
            app.log.error(error),
          );
        }
      }
    }
  } catch (error) {
    app.log.error(error);
  }
}, 5000);

/*
 * ============================================================
 * HEALTH
 * ============================================================
 */

app.get(
  '/health',
  async () => ({
    ok: true,
    service: 'iotcloud',
    version: '1.0.0',
    time:
      new Date().toISOString(),
  }),
);

/*
 * ============================================================
 * JWT AUTH
 * ============================================================
 */

app.decorate(
  'auth',
  async (
    req: any,
    reply: any,
  ) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply
        .code(401)
        .send({
          error: 'unauthorized',
        });
    }
  },
);

/*
 * ============================================================
 * AUTH - REGISTER
 * ============================================================
 */

app.post(
  '/api/auth/register',
  async (req, reply) => {
    const body =
      z.object({
        email: z
          .string()
          .email(),
        password: z
          .string()
          .min(8),
      }).parse(req.body);

    const hash =
      await bcrypt.hash(
        body.password,
        12,
      );

    try {
      const { rows } =
        await pool.query(
          `
            INSERT INTO users(
              email,
              password_hash
            )
            VALUES($1, $2)
            RETURNING id, email
          `,
          [
            body.email.toLowerCase(),
            hash,
          ],
        );

      return {
        token: app.jwt.sign({
          sub: rows[0].id,
          email: rows[0].email,
        }),
        user: rows[0],
      };
    } catch {
      return reply
        .code(409)
        .send({
          error:
            'email already registered',
        });
    }
  },
);

/*
 * ============================================================
 * AUTH - LOGIN
 * ============================================================
 */

app.post(
  '/api/auth/login',
  async (req, reply) => {
    const body =
      z.object({
        email: z
          .string()
          .email(),
        password: z.string(),
      }).parse(req.body);

    const { rows } =
      await pool.query(
        `
          SELECT *
          FROM users
          WHERE email = $1
        `,
        [
          body.email.toLowerCase(),
        ],
      );

    if (
      !rows[0] ||
      !(
        await bcrypt.compare(
          body.password,
          rows[0].password_hash,
        )
      )
    ) {
      return reply
        .code(401)
        .send({
          error:
            'invalid credentials',
        });
    }

    return {
      token: app.jwt.sign({
        sub: rows[0].id,
        email: rows[0].email,
      }),
      user: {
        id: rows[0].id,
        email: rows[0].email,
      },
    };
  },
);

/*
 * ============================================================
 * CURRENT USER
 * ============================================================
 */

app.get(
  '/api/me',
  {
    preHandler:
      (app as any).auth,
  },
  async (req: any) => ({
    id: req.user.sub,
    email: req.user.email,
  }),
);

/*
 * ============================================================
 * PROJECTS
 * ============================================================
 */

app.get(
  '/api/projects',
  {
    preHandler:
      (app as any).auth,
  },
  async (req: any) => {
    const { rows } =
      await pool.query(
        `
          SELECT
            id,
            name,
            api_key,
            created_at
          FROM projects
          WHERE user_id = $1
          ORDER BY created_at DESC
        `,
        [req.user.sub],
      );

    return rows;
  },
);

app.post(
  '/api/projects',
  {
    preHandler:
      (app as any).auth,
  },
  async (req: any) => {
    const body =
      z.object({
        name: z
          .string()
          .min(1)
          .max(100),
      }).parse(req.body);

    const { rows } =
      await pool.query(
        `
          INSERT INTO projects(
            user_id,
            name,
            api_key
          )
          VALUES($1, $2, $3)
          RETURNING
            id,
            name,
            api_key,
            created_at
        `,
        [
          req.user.sub,
          body.name,
          token('pk'),
        ],
      );

    return rows[0];
  },
);

/*
 * ============================================================
 * DEVICES
 * ============================================================
 */

app.get(
  '/api/projects/:id/devices',
  {
    preHandler:
      (app as any).auth,
  },
  async (
    req: any,
    reply,
  ) => {
    if (
      !(
        await projectOwned(
          req.params.id,
          req.user.sub,
        )
      )
    ) {
      return reply
        .code(404)
        .send({
          error:
            'project not found',
        });
    }

    const { rows } =
      await pool.query(
        `
          SELECT
            id,
            name,
            token,
            metadata,
            last_seen,
            online,
            created_at
          FROM devices
          WHERE project_id = $1
          ORDER BY created_at DESC
        `,
        [req.params.id],
      );

    return rows;
  },
);

app.post(
  '/api/projects/:id/devices',
  {
    preHandler:
      (app as any).auth,
  },
  async (
    req: any,
    reply,
  ) => {
    if (
      !(
        await projectOwned(
          req.params.id,
          req.user.sub,
        )
      )
    ) {
      return reply
        .code(404)
        .send({
          error:
            'project not found',
        });
    }

    const body =
      z.object({
        name: z
          .string()
          .min(1)
          .max(100),
        metadata:
          z.record(
            z.string(),
            z.any(),
          ).optional(),
      }).parse(req.body);

    const { rows } =
      await pool.query(
        `
          INSERT INTO devices(
            project_id,
            name,
            token,
            metadata
          )
          VALUES($1, $2, $3, $4)
          RETURNING
            id,
            name,
            token,
            metadata
        `,
        [
          req.params.id,
          body.name,
          token('dev'),
          body.metadata || {},
        ],
      );

    return rows[0];
  },
);

app.delete(
  '/api/projects/:id/devices/:deviceId',
  {
    preHandler:
      (app as any).auth,
  },
  async (
    req: any,
    reply,
  ) => {
    if (
      !(
        await projectOwned(
          req.params.id,
          req.user.sub,
        )
      )
    ) {
      return reply
        .code(404)
        .send({
          error:
            'project not found',
        });
    }

    await pool.query(
      `
        DELETE FROM devices
        WHERE id = $1
          AND project_id = $2
      `,
      [
        req.params.deviceId,
        req.params.id,
      ],
    );

    return {
      ok: true,
    };
  },
);

/*
 * ============================================================
 * TELEMETRY
 * ============================================================
 */

app.get(
  '/api/projects/:id/telemetry',
  {
    preHandler:
      (app as any).auth,
  },
  async (
    req: any,
    reply,
  ) => {
    if (
      !(
        await projectOwned(
          req.params.id,
          req.user.sub,
        )
      )
    ) {
      return reply
        .code(404)
        .send({
          error:
            'project not found',
        });
    }

    const limit = Math.min(
      Number(
        req.query?.limit || 100,
      ),
      500,
    );

    const { rows } =
      await pool.query(
        `
          SELECT
            id,
            device_id,
            topic,
            payload,
            created_at
          FROM telemetry
          WHERE project_id = $1
          ORDER BY created_at DESC
          LIMIT $2
        `,
        [
          req.params.id,
          limit,
        ],
      );

    return rows;
  },
);

/*
 * ============================================================
 * DEVICE PUBLISH
 * ============================================================
 */

app.post(
  '/api/device/publish',
  async (
    req: any,
    reply,
  ) => {
    const body =
      z.object({
        deviceId: z
          .string()
          .uuid()
          .optional(),
        topic: z
          .string()
          .min(1),
        data: z.any(),
      }).parse(req.body);

    const device =
      await deviceByToken(
        req.headers.authorization
          ?.replace(
            /^Bearer /i,
            '',
          ) || '',
      );

    if (
      !device ||
      (body.deviceId &&
        device.id !== body.deviceId)
    ) {
      return reply
        .code(403)
        .send({
          error:
            'device token required',
        });
    }

    broker.publish(
      {
        cmd: 'publish',
        topic: deviceTopic(
          device.project_id,
          device.id,
          body.topic,
        ),
        payload: Buffer.from(
          JSON.stringify(
            body.data,
          ),
        ),
        qos: 0,
        retain: false,
        dup: false,
      },
      () => {},
    );

    return {
      ok: true,
    };
  },
);

/*
 * ============================================================
 * WORKFLOWS
 * ============================================================
 */

app.get(
  '/api/projects/:id/workflows',
  {
    preHandler:
      (app as any).auth,
  },
  async (
    req: any,
    reply,
  ) => {
    if (
      !(
        await projectOwned(
          req.params.id,
          req.user.sub,
        )
      )
    ) {
      return reply
        .code(404)
        .send({
          error:
            'project not found',
        });
    }

    const { rows } =
      await pool.query(
        `
          SELECT
            id,
            name,
            definition,
            enabled,
            created_at,
            updated_at
          FROM workflows
          WHERE project_id = $1
          ORDER BY updated_at DESC
        `,
        [req.params.id],
      );

    return rows;
  },
);

app.post(
  '/api/projects/:id/workflows',
  {
    preHandler:
      (app as any).auth,
  },
  async (
    req: any,
    reply,
  ) => {
    if (
      !(
        await projectOwned(
          req.params.id,
          req.user.sub,
        )
      )
    ) {
      return reply
        .code(404)
        .send({
          error:
            'project not found',
        });
    }

    const body =
      z.object({
        name: z
          .string()
          .min(1),
        definition:
          z.object({
            nodes:
              z.array(z.any()),
            edges:
              z.array(z.any()),
          }),
        enabled:
          z.boolean().optional(),
      }).parse(req.body);

    const definition = {
      ...body.definition,
      webhookSecret:
        token('wh'),
    };

    const { rows } =
      await pool.query(
        `
          INSERT INTO workflows(
            project_id,
            name,
            definition,
            enabled
          )
          VALUES($1, $2, $3, $4)
          RETURNING *
        `,
        [
          req.params.id,
          body.name,
          definition,
          body.enabled ?? false,
        ],
      );

    return rows[0];
  },
);

app.put(
  '/api/projects/:id/workflows/:workflowId',
  {
    preHandler:
      (app as any).auth,
  },
  async (
    req: any,
    reply,
  ) => {
    if (
      !(
        await projectOwned(
          req.params.id,
          req.user.sub,
        )
      )
    ) {
      return reply
        .code(404)
        .send({
          error:
            'project not found',
        });
    }

    const body =
      z.object({
        name:
          z.string()
            .min(1)
            .optional(),

        definition:
          z.object({
            nodes:
              z.array(z.any()),
            edges:
              z.array(z.any()),
          }).optional(),

        enabled:
          z.boolean().optional(),
      }).parse(req.body);

    const existing =
      await pool.query(
        `
          SELECT definition
          FROM workflows
          WHERE id = $1
            AND project_id = $2
        `,
        [
          req.params.workflowId,
          req.params.id,
        ],
      );

    if (!existing.rows[0]) {
      return reply
        .code(404)
        .send({
          error:
            'workflow not found',
        });
    }

    const nextDefinition =
      body.definition
        ? {
            ...body.definition,
            webhookSecret:
              existing.rows[0]
                .definition
                ?.webhookSecret ||
              token('wh'),
          }
        : undefined;

    const { rows } =
      await pool.query(
        `
          UPDATE workflows
          SET
            name =
              COALESCE($1, name),
            definition =
              COALESCE(
                $2,
                definition
              ),
            enabled =
              COALESCE(
                $3,
                enabled
              ),
            updated_at = now()
          WHERE id = $4
            AND project_id = $5
          RETURNING *
        `,
        [
          body.name,
          nextDefinition,
          body.enabled,
          req.params.workflowId,
          req.params.id,
        ],
      );

    return (
      rows[0] ||
      reply
        .code(404)
        .send({
          error:
            'workflow not found',
        })
    );
  },
);

app.delete(
  '/api/projects/:id/workflows/:workflowId',
  {
    preHandler:
      (app as any).auth,
  },
  async (
    req: any,
    reply,
  ) => {
    if (
      !(
        await projectOwned(
          req.params.id,
          req.user.sub,
        )
      )
    ) {
      return reply
        .code(404)
        .send({
          error:
            'project not found',
        });
    }

    await pool.query(
      `
        DELETE FROM workflows
        WHERE id = $1
          AND project_id = $2
      `,
      [
        req.params.workflowId,
        req.params.id,
      ],
    );

    return {
      ok: true,
    };
  },
);

/*
 * ============================================================
 * WORKFLOW RUNS
 * ============================================================
 */

app.get(
  '/api/projects/:id/runs',
  {
    preHandler:
      (app as any).auth,
  },
  async (
    req: any,
    reply,
  ) => {
    if (
      !(
        await projectOwned(
          req.params.id,
          req.user.sub,
        )
      )
    ) {
      return reply
        .code(404)
        .send({
          error:
            'project not found',
        });
    }

    const { rows } =
      await pool.query(
        `
          SELECT
            r.*,
            w.name AS workflow_name
          FROM workflow_runs r
          JOIN workflows w
            ON w.id = r.workflow_id
          WHERE w.project_id = $1
          ORDER BY r.started_at DESC
          LIMIT 100
        `,
        [req.params.id],
      );

    return rows;
  },
);

/*
 * ============================================================
 * CREDENTIALS
 * ============================================================
 */

app.post(
  '/api/projects/:id/credentials',
  {
    preHandler:
      (app as any).auth,
  },
  async (
    req: any,
    reply,
  ) => {
    if (
      !(
        await projectOwned(
          req.params.id,
          req.user.sub,
        )
      )
    ) {
      return reply
        .code(404)
        .send({
          error:
            'project not found',
        });
    }

    const body =
      z.object({
        name:
          z.string().min(1),

        kind:
          z.enum([
            'telegram',
            'discord',
            'smtp',
            'webhook',
          ]),

        config:
          z.record(
            z.string(),
            z.any(),
          ),
      }).parse(req.body);

    const { rows } =
      await pool.query(
        `
          INSERT INTO credentials(
            project_id,
            name,
            kind,
            secret
          )
          VALUES($1, $2, $3, $4)
          RETURNING
            id,
            name,
            kind,
            created_at
        `,
        [
          req.params.id,
          body.name,
          body.kind,
          encrypt(
            JSON.stringify(
              body.config,
            ),
          ),
        ],
      );

    return rows[0];
  },
);

app.get(
  '/api/projects/:id/credentials',
  {
    preHandler:
      (app as any).auth,
  },
  async (
    req: any,
    reply,
  ) => {
    if (
      !(
        await projectOwned(
          req.params.id,
          req.user.sub,
        )
      )
    ) {
      return reply
        .code(404)
        .send({
          error:
            'project not found',
        });
    }

    const { rows } =
      await pool.query(
        `
          SELECT
            id,
            name,
            kind,
            created_at
          FROM credentials
          WHERE project_id = $1
          ORDER BY created_at DESC
        `,
        [req.params.id],
      );

    return rows;
  },
);

app.post(
  '/api/projects/:id/credentials/:credentialId/test',
  {
    preHandler:
      (app as any).auth,
  },
  async (
    req: any,
    reply,
  ) => {
    if (
      !(
        await projectOwned(
          req.params.id,
          req.user.sub,
        )
      )
    ) {
      return reply
        .code(404)
        .send({
          error:
            'project not found',
        });
    }

    const { rows } =
      await pool.query(
        `
          SELECT
            kind,
            secret
          FROM credentials
          WHERE id = $1
            AND project_id = $2
        `,
        [
          req.params.credentialId,
          req.params.id,
        ],
      );

    if (!rows[0]) {
      return reply
        .code(404)
        .send({
          error:
            'credential not found',
        });
    }

    const config =
      JSON.parse(
        decrypt(
          rows[0].secret,
        ),
      );

    try {
      if (
        rows[0].kind ===
        'discord'
      ) {
        await fetch(
          config.webhookUrl,
          {
            method: 'POST',
            headers: {
              'content-type':
                'application/json',
            },
            body: JSON.stringify({
              content:
                'IoTCloud connection test',
            }),
          },
        );
      } else if (
        rows[0].kind === 'telegram'
      ) {
        const chatId = config.chatId || config.chat_id;
        if (chatId) {
          const res = await fetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: '⚡ IoTCloud connection test successfully verified!' }),
          });
          if (!res.ok) {
            const errData = await res.json().catch(() => ({ description: 'Failed to send Telegram test message' }));
            return reply.code(400).send({ ok: false, error: errData.description || 'Telegram API Error' });
          }
        } else {
          const res = await fetch(`https://api.telegram.org/bot${config.token}/getMe`);
          if (!res.ok) {
            return reply.code(400).send({ ok: false, error: 'Invalid Telegram Bot Token' });
          }
        }
      } else if (
        rows[0].kind === 'smtp'
      ) {
        const transporter =
          nodemailer.createTransport(
            {
              host: config.host,
              port: Number(
                config.port,
              ),
              secure: Boolean(
                config.secure,
              ),
              auth: {
                user: config.user,
                pass: config.pass,
              },
            },
          );

        await transporter.verify();
      } else {
        await fetch(
          config.url,
          {
            method: 'HEAD',
          },
        );
      }

      return {
        ok: true,
      };
    } catch (error) {
      return reply
        .code(400)
        .send({
          ok: false,
          error: String(error),
        });
    }
  },
);

// --- TELEGRAM SUBSCRIBERS SYNC & MANAGEMENT ---

app.post(
  '/api/projects/:id/credentials/:credentialId/telegram/sync',
  {
    preHandler: (app as any).auth,
  },
  async (req: any, reply) => {
    if (!(await projectOwned(req.params.id, req.user.sub))) {
      return reply.code(404).send({ error: 'project not found' });
    }

    const { rows } = await pool.query(
      `
        SELECT id, secret
        FROM credentials
        WHERE id = $1 AND project_id = $2 AND kind = 'telegram'
      `,
      [req.params.credentialId, req.params.id],
    );

    if (!rows[0]) {
      return reply.code(404).send({ error: 'Telegram credential not found' });
    }

    const config = JSON.parse(rows[0].secret);
    if (!config.token) {
      return reply.code(400).send({ error: 'Bot Token missing' });
    }

    const tgRes = await fetch(`https://api.telegram.org/bot${config.token}/getUpdates`);
    if (!tgRes.ok) {
      const errText = await tgRes.text();
      return reply.code(400).send({ error: `Telegram Error: ${errText}` });
    }

    const data = await tgRes.json();
    const updates = data.result || [];

    const existingSubscribers: any[] = config.subscribers || [];
    const subMap = new Map<string, any>();
    for (const sub of existingSubscribers) {
      subMap.set(String(sub.chatId), sub);
    }

    let newCount = 0;
    for (const u of updates) {
      const msg = u.message || u.channel_post || u.edited_message || u.callback_query?.message;
      if (!msg || !msg.chat) continue;

      const chatId = String(msg.chat.id);
      const username = msg.chat.username || msg.from?.username || '';
      const firstName = msg.chat.first_name || msg.from?.first_name || '';
      const lastName = msg.chat.last_name || msg.from?.last_name || '';

      if (!subMap.has(chatId)) {
        newCount++;
      }

      subMap.set(chatId, {
        chatId,
        username,
        firstName,
        lastName,
        subscribedAt: subMap.get(chatId)?.subscribedAt || new Date().toISOString(),
      });
    }

    const updatedSubscribers = Array.from(subMap.values());
    config.subscribers = updatedSubscribers;

    await pool.query(
      `
        UPDATE credentials
        SET secret = $1
        WHERE id = $2
      `,
      [JSON.stringify(config), req.params.credentialId],
    );

    return {
      ok: true,
      subscribers: updatedSubscribers,
      newCount,
      totalCount: updatedSubscribers.length,
    };
  },
);

app.post(
  '/api/projects/:id/credentials/:credentialId/telegram/subscribers',
  {
    preHandler: (app as any).auth,
  },
  async (req: any, reply) => {
    if (!(await projectOwned(req.params.id, req.user.sub))) {
      return reply.code(404).send({ error: 'project not found' });
    }

    const { chatId, username, firstName } = req.body || {};
    if (!chatId) {
      return reply.code(400).send({ error: 'Chat ID is required' });
    }

    const { rows } = await pool.query(
      `
        SELECT secret
        FROM credentials
        WHERE id = $1 AND project_id = $2 AND kind = 'telegram'
      `,
      [req.params.credentialId, req.params.id],
    );

    if (!rows[0]) {
      return reply.code(404).send({ error: 'Telegram credential not found' });
    }

    const config = JSON.parse(rows[0].secret);
    const existing: any[] = config.subscribers || [];
    const subMap = new Map<string, any>(existing.map(s => [String(s.chatId), s]));

    subMap.set(String(chatId), {
      chatId: String(chatId),
      username: username || '',
      firstName: firstName || 'Subscriber',
      subscribedAt: new Date().toISOString(),
    });

    config.subscribers = Array.from(subMap.values());

    await pool.query(
      `
        UPDATE credentials
        SET secret = $1
        WHERE id = $2
      `,
      [JSON.stringify(config), req.params.credentialId],
    );

    return { ok: true, subscribers: config.subscribers };
  },
);

app.delete(
  '/api/projects/:id/credentials/:credentialId/telegram/subscribers/:targetChatId',
  {
    preHandler: (app as any).auth,
  },
  async (req: any, reply) => {
    if (!(await projectOwned(req.params.id, req.user.sub))) {
      return reply.code(404).send({ error: 'project not found' });
    }

    const { rows } = await pool.query(
      `
        SELECT secret
        FROM credentials
        WHERE id = $1 AND project_id = $2 AND kind = 'telegram'
      `,
      [req.params.credentialId, req.params.id],
    );

    if (!rows[0]) {
      return reply.code(404).send({ error: 'Telegram credential not found' });
    }

    const config = JSON.parse(rows[0].secret);
    const existing: any[] = config.subscribers || [];
    config.subscribers = existing.filter(s => String(s.chatId) !== String(req.params.targetChatId));

    await pool.query(
      `
        UPDATE credentials
        SET secret = $1
        WHERE id = $2
      `,
      [JSON.stringify(config), req.params.credentialId],
    );

    return { ok: true, subscribers: config.subscribers };
  },
);

// Public Webhook for Telegram Bot Auto-Subscription
app.post(
  '/v1/telegram/webhook/:credentialId',
  async (req: any, reply) => {
    const { credentialId } = req.params;
    const body = req.body || {};

    const { rows } = await pool.query(
      `
        SELECT secret
        FROM credentials
        WHERE id = $1 AND kind = 'telegram'
      `,
      [credentialId],
    );

    if (!rows[0]) {
      return reply.code(404).send({ error: 'Credential not found' });
    }

    const config = JSON.parse(rows[0].secret);
    const msg = body.message || body.channel_post || body.edited_message;

    if (msg && msg.chat) {
      const chatId = String(msg.chat.id);
      const username = msg.chat.username || msg.from?.username || '';
      const firstName = msg.chat.first_name || msg.from?.first_name || '';
      const lastName = msg.chat.last_name || msg.from?.last_name || '';

      const existing: any[] = config.subscribers || [];
      const subMap = new Map<string, any>(existing.map(s => [String(s.chatId), s]));

      subMap.set(chatId, {
        chatId,
        username,
        firstName,
        lastName,
        subscribedAt: subMap.get(chatId)?.subscribedAt || new Date().toISOString(),
      });

      config.subscribers = Array.from(subMap.values());

      await pool.query(
        `
          UPDATE credentials
          SET secret = $1
          WHERE id = $2
        `,
        [JSON.stringify(config), credentialId],
      );

      // Auto-reply to user on Telegram
      if (config.token) {
        await fetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: `👋 Hello ${firstName || 'there'}! You are now subscribed to IoTCloud notification alerts. ⚡`,
          }),
        }).catch(() => {});
      }
    }

    return { ok: true };
  },
);

app.delete(
  '/api/projects/:id/credentials/:credentialId',
  {
    preHandler: (app as any).auth,
  },
  async (req: any, reply) => {
    if (!(await projectOwned(req.params.id, req.user.sub))) {
      return reply.code(404).send({ error: 'project not found' });
    }

    await pool.query(
      `
        DELETE FROM credentials
        WHERE id = $1
          AND project_id = $2
      `,
      [req.params.credentialId, req.params.id],
    );

    return { ok: true };
  },
);

/*
 * ============================================================
 * WEBHOOK
 * ============================================================
 */

app.post(
  '/v1/webhooks/:workflowId',
  async (
    req: any,
    reply,
  ) => {
    const { rows } =
      await pool.query(
        `
          SELECT
            w.*,
            p.name AS project_name
          FROM workflows w
          JOIN projects p
            ON p.id = w.project_id
          WHERE w.id = $1
            AND w.enabled = true
        `,
        [req.params.workflowId],
      );

    if (!rows[0]) {
      return reply
        .code(404)
        .send({
          error:
            'workflow not found',
        });
    }

    const secret = String(
      req.headers[
        'x-webhook-secret'
      ] || '',
    );

    if (
      rows[0].definition
        ?.webhookSecret &&
      secret !==
        rows[0].definition
          .webhookSecret
    ) {
      return reply
        .code(401)
        .send({
          error:
            'invalid webhook secret',
        });
    }

    const event: Event = {
      id: crypto.randomUUID(),
      type: 'webhook',
      projectId:
        rows[0].project_id,
      data:
        req.body || {},
      timestamp:
        new Date().toISOString(),
    };

    emit(
      event.projectId,
      event,
    );

    await runWorkflows(event);

    return {
      ok: true,
      eventId: event.id,
    };
  },
);

/*
 * ============================================================
 * API DOCS
 * ============================================================
 */

app.get(
  '/api/docs',
  {
    preHandler:
      (app as any).auth,
  },
  async (req: any) => {
    const base =
      `${req.protocol}://${req.hostname}`;

    return {
      base,

      websocket:
        `${base.replace(
          /^http/,
          'ws',
        )}/v1/ws?token=DEVICE_TOKEN`,

      sse:
        `${base}/v1/events?token=DEVICE_TOKEN`,

      mqttWebSocket:
        `${base.replace(
          /^http/,
          'ws',
        )}/mqtt`,

      topics:
        'iotcloud/{projectId}/{deviceId}/{topic}',

      examples: {
        curl:
          `curl -X POST ${base}/api/device/publish ` +
          `-H 'Authorization: Bearer DEVICE_TOKEN' ` +
          `-H 'content-type: application/json' ` +
          `-d '{"deviceId":"DEVICE_ID","topic":"telemetry","data":{"temperature":28.4}}'`,

        javascript:
          `const ws = new WebSocket('${base.replace(
            /^http/,
            'ws',
          )}/v1/ws?token=DEVICE_TOKEN'); ` +
          `ws.onmessage = e => console.log(JSON.parse(e.data));`,

        python:
          `import requests\n` +
          `requests.post('${base}/api/device/publish', ` +
          `headers={'Authorization':'Bearer DEVICE_TOKEN'}, ` +
          `json={'deviceId':'DEVICE_ID','topic':'telemetry','data':{'temperature':28.4}})`,

        esp32:
          `mqttClient.setServer("${req.hostname}", 443); ` +
          `mqttClient.setCallback(callback); ` +
          `// use MQTT over WebSocket client library with TLS on your device`,
      },
    };
  },
);

/*
 * ============================================================
 * SSE EVENT STREAM
 * ============================================================
 *
 * Any Origin is allowed.
 *
 * Authentication is still required through the device token.
 */

app.get(
  '/v1/events',
  {
    preHandler: async (
      req: any,
      reply,
    ) => {
      const device =
        await deviceByToken(
          String(
            req.query?.token || '',
          ),
        );

      if (!device) {
        return reply
          .code(401)
          .send({
            error:
              'invalid token',
          });
      }

      req.device = device;
    },
  },
  async (
    req: any,
    reply,
  ) => {
    const device =
      req.device;

    /*
     * Explicitly allow every origin.
     */
    reply.raw.writeHead(
      200,
      {
        'content-type':
          'text/event-stream',
        'cache-control':
          'no-cache, no-transform',
        connection: 'keep-alive',
        'access-control-allow-origin':
          '*',
      },
    );

    reply.raw.write(
      `event: ready\n` +
      `data: ${JSON.stringify({
        projectId:
          device.project_id,
        deviceId:
          device.id,
      })}\n\n`,
    );

    const clients =
      sseClients.get(
        device.project_id,
      ) || new Set();

    clients.add(reply);

    sseClients.set(
      device.project_id,
      clients,
    );

    const timer =
      setInterval(() => {
        try {
          reply.raw.write(
            ': ping\n\n',
          );
        } catch {
          clearInterval(timer);
        }
      }, 20_000);

    req.raw.on(
      'close',
      () => {
        clearInterval(timer);
        clients.delete(reply);

        if (clients.size === 0) {
          sseClients.delete(
            device.project_id,
          );
        }
      },
    );

    return reply;
  },
);

/*
 * ============================================================
 * DEVICE EVENT WEBSOCKET
 * ============================================================
 *
 * Any WebSocket Origin is accepted.
 *
 * Authentication is performed using the device token.
 */

app.get(
  '/v1/ws',
  {
    websocket: true,
  },
  (socket: any, req: any) => {
    const tokenQ =
      new URL(
        req.url || '',
        `http://${req.headers.host}`,
      )
        .searchParams
        .get('token');

    let device: any;

    const devicePromise =
      deviceByToken(
        String(tokenQ || ''),
      );

    socket.on(
      'message',
      async (raw: any) => {
        try {
          const message =
            JSON.parse(
              raw.toString(),
            );

          device =
            device ||
            (await devicePromise);

          if (!device) {
            socket.close(
              1008,
              'invalid token',
            );
            return;
          }

          if (
            message.action ===
            'publish'
          ) {
            if (!message.topic) {
              return;
            }

            broker.publish(
              {
                cmd: 'publish',
                topic: deviceTopic(
                  device.project_id,
                  device.id,
                  message.topic,
                ),
                payload:
                  Buffer.from(
                    JSON.stringify(
                      message.data ??
                        {},
                    ),
                  ),
                qos: 0,
                retain: false,
                dup: false,
              },
              () => {},
            );
          } else if (
            message.action ===
            'subscribe'
          ) {
            socket.send(
              JSON.stringify({
                type: 'info',
                message:
                  'WebSocket is project event stream; use MQTT/WebSocket topic bridge for topic subscriptions',
              }),
            );
          }
        } catch {
          socket.send(
            JSON.stringify({
              type: 'error',
              error:
                'invalid message',
            }),
          );
        }
      },
    );

    devicePromise
      .then((resolved) => {
        device = resolved;

        if (!device) {
          socket.close(
            1008,
            'invalid token',
          );
          return;
        }

        const clients =
          wsClients.get(
            device.project_id,
          ) || new Set();

        clients.add(socket);

        wsClients.set(
          device.project_id,
          clients,
        );

        socket.send(
          JSON.stringify({
            type: 'ready',
            projectId:
              device.project_id,
            deviceId:
              device.id,
          }),
        );

        socket.on(
          'close',
          () => {
            clients.delete(
              socket,
            );

            if (
              clients.size === 0
            ) {
              wsClients.delete(
                device.project_id,
              );
            }
          },
        );
      })
      .catch(() => {
        socket.close(
          1011,
          'server error',
        );
      });
  },
);

/*
 * ============================================================
 * MQTT OVER WEBSOCKET
 * ============================================================
 *
 * Any WebSocket Origin is accepted.
 *
 * MQTT authentication is performed by Aedes using
 * the device token.
 */

app.get(
  '/mqtt',
  {
    websocket: true,
  },
  (socket: any, req: any) => {
    const stream =
      createWebSocketStream(
        socket,
        {},
      );

    broker.handle(
      stream,
      req.raw,
    );
  },
);

/*
 * ============================================================
 * STARTUP
 * ============================================================
 */

await migrate();

/*
 * MQTT TCP
 */

const mqttTcpPort =
  Number(
    process.env.MQTT_TCP_PORT || 0,
  );

if (mqttTcpPort) {
  createTcpServer(
    broker.handle,
  ).listen(
    mqttTcpPort,
    '0.0.0.0',
    () => {
      app.log.info(
        `MQTT TCP listening on ${mqttTcpPort}`,
      );
    },
  );
}

/*
 * HTTP SERVER
 */

const port =
  Number(
    process.env.PORT || 10000,
  );

await app.listen({
  port,
  host: '0.0.0.0',
});

app.log.info(
  `IoTCloud listening on ${port}`,
);
