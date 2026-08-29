# IoTCloud

A self-hostable, multi-tenant IoT realtime and automation platform for classrooms, prototypes and production integrations.

## What is included

- Multi-user authentication with bcrypt + JWT
- Projects and per-device credentials
- MQTT broker using **Aedes (MIT)**
- MQTT authentication and project/device topic ACLs
- MQTT over WebSocket at `/mqtt` for Render-style HTTP/WebSocket hosting
- Application WebSocket event stream at `/v1/ws`
- Server-Sent Events at `/v1/events`
- REST API for devices, telemetry and workflows
- PostgreSQL persistence
- AES-256-GCM encrypted connector credentials
- Workflow canvas using React Flow
- Workflow triggers, conditions, MQTT actions and connector actions
- Telegram, Discord, SMTP email and generic HTTP webhook connectors
- Workflow execution history
- Device online/offline events
- Developer center with copy/paste examples
- ESP32, Arduino, Python and JavaScript starter examples
- Docker Compose local environment
- Render Blueprint

## Architecture

```text
ESP32 / Arduino
     | MQTT/TLS or MQTT/WSS
     v
Aedes MQTT broker -----> Event bus -----> WebSocket / SSE
     |                         |
     |                         +-----> Workflow engine
     |                                  |   |   |   |
     |                                  v   v   v   v
     |                               MQTT Email Telegram Discord
     |
     +---- PostgreSQL telemetry / devices / workflows

Browser / Python / Node.js
       | REST / WebSocket / SSE
       v
Fastify API
```

Aedes supports MQTT 3.1/3.1.1, WebSockets, TLS, authentication/authorization and dynamic topics. The implementation follows its documented WebSocket stream pattern.

## Local run

Requirements: Node 22+ and Docker.

```bash
docker compose up --build
```

API: http://localhost:10000/health
Web: http://localhost:5173
MQTT over WebSocket: ws://localhost:10000/mqtt
Application WebSocket: ws://localhost:10000/v1/ws?token=DEVICE_TOKEN
SSE: http://localhost:10000/v1/events?token=DEVICE_TOKEN

Register a user, create a project and create a device in the dashboard. The device token is both the MQTT username and the credential for the REST/WS/SSE device APIs.

## MQTT topic rules

```text
iotcloud/{projectId}/{deviceId}/{topic}
```

A device can publish and subscribe only inside its own project/device namespace. The broker rejects cross-project and cross-device topic access.

For a device:

```text
username = DEVICE_TOKEN
password = any value
clientId = any unique client id
```

Use MQTT over WebSocket on hosted platforms where raw TCP ports are unavailable:

```text
wss://YOUR_HOST/mqtt
```

## Workflow actions

Supported action types:

- Telegram
- Discord
- SMTP email
- HTTP webhook
- MQTT publish

Connector secrets are encrypted with AES-256-GCM. Set a stable `CREDENTIAL_ENCRYPTION_KEY` in production; changing it makes existing stored credentials unreadable.

## Render

Use `render.yaml` as a starting Blueprint. The API is a Docker web service and the frontend is a static site. The MQTT broker is exposed through WebSocket on the same HTTP service, which is appropriate for Render-style hosting. For high availability, use an external Redis-backed Aedes persistence/mqemitter layer and a managed PostgreSQL instance.

## Security before a public classroom deployment

1. Set strong `JWT_SECRET` and `CREDENTIAL_ENCRYPTION_KEY`.
2. Use HTTPS/WSS on the deployed hostname.
3. Use a managed PostgreSQL database with backups.
4. Put Redis in front of multiple API instances for shared realtime fan-out and workflow queues.
5. Add email verification/password reset and classroom roles before exposing accounts to minors.
6. Set connector-specific quotas and project message limits.
7. Rotate/revoke device credentials when a device is lost.

## Testing

```bash
npm install
npm test
npm run build
```

The API tests cover credential encryption, topic isolation and workflow branching. The web build is included as the frontend smoke test.


## Render / CORS
The frontend always normalizes the API endpoint to HTTPS and WebSockets to WSS. The API enables public cross-origin requests for token-based clients. If a browser still reports CORS, check that `VITE_API_URL` and any saved `iotcloud_api_url` value are HTTPS (never HTTP).
