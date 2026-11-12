# Amazon SCC Playwright Worker

This worker is the live browser automation layer for DropX Ops Pulse COD checks.

It is intentionally separate from the Vercel dashboard and separate from biometric attendance. The dashboard stores settings and COD data. This worker opens Amazon SCC with Playwright, reads Driver Reconciliation / Bank Deposit pages, and sends structured results back to the dashboard.

## What This Solves

- The station team should not manually type every associate name.
- Ops Pulse > COD > Executive Reconciliation can fetch the SCC Driver Reconciliation roster for the selected station/date.
- Amazon SCC can ask for MFA, captcha, or manual approval. This worker supports a persistent interactive browser session so the owner can approve Amazon once and reuse the saved session.
- Biometric attendance remains untouched. This worker does not call `bio.dropxlogistics.com` and does not change attendance punch ingestion.

## Service Endpoints

- `GET /` opens the worker status page.
- `GET /health` confirms the worker is alive and shows configuration state.
- `GET /vnc.html` opens the worker browser when `ENABLE_VNC=true`.
- `POST /warmup` opens SCC and saves the browser session.
- `POST /run` performs one SCC check.
- `POST /station-summary` rotates through configured stores on Amazon Site Summary, detects **red metric values**, and returns PNG screenshots only for stations that need attention.

Example payload:

```json
{"stations":["TCD4_SS","STORE_2","STORE_3","STORE_4","STORE_5"],"url":"https://eu.store-management.f3.amazon.dev/siteSummary"}
```

The endpoint reuses the worker's saved Amazon session (or attaches to Chrome over CDP). It does not copy cookies from a normal laptop Chrome profile unless you start Chrome with `--remote-debugging-port` and set `AMAZON_CDP_URL`.

The dashboard calls this worker using `OPS_PORTAL_WORKER_URL` and `OPS_PORTAL_WORKER_SECRET`.

## Site Summary red-alert monitor (local / shareable)

Use this when Dark Store Ops needs WhatsApp screenshots whenever Site Summary shows red numbers across the five stores.

### Access paths

Amazon Site Summary is often only reachable inside Amazon WorkSpaces. You can connect WorkSpaces from the browser here:

[https://ap-southeast-1.webclient.amazonworkspaces.com/wsp.html](https://ap-southeast-1.webclient.amazonworkspaces.com/wsp.html)

Important: WorkSpaces Web Access is a **remote desktop stream** (canvas). The outer browser cannot read Site Summary’s DOM. Choose a capture mode:

| Mode | When to use | How red alerts are detected |
| --- | --- | --- |
| `workspace-stream` | You open WorkSpaces in Chrome/Edge on this laptop | Screenshot the WorkSpaces canvas, count red pixels, Gemini Vision reads the metrics |
| `dom` | Site Summary is reachable directly, or the worker runs **inside** the WorkSpace | Read computed CSS colors from metric elements (most accurate) |
| `auto` | Default helper | Uses `workspace-stream` when `AMAZON_WORKSPACES_URL` is set, otherwise `dom` |

### What it does

1. Opens/attaches a browser session for Site Summary **or** WorkSpaces Web Access.
2. Switches station from the top menu for each code in `AMAZON_STATIONS` (DOM mode is reliable; stream mode uses best-effort canvas clicks).
3. Detects red conditions (CSS color in DOM mode, red pixels in stream mode).
4. Takes a screenshot only when a red condition appears.
5. Uses Gemini to write a short caption and one break-up question (Vision is used for WorkSpaces stream screenshots).
6. Sends the image to the Dark Store Ops WhatsApp group through the existing report-bot `/send` API.
7. Repeats every `AMAZON_CHECK_INTERVAL_MINUTES` (default `1`). Duplicate metric signatures are suppressed.

### Develop on this device (WorkSpaces browser path)

```powershell
cd workers/amazon-scc-playwright
copy .env.station-summary.example .env.station-summary
# set AMAZON_CAPTURE_MODE=workspace-stream
# set AMAZON_WORKSPACES_URL=https://ap-southeast-1.webclient.amazonworkspaces.com/wsp.html
# fill WhatsApp + Gemini secrets
npm install
npx playwright install chromium
$env:HEADLESS="false"
npm start
```

In a second terminal:

```powershell
node scripts/run-amazon-station-summary.mjs
```

Or:

```powershell
.\workers\amazon-scc-playwright\start-station-summary-monitor.ps1
```

First run: complete WorkSpaces Web Access login in the opened browser and leave Site Summary visible on the remote desktop. The monitor then watches that stream every minute.

Recommended CDP flow (keeps your normal login window):

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:TEMP\dropx-scc-chrome"
# open https://ap-southeast-1.webclient.amazonworkspaces.com/wsp.html and login
# in .env.station-summary set AMAZON_CDP_URL=http://127.0.0.1:9222
```

### Host-side monitor when you cannot copy into WorkSpaces

Full guide: [`docs/workspaces-site-summary-monitor.md`](../../docs/workspaces-site-summary-monitor.md)

If file copy into WorkSpaces is blocked, run this on the **laptop** while WorkSpaces stays open with Site Summary in Firefox:

```powershell
# Keep Amazon WorkSpaces desktop app open, Site Summary visible in Firefox inside it
pnpm monitor:workspaces-site-summary
# or: node scripts\run-workspaces-desktop-monitor.mjs
```

This captures the WorkSpaces window from the laptop (even when another app is in front), checks for red pixels, uses Gemini Vision for wording, and posts a PNG to Dark Store Ops WhatsApp via the report-bot `/send` API. Failed/missing WhatsApp config queues images under `.station-summary-state/whatsapp-outbox/`.

### Run inside Amazon WorkSpaces (desktop app) + Firefox only

Only use this path if IT allows copying Node into the WorkSpace. Otherwise use the host-side monitor above.

**Host PC:** only Amazon WorkSpaces desktop app.

**Inside WorkSpaces (after login):**
1. Install [Node.js 20 LTS](https://nodejs.org/) if IT allows
2. Copy into the WorkSpace:
   - `workers/amazon-scc-playwright/`
   - `scripts/run-amazon-station-summary.mjs`
3. Keep `.env.station-summary` with:
   - `AMAZON_CAPTURE_MODE=dom`
   - `AMAZON_STATION_SUMMARY_BROWSER=firefox`
   - station codes + WhatsApp + Gemini keys
4. In PowerShell **inside WorkSpaces**:
   ```powershell
   cd workers\amazon-scc-playwright
   .\start-inside-workspaces.ps1
   ```
   Or manually:
   ```powershell
   npm install
   npx playwright install firefox
   $env:HEADLESS="false"
   npm start
   ```
   then in another WorkSpaces PowerShell:
   ```powershell
   node ..\..\scripts\run-amazon-station-summary.mjs
   ```
5. First time: complete Amazon login in the **Firefox** window that opens on the WorkSpaces desktop. After that it rotates the 5 stations and alerts on red.

WhatsApp delivery uses the existing report-bot worker. No WhatsApp install is needed on the PC.

## Required Deployment Shape

Do not deploy this worker to Vercel. Vercel is not suitable for long-running Playwright browser sessions or saved Amazon login cookies.

Deploy this worker on a persistent Docker host such as:

- AWS EC2 / Lightsail
- Render private service with persistent disk
- Fly.io machine with persistent volume
- Any Ubuntu server with Docker and HTTPS reverse proxy

Recommended domain:

```text
scc.dropxlogistics.com
```

Keep this separate from:

```text
bio.dropxlogistics.com
```

`bio.dropxlogistics.com` is only for biometric device punch middleware.

## Worker Environment

Copy `.env.example` to `.env` on the worker host:

```bash
OPS_PORTAL_WORKER_SECRET=change-this-long-random-secret
VNC_PASSWORD=change-this-vnc-password
SLOW_MO_MS=0
WORKER_TIMEOUT_MS=240000
MANUAL_APPROVAL_WAIT_MS=300000
SCREEN_WIDTH=1440
SCREEN_HEIGHT=1000
```

The Docker compose file already sets:

```bash
HEADLESS=false
ENABLE_VNC=true
SESSION_STATE_DIR=/var/lib/dropx-scc-worker/sessions
DEBUG_ARTIFACT_DIR=/var/lib/dropx-scc-worker/artifacts
```

`SESSION_STATE_DIR` is mounted as a Docker volume. Do not remove it unless you want Amazon SCC to ask for login again.

## Start The Worker

From this folder:

```bash
docker compose up -d --build
```

Open:

```text
https://scc.dropxlogistics.com/
```

Then open:

```text
https://scc.dropxlogistics.com/vnc.html
```

Enter the VNC password from `.env`, then approve Amazon SCC login/MFA inside that browser.

## Connect The Dashboard

Set these in the Vercel dashboard project:

```bash
OPS_PORTAL_WORKER_URL=https://scc.dropxlogistics.com/run
OPS_PORTAL_WORKER_SECRET=the-same-secret-as-the-worker
CRON_SECRET=your-existing-cron-secret
```

Then in the dashboard:

1. Open Settings > Amazon Connector.
2. Save Amazon SCC credentials.
3. Click `Login worker once`.
4. If Amazon asks for MFA or manual verification, open the worker noVNC browser and approve it.
5. Open Ops Pulse > COD > Executive Reconciliation.
6. Select date and station.
7. Click `Sync SCC now`.

If Amazon accepts the saved session, associate rows should be imported automatically from SCC Driver Reconciliation.

## Can The Owner Login In The Worker?

Yes. That is the correct stable flow.

The owner cannot reuse normal laptop Chrome login directly because Playwright runs in its own browser on the worker host. Instead:

- Open the worker browser through noVNC.
- Login to Amazon SCC once.
- Approve MFA/captcha/manual prompt if Amazon asks.
- The worker saves session cookies in `SESSION_STATE_DIR`.
- Scheduled checks reuse that worker session.

If Amazon expires the session later, repeat the same noVNC login once.

## Does This Affect Biometric Attendance?

No.

Biometric attendance and SCC automation are separated:

- Biometric device punches go to `bio.dropxlogistics.com`.
- SCC automation goes to `scc.dropxlogistics.com`.
- SCC worker reads Amazon SCC and writes Ops Pulse/COD tables only.
- It does not touch attendance punch APIs, attendance reports, device master ingestion, or payroll attendance calculations.

## Expected Run Request

```json
{
  "run_id": "...",
  "company_id": "...",
  "station_code": "JDBD",
  "portal_station_code": "JDBD",
  "check_date": "2026-07-18",
  "check_type": "driver_reconciliation",
  "login_url": "https://www.amazonlogistics.eu/station/dashboard/workitemsvisibility",
  "username": "amazon-login",
  "password": "amazon-password",
  "mfa_secret": null,
  "urls": {
    "driver_reconciliation": "https://www.amazonlogistics.eu/station/dashboard/driverreconciliation",
    "bank_deposits": "https://www.amazonlogistics.eu/station/dashboard/bankdeposits"
  }
}
```

`mfa_secret` is the authenticator setup key or full `otpauth://` URL, not the current 6-digit OTP. If Amazon shows push approval, captcha, or another manual verification screen, it cannot be bypassed; approve it once in the worker browser.

## What It Checks

For `driver_reconciliation`:

- Logs in to Amazon SCC.
- Opens Driver Reconciliation.
- Applies station and business date where the page exposes controls.
- Reads associate rows, expected amount, pending amount, pending details, and page status.
- Returns structured associate rows to Ops Pulse COD.

For `prepared_deposit`:

- Opens Bank Deposits.
- Clicks prepared deposit related action where available.
- Returns Pass when no liability/pending amount is visible.
- Returns Fail when pending liability or amount is visible.

## Local Test

```bash
npm install
npm start
```

In another terminal:

```bash
curl -X POST http://localhost:8080/run \
  -H "Authorization: Bearer $OPS_PORTAL_WORKER_SECRET" \
  -H "Content-Type: application/json" \
  -d @sample-request.json
```

## Operational Notes

- Keep the worker URL private where possible.
- Always use HTTPS in production.
- Rotate `OPS_PORTAL_WORKER_SECRET` if it is shared accidentally.
- If SCC layout changes, the extraction logic in `server.mjs` may need an update.
- Save debug artifacts only on secured storage because screenshots may show Amazon operational data.
