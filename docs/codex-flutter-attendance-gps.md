# Codex Flutter Handoff — GPS + Selfie Attendance (DropX One)

This note tells Codex how to finish the **native Android Flutter** app (`com.dropxlogistics.one`) after the web implementation in this repo.

Web app root: `apps/connect` (DropX One)  
Shared APIs: dashboard `src/app/api/connect/attendance/*`  
SQL: `scripts/attendance_gps_integrity_v1.sql`

## Product rules (already implemented on web)

1. **Primary punch = station biometric device.** Connect does **not** show GPS Punch In/Out all the time.
2. Connect shows a **Location review** card **only when an open integrity flag exists** (support selfie + live GPS).
3. While DropX One is open, the phone silently sends **presence GPS samples** so a biometric buddy-punch can be checked immediately.
4. After punch-in, in-shift GPS is collected for **9 hours** from punch-in, then stops.
5. Continuous outside zone **> station radius (default 50m) for > 30 minutes** during that window → flag `outside_geofence_gt_2h` as soon as the threshold is crossed.
6. Biometric punch while recent phone GPS is outside the station zone → **immediate** flag `biometric_phone_mismatch`. Connect-linked workers with **no recent phone GPS** are also flagged (possible buddy punch).
7. Reminders at **9.5h** and **10h** after punch-in if no punch-out.
8. Employees **cannot** edit punch lat/lng/time from website or app.
9. Support selfie upload is only for **flagged** review cases.

## REST contracts (reuse exactly)

Base: dashboard host (Connect proxies via `DASHBOARD_URL`).

Auth: DropX Connect session cookie (`dropx_connect_session`) — same as web.

### `GET /api/connect/attendance/punch?accountId&profileType`
Returns shift open state, station geofence, open flags.

### `POST /api/connect/attendance/punch` (multipart / JSON)
Legacy app GPS punch endpoint (kept for compatibility). Product UI no longer offers Punch In/Out; use biometric devices.

### `POST /api/connect/attendance/location-heartbeat` (multipart)
Same location fields + `sessionId`.
- Accepted as **presence** samples even when off-shift (for biometric fraud checks).
- In-shift continuous-outside flags only while shift is open **and** within **9 hours** of punch-in.
- Rate-limited (~2 min).

### `POST /api/connect/attendance/support-evidence` (multipart)
- `flagId`, `punchDate`, `lat`, `lng`, `accuracyM`, `selfie`, `remarks`
  (Support selfie is stored only for flagged review cases.)

## Web limitations → Flutter must implement

| Capability | Web | Flutter requirement |
|---|---|---|
| Mock GPS detection | Client signal only; soft-block if reported | **Hard-block** if mock location enabled |
| Developer options | Not reliable | **Hard-block** until developer options / USB debugging off (configurable) |
| VPN | Heuristic only | Detect active VPN; **block or force flag** per company policy |
| Background location | Only while Connect tab/app is open | Foreground service + periodic updates from login through 9h after punch-in |
| Always-on internet/location UX | Soft messaging | Persist notification: “Location + internet required for attendance integrity” |
| Device integrity | None | **Google Play Integrity API** attestation token on heartbeats |
| Punch UI | Flag/support only; biometric is primary | Do **not** show GPS Punch In/Out always — only location-review when flagged |

## Flutter implementation checklist

1. **Permissions**
   - `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`
   - `CAMERA` (support selfie when flagged)
   - `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_LOCATION`
   - `POST_NOTIFICATIONS`
   - Guide user to disable battery optimization for DropX One

2. **Attendance screen**
   - Calendar / list / punches + regularization
   - Show **Location review needed** only when `openFlags.length > 0`
   - Optional muted line: monitoring active for open shift within 9h
   - No always-on GPS Punch In/Out buttons

3. **Integrity package to send in `integritySignals`**
```json
{
  "clientPlatform": "flutter_android",
  "mockLocation": false,
  "developerMode": false,
  "vpnSuspected": false,
  "playIntegrityToken": "<token>",
  "appVersion": "x.y.z",
  "deviceModel": "..."
}
```

4. **In-shift tracker**
   - Start foreground service on successful punch-in
   - Heartbeat every 3–5 minutes via `location-heartbeat`
   - Stop on punch-out or end of day
   - Local notifications at 9.5h / 10h (server also creates flags)

5. **Support evidence**
   - When open flags returned from GET punch status, show “Support selfie” flow identical to web

6. **Do not build**
   - Any UI to edit historical punch coordinates or times
   - Client-side “force present” overrides

## Google / Play Console setup for Codex

1. Enable **Play Integrity API** on the Firebase/Google Cloud project used by DropX One.
2. Link Android app package `com.dropxlogistics.one`.
3. Add Play Integrity credentials / cloud project number to Flutter secure config.
4. Optional later: Maps SDK only if you want a map preview (not required for geofence math).

## Station setup (ops)

- Ensure every assigned station has `latitude`, `longitude`, `geofence_radius_m` (default 50) in Master → Location.
- Employees cannot change these from One.

## SQL prerequisite

Run on Supabase:

```bash
# scripts/attendance_gps_integrity_v1.sql
```

## Admin review

Dashboard: **Reports → Attendance Integrity** (`/attendance/integrity`)  
Approve support packages (resolves linked flags). Does not rewrite punch GPS.

## Acceptance tests for Flutter

1. Punch in inside 50m → present, not flagged (unless accuracy poor).
2. Punch in outside 50m → saved + flagged + support flow works.
3. Mock location on → punch blocked.
4. Developer options on → punch blocked.
5. After punch-in, kill UI; foreground service still heartbeats.
6. Stay outside > 30 minutes → `outside_geofence_gt_2h` flag.
7. No punch-out at 9.5h / 10h → reminder notification.
8. Biometric punch while phone outside → mismatch flag + support option.
9. Website cannot alter punch lat/lng/time.
