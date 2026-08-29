# IoTCloud 1.0.0

- Replaced the broker dependency with Aedes, MIT licensed.
- Added MQTT authentication and per-device topic ACLs.
- Added MQTT over WebSocket for Render-compatible deployments.
- Added application WebSocket and SSE event streams.
- Added PostgreSQL persistence for projects, devices, telemetry, workflows, credentials and workflow runs.
- Added AES-256-GCM credential encryption.
- Added workflow branching and triggers for MQTT, webhook, device state and schedules.
- Added Telegram, Discord, SMTP and HTTP webhook actions.
- Added connector test endpoint.
- Added project/device dashboard and workflow canvas.
- Added developer examples and API documentation.
- Added local Docker Compose and Render Blueprint.
- Added automated unit tests for encryption, ACLs and workflow branching.
