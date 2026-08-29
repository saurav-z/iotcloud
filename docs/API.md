# IoTCloud API

All authenticated endpoints use:

`Authorization: Bearer <USER_JWT>` for browser/project administration.

Device realtime endpoints use the device token.

## Realtime

- `GET /v1/ws?token=DEVICE_TOKEN` — authenticated project event stream and publish command channel.
- `GET /v1/events?token=DEVICE_TOKEN` — SSE stream.
- `GET /mqtt` — MQTT over WebSocket broker endpoint.

## REST

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/projects`
- `POST /api/projects`
- `GET /api/projects/:id/devices`
- `POST /api/projects/:id/devices`
- `DELETE /api/projects/:id/devices/:deviceId`
- `GET /api/projects/:id/telemetry`
- `POST /api/device/publish`
- `GET/POST/PUT/DELETE /api/projects/:id/workflows...`
- `GET/POST /api/projects/:id/credentials`
- `POST /api/projects/:id/credentials/:credentialId/test`
- `GET /api/projects/:id/runs`
- `GET /api/docs`

## Event format

```json
{
  "id":"uuid",
  "type":"mqtt.message",
  "projectId":"uuid",
  "deviceId":"uuid",
  "topic":"telemetry",
  "data":{"temperature":28.4},
  "timestamp":"2026-08-29T00:00:00.000Z"
}
```

## Public webhook

When a workflow contains a `webhook.trigger`, its generated `webhookSecret` is stored with the workflow definition. Send:

```bash
curl -X POST https://YOUR_HOST/v1/webhooks/WORKFLOW_ID \
  -H 'x-webhook-secret: WEBHOOK_SECRET' \
  -H 'content-type: application/json' \
  -d '{"temperature":35}'
```
