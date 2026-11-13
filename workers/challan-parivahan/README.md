# DropX Fleet Challan worker (Parivahan)

Standalone Node service that pulls **outstanding traffic challans** for the fleet's **own**
vehicles from the public Parivahan NextGen e-Challan "Check Status" portal, using **free local
captcha OCR** (tesseract.js — no paid/demo APIs). It posts results to the dashboard's authorized
ingest webhook, so every DB write goes through the proven, permission-scoped path. The worker runs
independently of Vercel and never holds a database connection open.

## What it does

For each active, DropX-owned vehicle (with a stored `registration_date`):

1. Warm up the portal, register a device (solving the captcha locally).
2. `challan-search` by vehicle number + RC date (the portal validates the RC date).
3. `get-challan-details` → the list of challans (no OTP needed to read status).
4. `ChallanDocs` → the AI-camera image / notice (URL or inline base64).
5. POST the outstanding challans to the dashboard `/api/fleet/challans/ingest`, which mirrors
   evidence into the `Fleet_Challans` Google Drive folder and upserts via `fleet_challan_upsert_v1`.

It reads only publicly checkable status. **It never initiates a payment.**

## Endpoints

- `GET /health` — liveness + config flags.
- `POST /pull` — `Authorization: Bearer $CHALLAN_WORKER_SECRET`.
  Body (all optional): `{ companyId?, vehicleNos?: string[], limit?, dryRun?: boolean }`.
  Returns a per-vehicle summary. `dryRun: true` pulls but does not ingest.

The dashboard's daily Vercel cron (`/api/cron/fleet-challans`, 02:00 IST) only **kicks** this
endpoint and returns immediately; the heavy work happens here.

## Environment

| Var | Purpose |
|-----|---------|
| `CHALLAN_WORKER_SECRET` | Bearer secret for `POST /pull`. |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Read owned vehicles + registration dates. |
| `FLEET_CHALLAN_INGEST_URL` | Dashboard ingest endpoint, e.g. `https://fleet.dropxlogistics.com/api/fleet/challans/ingest`. |
| `FLEET_CHALLAN_INGEST_SECRET` | Must match the dashboard's `FLEET_CHALLAN_INGEST_SECRET`. |
| `FLEET_DEFAULT_COMPANY_ID` | Optional default company when a row omits one. |
| `CHALLAN_PER_VEHICLE_DELAY_MS` | Politeness delay between vehicles (default 4000). |
| `CHALLAN_MAX_VEHICLES_PER_RUN` | Safety cap per run (default 60). |

## TLS

The portal serves a Let's Encrypt chain rooted at **ISRG Root YE**, which is newer than Node's
bundled CA list and is cross-signed by the universally trusted **ISRG Root X2**. `isrg-root-ye.pem`
is bundled and added to the trust store in `tls.mjs` — certificate verification stays **on**; we
only add one extra public root, never disable checking.

## Local run

```bash
npm install
# one-shot pull for a single vehicle (prints challans, does not ingest)
node scripts/pull-once.mjs KL71F6997 15/01/2019
# or run the server
CHALLAN_WORKER_SECRET=dev SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm start
```

## Deploy

Docker image (`Dockerfile`). Deploy on Render/Railway/any container host. Schedule the daily pull
either via the dashboard cron (which kicks `/pull`) or the host's own cron hitting `/pull`.
Bundles `eng.traineddata` so OCR needs no network at runtime.
