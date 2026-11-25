# DropX Site Summary Monitor — Firefox Extension

Monitors acceptance time on Amazon Site Summary for all dark stores.
Sends a WhatsApp image alert to each station's war room when any order exceeds 15s.

## Install in Firefox (WorkSpaces VM)

1. Open Firefox inside the WorkSpaces VM
2. Go to `about:debugging`
3. Click **This Firefox** in the left sidebar
4. Click **Load Temporary Add-on…**
5. Navigate to this folder and select `manifest.json`
6. The DropX icon appears in the Firefox toolbar

> **Note:** "Temporary" means it unloads on Firefox restart. For permanent install, ask an admin
> to sign it, or set `xpinstall.signatures.required = false` in `about:config`.

## Usage

Click the toolbar icon to open the popup:

| Button | What it does |
|---|---|
| ▶ Start | Begin monitoring all stations on a 60s cycle |
| ⏸ Pause | Finish current cycle then hold (▶ Resume to continue) |
| ↺ Run Now | Trigger an immediate cycle |
| ⟳ Refresh Page | Reload the Site Summary tab |
| 🔔 Send Test | Send a test alert to Dark Store Testing group |
| ■ Stop | Stop monitoring completely |

## How it works

- Cycles through all 7 stations (TTB3, TTG9, TCC3, TCD4, TTA5, TZC4, TFB7)
- For each: switches the site dropdown, waits for data to load, reads the table
- If any order's Acceptance Time ≥ 15s → builds a PNG image and sends via Report Bot worker
- 5-minute cooldown per station to avoid repeat alerts

## Go live

Edit `config.local.js` (not committed):
1. Set `CONFIG.TESTING_GROUP = ""` — **required**. Dark Store Testing is muted in the portal; sending there returns 422 and nothing posts.
2. Keep `STATION_GROUPS` / war-room JIDs in `config.js` — alerts go to each station's live group (TFB7 stays off until re-enabled in Report Bot).
