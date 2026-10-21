# WhatsApp Report Bot worker

The always-on half of **Ops Pulse → Report Bot** (Dark Store). It keeps one WhatsApp account linked as a
*linked device*, forwards report photos from the groups enabled in the portal, and sends the reminders and
replies the portal queues. All rules, schedules, AI settings and templates live in the portal.

It holds nothing important on its own disk: the WhatsApp login and each photo's message record are stored in
the portal (Supabase). So it can run on any host that builds from GitHub, survive redeploys without re-linking,
and be moved without losing anything. Vercel can't host it because it needs one connection open all day.

## Where it is deployed from

Hosts deploy the private repository **DROPX-LOGISTICS/Report-bot-worker**, which holds a copy of this folder plus
a root-level `render.yaml`. This folder stays the source of truth: after changing the worker here, commit, then run
`pnpm sync:report-bot-worker` from the dashboard repository root. It tests the worker, mirrors the tracked files
into Report-bot-worker and pushes; Render redeploys automatically.

## Deploy on Render — free (recommended)

1. Sign in at render.com with GitHub and allow Render access to **DROPX-LOGISTICS → Report-bot-worker**.
2. **New → Blueprint →** `DROPX-LOGISTICS/Report-bot-worker`. Render reads its `render.yaml` and creates the
   `dropx-report-bot` web service on the free plan.
3. Paste `WORKER_TOKEN` (from Ops Pulse → Settings → Report Bot setup) when asked, then **Apply**.

Render's free plan sleeps a service after 15 minutes without incoming requests. The Ops Pulse minute cron
(`/api/cron/report-bot`) pings `/health` every minute to keep it awake; one always-on service uses about 744 of
the 750 free hours a month, so keep only this one free service in the Render workspace. Render may still restart
free services at any time and wipes their disk; the worker reconnects to WhatsApp by itself because its login is
stored in the portal. `RENDER_EXTERNAL_URL` is reported to the portal automatically.

## Deploy on Railway (about $5/month, never sleeps)

1. Sign in at railway.com with GitHub.
2. **New Project → Deploy from GitHub repo →** this repository.
3. In the service: **Settings → Source → Root Directory** = `workers/whatsapp-report-bot`.
   Railway reads `railway.json` there, builds the Dockerfile in its cloud, and only redeploys when files in
   this folder change.
4. **Variables →** add `WORKER_TOKEN` (copy it from Ops Pulse → Settings → Report Bot setup).
   `PORTAL_URL` defaults to `https://ops.dropxlogistics.com`.
5. **Settings → Networking → Generate Domain.**

That's all. The worker reports its own address to the portal, so the Worker card turns Online by itself. Then
link WhatsApp from Report Bot setup.

## Other hosts

- **Google Cloud e2-micro** (free in us-west1, us-central1, us-east1; 1 GB egress/month free): create the VM in
  the console, open SSH in the browser, install Node 22, `npm ci`, run `node server.mjs` as a systemd service, and
  set `WORKER_PUBLIC_URL` to an https address in front of it.
- **Fly.io** (about $2/month): `fly launch` from this folder; `FLY_APP_NAME` is picked up automatically.
- **Your own Docker server:** fill `.env` (download it from Report Bot setup), then `docker compose up -d --build`.
- **This computer, for a quick test:** `npm ci`, set `WORKER_TOKEN`, `node server.mjs`, and expose port 8090 with
  `cloudflared tunnel --url http://localhost:8090`; set `WORKER_PUBLIC_URL` to the tunnel address or paste it
  into the portal.

## What it reads and sends

- Only groups enabled in the portal are read. Private chats are never read or forwarded.
- Photos (or image files sent as documents) and normal text/captions are forwarded for enabled groups.
  Voice notes, video, stickers, contacts and location are ignored. Images are cached briefly in `/tmp`;
  text events carry no media bytes.
- It only sends to enabled groups, and only while the portal is in **Live** mode.
- Downloaded photos are cached in `/tmp` for `MEDIA_TTL_HOURS` (48). After that, or after a redeploy, a photo is
  downloaded from WhatsApp again using its saved record, while WhatsApp still has it.

## Environment

| Variable | Needed | Purpose |
|---|---|---|
| `WORKER_TOKEN` | Yes | From Report Bot setup. Identifies your company's bot to the portal. |
| `PORTAL_URL` | No | Defaults to `https://ops.dropxlogistics.com`. |
| `WORKER_PUBLIC_URL` | No | Only if the host doesn't publish its address (Railway, Render and Fly do). |
| `DEVICE_NAME` | No | Name shown in WhatsApp → Linked devices. |
| `MEDIA_TTL_HOURS`, `LOG_LEVEL` | No | Cache length and log detail. |

## Endpoints (all except /health need `Authorization: Bearer <WORKER_TOKEN>`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness and connection state |
| GET | `/session` | State, QR string or pairing code, linked account |
| POST | `/session/connect` | `{ "method": "qr" }` or `{ "method": "code", "phone": "9198…" }` |
| POST | `/session/logout` | Unlink and delete the saved login |
| GET | `/groups` | Groups the linked number belongs to |
| POST | `/config` | Enabled groups and mode (also pulled every minute) |
| POST | `/send` | `{ client_ref, to, text, quoted }`; a repeated `client_ref` returns the first result instead of posting twice |
| POST | `/media` | `{ ref, record }` → image bytes, from cache or downloaded from WhatsApp |

## Operating notes

- Run exactly **one** worker per WhatsApp number. A second one makes WhatsApp close the first.
- The phone that owns the number must come online at least every ~14 days or WhatsApp unlinks linked devices.
- This uses WhatsApp Web's protocol through the open-source Baileys library, which WhatsApp does not officially
  support. Keep volume low (the portal enforces delays and per-group gaps) and use a dedicated number in production.
