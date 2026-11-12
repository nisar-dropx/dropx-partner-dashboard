# WorkSpaces Site Summary red-alert monitor

Sends a WhatsApp **image** to Dark Store Ops when Site Summary shows red, using the Amazon WorkSpaces desktop app window on the laptop.

## Why host-side?

WorkSpaces often blocks copying files into the remote desktop. This monitor runs on the laptop and captures the WorkSpaces window (even when another app is in front). Keep Site Summary open in **Firefox inside WorkSpaces**.

## Your laptop (already set up in this repo)

1. Open Amazon WorkSpaces and log in.
2. Inside WorkSpaces, open Firefox → Site Summary.
3. Leave WorkSpaces **open** (not minimized). Site Summary should stay visible.
4. Fill WhatsApp values in `workers/amazon-scc-playwright/.env.station-summary`:
   - `WHATSAPP_WORKER_URL`
   - `WHATSAPP_WORKER_TOKEN`
   - `DARK_STORE_OPS_GROUP_JID`
5. Run:

```powershell
node scripts\run-workspaces-desktop-monitor.mjs
```

When red appears, the script:
- captures the WorkSpaces window
- writes a Gemini caption + break-up question
- posts the PNG to the report-bot `/send` API
- if WhatsApp env is missing/fails, queues the image in `.station-summary-state/whatsapp-outbox/` and retries later

### Where to get WhatsApp values

1. Ops Pulse → Report Bot (Dark Store workspace) → Setup  
   - Worker URL → `WHATSAPP_WORKER_URL`  
   - Worker token → `WHATSAPP_WORKER_TOKEN`
2. Report Bot → Groups  
   - Enable **Dark Store Ops**  
   - Copy its WhatsApp group id (`…@g.us`) → `DARK_STORE_OPS_GROUP_JID`
3. Bot must be **Live** and the group must be enabled for `/send` to accept the image.

## Friend’s laptop checklist

Share a zip of:

- `scripts/capture-workspaces-window.ps1`
- `scripts/run-workspaces-desktop-monitor.mjs`
- `workers/amazon-scc-playwright/package.json`
- `workers/amazon-scc-playwright/.env.station-summary.example` (he renames to `.env.station-summary` and fills secrets)

Then tell him:

1. Install **Node.js 20** on the laptop (not inside WorkSpaces).
2. Install **Amazon WorkSpaces** desktop app.
3. Unzip the pack, then:

```powershell
cd workers\amazon-scc-playwright
npm install
npx playwright install firefox
cd ..\..
# edit workers\amazon-scc-playwright\.env.station-summary with the shared keys
node scripts\run-workspaces-desktop-monitor.mjs
```

4. Keep WorkSpaces logged in with **Site Summary in Firefox** visible.
5. For other stations: switch station in Site Summary’s top menu; set `AMAZON_ACTIVE_STATION` to the station he is watching (host capture sees the current screen).

### What to tell him about the site

Yes — he must use Site Summary:

- URL pattern: `…/siteSummary` in Firefox inside WorkSpaces  
- Leave that page open while the monitor runs  
- Do not minimize the WorkSpaces window  
- Red numbers on Site Summary trigger the WhatsApp screenshot

## Multi-station note

Host capture watches **whatever station is currently on screen**. To cover 5 stores, either:

- rotate the Site Summary station menu on a schedule, or  
- run one monitor per laptop/WorkSpaces session focused on one station (`AMAZON_ACTIVE_STATION`).
