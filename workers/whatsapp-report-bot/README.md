# WhatsApp Report Bot worker

The always-on half of **Ops Pulse → Report Bot** (Dark Store). It keeps one WhatsApp account linked as a
*linked device*, forwards report images from the groups enabled in the portal, and sends the reminders and
feedback the portal queues. All rules, schedules, AI settings and templates live in the portal; this worker
holds no business logic.

Do not deploy it to Vercel: it needs a long-lived connection and a persistent disk for the WhatsApp session.

## How it fits

```
WhatsApp groups ⇄ worker (this) ──events──▶ ops portal /api/report-bot/worker/events
                         ▲  ◀──config──── /api/report-bot/worker/config (every minute)
                         └── /send, /media, /groups, /session ◀── portal cron + Report Bot page
```

- Only groups enabled in the portal are read. Private chats are never read or forwarded.
- Only images (photos, or image files sent as documents) are forwarded. Text, voice and video are ignored.
- The worker only sends to enabled groups, and only while the portal is in **Live** mode.
- Images are kept for `MEDIA_TTL_HOURS` (48 h) so the portal can fetch them, then deleted.

## Deploy (Docker host with a domain)

1. Point a DNS name (for example `wa-bot.dropxlogistics.com`) at the server.
2. In the portal: Report Bot → Connection → **Create token**. Copy it (shown once).
3. On the server, copy `.env.example` to `.env` and fill `PORTAL_URL`, `WORKER_TOKEN`, `WORKER_DOMAIN`.
4. `docker compose up -d --build`. Caddy obtains the HTTPS certificate automatically.
5. In the portal: save the worker address `https://wa-bot.dropxlogistics.com`, then **Link with QR code** and
   scan it from WhatsApp → Settings → Linked devices → Link a device.

## Test locally with your own WhatsApp

```bash
cd workers/whatsapp-report-bot
npm ci
PORTAL_URL=https://ops.dropxlogistics.com WORKER_TOKEN=<token> node server.mjs
# in another terminal, expose it over HTTPS, e.g.
cloudflared tunnel --url http://localhost:8090
```

Save the tunnel's https address as the worker address in the portal, link your number, enable one test
group, and keep the portal in **Listen only** until the readings look right. Turn on
"Analyse my own messages" in Settings if you want to test by posting images yourself.

## Switching numbers

Portal → Connection → **Unlink / switch number**, then link the new number. The new number must be a member of
the enabled groups (and an admin in groups where only admins can post). Groups, schedules and history are kept.

## Endpoints (all except /health need `Authorization: Bearer <WORKER_TOKEN>`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness and connection state |
| GET | `/session` | State, QR string or pairing code, linked account |
| POST | `/session/connect` | `{ "method": "qr" }` or `{ "method": "code", "phone": "9198…" }` |
| POST | `/session/logout` | Unlink and delete the saved session |
| GET | `/groups` | Groups the linked number belongs to |
| POST | `/config` | Enabled groups and mode (also pulled every minute) |
| POST | `/send` | `{ client_ref, to, text, quoted }`; a repeated `client_ref` returns the first result instead of posting twice |
| GET | `/media/:ref` | Downloaded image bytes |

## Operating notes

- Run exactly **one** worker per WhatsApp number. A second one makes WhatsApp close the first (shown as
  "opened by another worker").
- The WhatsApp session is in the `report_bot_data` volume. Back it up or expect to re-link after losing it.
- The phone that owns the number must come online at least every ~14 days or WhatsApp unlinks linked devices.
- This uses WhatsApp Web's protocol through the open-source Baileys library, which WhatsApp does not officially
  support. Keep volume low (the portal enforces delays and per-group gaps) and use a dedicated number in
  production.
