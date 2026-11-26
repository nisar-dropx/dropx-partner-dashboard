# DropX Datoms L2/L3 alerts (Cloudflare Worker + OpsPulse cron)

Polls Datoms IoT events every **10 minutes** from **OpsPulse Vercel (bom1 / India)** via `/api/cron/datoms-alerts`, filters DropX dark-store **L2/L3** cold-chain violations, dedupes, upserts `ds_datoms_alerts` in Supabase, and posts a PNG + caption to each station war room via the Report Bot worker.

Cloudflare Worker cron is **disabled** on purpose: CF scheduled Workers often egress from US IPs (Datoms then emails “login from United States”). Manual Worker `/run` defaults to **session-reuse only** (`allow_login=1` required to login).

## Session storage (avoid re-login / rate limits)

Auth token + DPoP keypair are stored in:

1. Process memory (hot path)
2. Cloudflare KV `datoms:session:v1` (short cache, when running on CF)
3. **Supabase `ds_datoms_session`** (durable — survives KV TTL / restarts)

As long as Datoms accepts the stored token, polls do **not** call `/accounts/login`.

**Keep-alive:** OpsPulse cron `/api/cron/datoms-session` every **5 minutes** pings Datoms with the stored token (tiny events window) and records `last_keepalive_at`. That prevents idle expiry without logging in again. Alert polling remains every 10 minutes.

Rate-limit / account-lock protections:

- **25-hour login backoff** after 429 / “too many requests” / “24-hour restriction” (matches Datoms support lock)
- **Distributed login lock** (`login_lock_until`) so parallel cron ticks cannot stampede login
- UI “Refresh from Datoms” is **session-only** (never logs in)
- Cron may login only when no durable session exists and backoff is clear
- Optional kill switch: `DATOMS_ALLOW_LOGIN=0` on OpsPulse

## Setup

```bash
cd workers/datoms-alerts
npm install
```

Apply migration `supabase/migrations/20261126113000_ds_datoms_session.sql` on the company Supabase project.

## Secrets

### Cloudflare Worker (manual `/run` / health)

```bash
wrangler secret put DATOMS_EMAIL
wrangler secret put DATOMS_PASSWORD   # plaintext account password. Not a hash.
wrangler secret put REPORT_BOT_URL
wrangler secret put REPORT_BOT_TOKEN
wrangler secret put ADMIN_KEY
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

### OpsPulse Vercel (scheduled poll — India egress)

Set on the OpsPulse project:

- `DATOMS_EMAIL` (or `DATOMS_ID`)
- `DATOMS_PASSWORD` (plaintext; `DATOMS_PASSWORD_HASH` alias accepted)
- Company Supabase URL / service role (already present)
- Report Bot URL/token come from `report_bot_settings` when available

`DATOMS_PASSWORD_HASH` is only a misnamed alias — Datoms still expects the real password on `/accounts/login`.

After a password change or rate-limit lockout: `POST /session/reset` on the Worker with `ADMIN_KEY` clears KV + Supabase session/backoff, then wait for Datoms to unblock before the next login.

## Deploy Worker (HTTP API only)

```bash
npm run deploy
```

## HTTP (Worker)

| Method | Path | Auth |
|--------|------|------|
| GET | `/health` | — (includes KV + Supabase session + login-backoff status) |
| GET | `/alerts?limit=50` | — |
| POST | `/run` | `Authorization: Bearer $ADMIN_KEY` or `x-admin-key` |
| POST | `/session/reset` | Admin — clear KV + Supabase session + login backoff |

`POST /run?dry_run=1` filters events without WhatsApp side effects.

## Tests

```bash
npm test
```
