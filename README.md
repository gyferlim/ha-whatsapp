# WhatsApp Bridge — Docker Standalone

A Docker-native port of [FaserF/hassio-addons/whatsapp](https://github.com/FaserF/hassio-addons/tree/master/whatsapp).  
Runs the same Baileys Node.js engine **without needing Home Assistant**.

---

## Quick Start

```bash
# 1. Clone / copy this repo
git clone https://github.com/gyferlim/ha-whatsapp
#then:
cd whatsapp-docker

# 2. Edit docker-compose.yml — at minimum set your AUTH_TOKEN
#    Then build & start:
docker compose up -d --build

# 3. Scan the QR code (shown in logs)
docker compose logs -f

# 4. Once connected, the API is at http://localhost:8066
```

---

## Pairing (First Run)

1. `docker compose logs -f` — watch for the QR code printed in terminal.
2. Open WhatsApp → Linked Devices → Link a device → scan.
3. Logs will show `WhatsApp connected ✓`.

Or poll the API:

```bash
curl http://localhost:8066/qr \
  -H "X-Auth-Token: change_me_strong_token"
# Returns { "status": "scanning", "qr": "data:image/png;base64,..." }
# Open the base64 image in a browser to scan it
```

---

## Environment Variables

| Variable              | Default       | Description                                  |
|-----------------------|---------------|----------------------------------------------|
| `AUTH_TOKEN`          | *(empty)*     | Required for all API calls (`X-Auth-Token`)  |
| `PORT`                | `8066`        | API listen port                              |
| `WEBHOOK_ENABLED`     | `false`       | Forward incoming messages to a URL           |
| `WEBHOOK_URL`         | *(empty)*     | Your HTTP endpoint                           |
| `WEBHOOK_TOKEN`       | *(empty)*     | Sent as `X-Webhook-Token` header             |
| `LOG_LEVEL`           | `info`        | pino level: trace/debug/info/warn/error      |
| `MARK_ONLINE`         | `false`       | Show WhatsApp status as online               |
| `KEEP_ALIVE_INTERVAL` | `30000`       | Heartbeat ms                                 |
| `RESET_SESSION`       | `false`       | Set `true` once to wipe session & re-pair    |
| `SESSION_DIR`         | `/data/session` | Where auth files are stored (in volume)    |

---

## REST API

All endpoints (except `/health`) require header: `X-Auth-Token: <your token>`

### Status

| Method | Path      | Description                          |
|--------|-----------|--------------------------------------|
| GET    | `/health` | Healthcheck (no token needed)        |
| GET    | `/status` | Connection status + version          |
| GET    | `/stats`  | Messages sent/received/errors        |
| GET    | `/qr`     | QR code as base64 PNG                |
| GET    | `/groups` | List all participating groups        |

### Sending

| Method | Path              | Required body fields              |
|--------|-------------------|-----------------------------------|
| POST   | `/send_message`   | `number`, `message`               |
| POST   | `/send_image`     | `number`, `url`, `caption?`       |
| POST   | `/send_video`     | `number`, `url`, `caption?`       |
| POST   | `/send_audio`     | `number`, `url`, `ptt?`           |
| POST   | `/send_document`  | `number`, `url`, `fileName?`      |
| POST   | `/send_location`  | `number`, `latitude`, `longitude` |
| POST   | `/send_poll`      | `number`, `question`, `options[]` |

**Number format:** `60182550855@s.whatsapp.net` (personal) or `12345@g.us` (group)

### Message management

| Method | Path              | Required body fields                       |
|--------|-------------------|--------------------------------------------|
| POST   | `/send_reaction`  | `number`, `messageId`, `reaction` (emoji)  |
| POST   | `/revoke_message` | `number`, `message_id`                     |
| POST   | `/mark_as_read`   | `number`, `messageId?`                     |
| POST   | `/set_presence`   | `presence` (composing/recording/available) |

### Runtime webhook config

```
POST /settings/webhook
{ "url": "http://...", "enabled": true, "token": "secret" }
```

---

## Example: Send a Message

```bash
curl -X POST http://localhost:8066/send_message \
  -H "Content-Type: application/json" \
  -H "X-Auth-Token: change_me_strong_token" \
  -d '{"number":"60182550855@s.whatsapp.net","message":"Hello from Docker!"}'
```

---

## Incoming Webhook Payload

When `WEBHOOK_ENABLED=true`, every incoming message POSTs to your URL:

```json
{
  "sender": "60182550855@s.whatsapp.net",
  "content": "Hello!",
  "is_group": false,
  "raw": { "...": "full Baileys message object" }
}
```

---

## n8n Integration

Set `WEBHOOK_URL` to your n8n webhook trigger URL.  
Use the `X-Webhook-Token` header check in your n8n workflow for security.

To send messages from n8n use the **HTTP Request** node:
- URL: `http://whatsapp-bridge:8066/send_message`
- Method: POST
- Headers: `X-Auth-Token`, `Content-Type: application/json`
- Body: `{ "number": "...", "message": "..." }`

---

## Session Persistence

The WhatsApp session lives in the `whatsapp_session` Docker volume (`/data/session`).  
As long as the volume exists, you won't need to re-scan the QR code.

To reset (force re-pair): set `RESET_SESSION=true`, restart, then set it back to `false`.

---

## Legal

> WhatsApp automation may violate their Terms of Service.  
> This project is not affiliated with WhatsApp Inc.  
> Use at your own risk.
