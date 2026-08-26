# Codex Flutter Handoff — GPS + Selfie Attendance (DropX One)

This note tells Codex how to finish the **native Android Flutter** app (`com.dropxlogistics.one`) after the web implementation in this repo.

Web app root: `apps/connect` (DropX One)  
Shared APIs: dashboard `src/app/api/connect/attendance/*`  
SQL: `scripts/attendance_gps_integrity_v1.sql`

## Product rules (already implemented on web)

1. App GPS punch **coexists** with biometric device punches.
2. Punch requires **selfie + lat/lng**; **server timestamp** is authoritative (never trust editable client time).
3. Outside station geofence (default **50m**, admin-only on stations) → allow punch, **auto-flag**, employee attaches support selfie+location for manager/HR review.
4. In-shift heartbeats only (after punch-in until punch-out).
5. Continuous outside zone **> 2 hours** → flag `outside_geofence_gt_2h`.
6. Reminders at **9.5h** and **10h** after punch-in if no punch-out.
7. Biometric punch + recent phone sample outside zone → flag `biometric_phone_mismatch`.
8. Employees **cannot** edit punch lat/lng/time from website or app.

## REST contracts (reuse exactly)

Base: dashboard host (Connect proxies via `DASHBOARD_URL`).

Auth: DropX Connect session cookie (`dropx_connect_session`) — same as web.

### `GET /api/connect/attendance/punch?accountId&profileType`
Returns shift open state, station geofence, open flags.

### `POST /api/connect/attendance/punch` (multipart)
Fields:
- `accountId`, `profileType`
- `action` = `in` | `out`
- `lat`, `lng`, `accuracyM`, `altitudeM` (optional)
- `clientCapturedAt` (ISO, advisory only)
- `integritySignals` (JSON string)
- `selfie` (image file, required)

Response includes `isFlagged`, `supportRequired`, `flagIds`, `geofence`, `integrity`.

### `POST /api/connect/attendance/location-heartbeat` (multipart)
Same location fields + `sessionId`. Only accepted while shift is open. Rate-limited (~2 min).

### `POST /api/connect/attendance/support-evidence` (multipart)
- `flagId`, `punchDate`, `lat`, `lng`, `accuracyM`, `selfie`, `remarks`

## Web limitations → Flutter must implement

| Capability | Web | Flutter requirement |
|---|---|---|
| Mock GPS detection | Client signal only; soft-block if reported | **Hard-block** punch if mock location enabled |
| Developer options | Not reliable | **Hard-block** until developer options / USB debugging off (configurable) |
| VPN | Heuristic only | Detect active VPN; **block or force flag** per company policy |
| Background location | Only while browser tab open | Foreground service + periodic updates while on shift |
| Always-on internet/location UX | Soft messaging | Persist notification: “Location + internet required for attendance” |
| Device integrity | None | **Google Play Integrity API** attestation token on every punch |
| Selfie liveness | Still photo | Prefer liveness / face presence check if available |

## Flutter implementation checklist

1. **Permissions**
   - `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`
   - `CAMERA`
   - `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_LOCATION`
   - `POST_NOTIFICATIONS`
   - Guide user to disable battery optimization for DropX One

2. **Punch screen**
   - Mirror web: Punch In / Out, live distance to station, selfie capture, no editable time/coords
   - Call same multipart APIs
   - Before punch: run integrity checks; if mock/dev/VPN blocked → show blocking UI (“Turn off … to continue”)

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
6. Stay outside > 2h → `outside_geofence_gt_2h` flag.
7. No punch-out at 9.5h / 10h → reminder notification.
8. Biometric punch while phone outside → mismatch flag + support option.
9. Website cannot alter punch lat/lng/time.
