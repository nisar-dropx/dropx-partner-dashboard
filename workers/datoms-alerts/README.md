# DropX Datoms L2/L3 alerts (Cloudflare Worker)

Polls Datoms IoT events every **5 minutes**, filters DropX dark-store **L2/L3** cold-chain violations, dedupes in KV, upserts `ds_datoms_alerts` in Supabase, and posts a PNG + caption to each station war room via the Report Bot worker.

Auth token + DPoP keypair are **stored in KV** (`datoms:session:v1`) so cron ticks reuse the session instead of logging in every run. A 429 / “too many requests” response sets a **20-minute login backoff** in KV so the worker stops hammering Datoms (which also locks out browser OTP/password login).

## Setup

```bash
cd workers/datoms-alerts
npm install
```

Copy `.env.example` locally for `wrangler dev` (or use dashboard secrets in production).

Create a KV namespace and replace `REPLACE_ME` in `wrangler.toml`.

## Secrets (production)

```bash
wrangler secret put DATOMS_EMAIL
wrangler secret put DATOMS_PASSWORD   # plaintext account password (API login). Not a hash.
wrangler secret put REPORT_BOT_URL
wrangler secret put REPORT_BOT_TOKEN
wrangler secret put ADMIN_KEY
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

`DATOMS_PASSWORD_HASH` is accepted only as an alias for the same plaintext secret name some setups used by mistake — Datoms still expects the real password on `/accounts/login`.

After a password change or rate-limit lockout: `POST /session/reset` with `ADMIN_KEY` clears KV session + backoff, then wait for Datoms to unblock before the next login.

Optional vars in `[vars]` or secrets: `DATOMS_CUSTOMER_ID` (default `17428`), `DATOMS_APPLICATION_ID` (default `16`), `COMPANY_ID`.

## Deploy

```bash
npm run deploy
```

## HTTP

| Method | Path | Auth |
|--------|------|------|
| GET | `/health` | — (includes KV session + login-backoff status) |
| GET | `/alerts?limit=50` | — |
| POST | `/run` | `Authorization: Bearer $ADMIN_KEY` or `x-admin-key` |
| POST | `/session/reset` | Admin — clear KV session + login backoff |

`POST /run?dry_run=1` filters events without KV, Supabase, or WhatsApp side effects.

## Tests

```bash
npm test
```