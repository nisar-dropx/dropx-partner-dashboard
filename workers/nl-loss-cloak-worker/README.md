# nl-loss-cloak-worker

Cloudflare Worker that feeds the Ops Pulse **Team Ops → Losses** page (sub-pages `/attendance/losses/nl`, `/slp-initial`, `/slp-final`).

| Report | Source | Session |
| --- | --- | --- |
| NL loss | `POST cloak.tech.amazon.dev/api/v1/bulkDownload` → presigned CSV | `cloak_sessions` (own table, same shape as `workforce_sessions`) |
| SLP Initial / Final | `logistics.amazon.in/performance/api/v1/getData?dataSetId=dsp_station_weekly_supp_reports` → "EDSP SLP Initial/Final Recovery File-…" zip | **shared** `workforce_sessions` / `workforce_login_state`, account `default` — same row as Report-auto-worker and cash-recon |

Everything lives in the DropX Dashboard (company) Supabase project (`SUPABASE_URL`): the shared workforce session, the Cloak session, and the results in `loss_report_runs`, `loss_report_rows`, `loss_report_station_totals`. The dashboard reads the latest `completed` run and filters rows to the stations in the user's location scope.

## Cloak session lifecycle
1. Stored cookie reused while the Cognito access token has more than 5 minutes left.
2. Otherwise renewed via Cognito `REFRESH_TOKEN_AUTH` (no browser) and stored as a new active row.
3. Otherwise Puppeteer logs in with `CLOAK_EMAIL` / `CLOAK_PASSWORD` under a login lock (`cloak_login_state`).
4. **Cache error** (on the page or in an API response): clears the HTTP cache, cookies, and all origin storage, reloads, and logs in again (max 2 resets).
5. If Cloak asks for an OTP, upload cookies manually. Step 2 then keeps them alive for as long as the refresh token stays valid:
   `PUT /api/admin/cloak/session` with `{ "cookie": "<cookie header from DevTools>" }`.

## SLP file discovery
Walks back from the current ISO week (`SLP_LOOKBACK_WEEKS`, default 12) through the catalog of `SLP_CATALOG_STATIONS` (default `KOZA`) and takes the newest Initial and newest Final file. A file already ingested (same name + creation date) is skipped. If you list several stations, identical copies are counted once. Rows in a file with no station column are attributed to the station whose catalog they came from.

## Column detection
Station / amount / reference columns are detected from header names (see `src/services/lossTable.ts`). The chosen columns are saved on each run (`station_column`, `amount_column`, `reference_column`). Check them after the first run, and pin the candidates if a file uses different headers.

## Setup
```bash
npm install
# 1. SQL (DropX Dashboard project): dashboard migrations 20260929120000_nl_slp_loss_reports.sql
#    and 20260929140000_cloak_sessions.sql (copies in sql/)
# 2. Secrets (SUPABASE_URL is a plain var in wrangler.toml)
wrangler secret put SUPABASE_SERVICE_ROLE_KEY          # DropX Dashboard (company) key
wrangler secret put ADMIN_API_KEY
wrangler secret put CLOAK_PASSWORD
wrangler secret put WORKFORCE_PORTAL_EMAIL      # same as Report-auto-worker
wrangler secret put WORKFORCE_PORTAL_PASSWORD   # same as Report-auto-worker
wrangler secret put AMAZON_EXCEL_OPEN_PASSWORD  # same as Report-auto-worker
npm run deploy
```

## Admin API (`x-admin-key: $ADMIN_API_KEY`)
- `GET  /api/admin/status`: both sessions (no cookie values) + the latest run per report
- `PUT  /api/admin/cloak/session`: upload Cloak cookies
- `POST /api/admin/cloak/session/ensure[?force=1]`: validate / refresh / re-login
- `POST /api/admin/nl-loss/run`: pull NL loss now
- `POST /api/admin/slp-loss/run`: pull SLP Initial + Final now

Crons: NL hourly at :20, SLP at 07:00 and 13:00 IST.
