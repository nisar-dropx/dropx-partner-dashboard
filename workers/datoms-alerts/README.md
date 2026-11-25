# DropX Datoms L2/L3 alerts (Cloudflare Worker)

Polls Datoms IoT events every minute, filters DropX dark-store **L2/L3** cold-chain violations, dedupes in KV, upserts `ds_datoms_alerts` in Supabase, and posts a PNG + caption to each station war room via the Report Bot worker.

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
wrangler secret put DATOMS_PASSWORD
wrangler secret put REPORT_BOT_URL
wrangler secret put REPORT_BOT_TOKEN
wrangler secret put ADMIN_KEY
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

Optional vars in `[vars]` or secrets: `DATOMS_CUSTOMER_ID` (default `17428`), `DATOMS_APPLICATION_ID` (default `16`), `COMPANY_ID`.

## Deploy

```bash
npm run deploy
```

## HTTP

| Method | Path | Auth |
|--------|------|------|
| GET | `/health` | — |
| GET | `/alerts?limit=50` | — |
| POST | `/run` | `Authorization: Bearer $ADMIN_KEY` or `x-admin-key` |

`POST /run?dry_run=1` filters events without KV, Supabase, or WhatsApp side effects.

## Tests

```bash
npm test
```