# Codex Flutter Handoff — GPS + Selfie Attendance (DropX One)

This note tells Codex how to finish the **native Android Flutter** app (`com.dropxlogistics.one`) after the web implementation in this repo.

Web app root: `apps/connect` (DropX One)  
Shared APIs: dashboard `src/app/api/connect/attendance/*`  
SQL: `scripts/attendance_gps_integrity_v1.sql`, `scripts/attendance_pending_selfie_punch_v1.sql`, `scripts/people_web_notifications_v1.sql`  
People review: `https://people.dropxlogistics.com/attendance/integrity`

## Product rules (already implemented on web)

1. **Primary punch = station biometric device.** Connect does **not** show GPS Punch In/Out all the time.
2. Connect shows a **Location review** card **only when an open integrity flag exists** (support selfie + live GPS).
3. While DropX One is open, the phone silently sends **presence GPS samples** so a biometric buddy-punch can be checked immediately.
4. After punch-in, in-shift GPS is collected for **9 hours** from punch-in, then stops.
5. Continuous outside zone **> station radius (default 50m) for > 30 minutes** during that window → flag `outside_geofence_gt_2h` as soon as the threshold is crossed.
6. Biometric punch while recent phone GPS is outside the station zone → **immediate** flag `biometric_phone_mismatch`. Connect-linked workers with **no recent phone GPS** are also flagged (possible buddy punch).
7. Reminders at **9.5h** and **10h** after punch-in if no punch-out.
8. Employees **cannot** edit punch lat/lng/time from website or app.
9. Support selfie upload is only for **flagged** review cases — **review-only** (never marks attendance by itself).
10. **Support selfie capture gate (must match web):**
    1. Worker must be **inside** the allocated station geofence (camera disabled outside).
    2. **Face match first** against profile photo (≥60%, descriptor distance ≤0.42) — hold still until match is stable for ~3 consecutive frames.
    3. **Then liveness** (anti photo-spoof): blink twice → turn head left → turn head right.  
       - Blink requires **EAR drop while face center/size stay stable** (reject waving/shaking a printed photo).  
       - Head turns require **yaw change**, not whole-frame translation/zoom.  
    4. Only then enable **Capture**. Re-check face match on the captured frame before “Use selfie”.
    Web: `apps/connect/src/lib/face-match.ts`, `apps/connect/src/lib/face-liveness.ts`, `apps/connect/src/components/selfie-capture-panel.tsx`.  
    Flutter: prefer **ML Kit Face Mesh / Face Detection** + commercial liveness if available; never accept a still photo or phone-screen replay.

### Pending attendance (critical)

11. **Selfie / app GPS punch-in does not write Present to the calendar or `attendance_daily`.**  
    - Server stores a **held** punch (`calculated=false`, `is_flagged=true`) and opens flag `pending_selfie_punch`.  
    - **Duty status** may show open (for GPS tracking / UX) via `shift.open` + `shift.pendingApproval`.  
    - **Only after manager/HR approves** the support package (or resolves the linked flag) is the punch activated (`calculated=true`) and the day rebuilt.
12. **First flagged biometric punch** (phone mismatch / missing GPS) is also **held** off the calendar until the flag is approved. Dismiss without approve does **not** mark Present.
13. Support selfie → People notification for manager approval only. Response includes `attendanceMarked: false`.

## REST contracts (reuse exactly)

Base: dashboard host (Connect proxies via `DASHBOARD_URL`).

Auth: DropX Connect session cookie (`dropx_connect_session`) — same as web.

### `GET /api/connect/attendance/punch?accountId&profileType`
Returns shift open state, station geofence, open flags.  
`shift.pendingApproval` / `shift.dutyOnly` = duty on but calendar not yet Present.

### `POST /api/connect/attendance/punch` (multipart / JSON)
Legacy app GPS punch endpoint (kept for compatibility). Product UI no longer offers Punch In/Out; use biometric devices.  
If called: creates **pending** held punch + `pending_selfie_punch` flag; does **not** mark attendance until approve. Returns `pendingApproval: true`, `supportRequired: true`.

### `POST /api/connect/attendance/location-heartbeat` (multipart)
Same location fields + `sessionId`.
- Accepted as **presence** samples even when off-shift (for biometric fraud checks).
- In-shift continuous-outside flags only while shift is open **and** within **9 hours** of punch-in.
- Rate-limited (~2 min).
- Open shift includes **held** pending punches for duty/tracking.

### `POST /api/connect/attendance/support-evidence` (multipart)
- `flagId`, `punchDate`, `lat`, `lng`, `accuracyM`, `selfie`, `remarks`
- Support selfie **only** for flagged cases.
- Server **rejects** if device GPS is outside station geofence.
- Capture only after **face match → liveness → capture** on device.
- Does **not** insert punches or rebuild attendance. Notifies manager in People. `attendanceMarked: false`.

## Web limitations → Flutter must implement

| Capability | Web | Flutter requirement |
|---|---|---|
| Mock GPS detection | Client signal only | **Hard-block** if mock location enabled |
| Developer options | Not reliable | **Hard-block** until off |
| VPN | Heuristic only | Detect; block or force flag per policy |
| Background location | Only while Connect open | Foreground service from login through 9h after punch-in |
| Device integrity | None | **Play Integrity** on heartbeats |
| Punch UI | Flag/support only | No always-on GPS Punch In/Out |
| Geofence gate | Camera off outside station | Same — disable camera outside perimeter |
| Face match | Profile photo first (≥60%) | Same threshold; use on-device embedding / ML Kit |
| Liveness | Blink ×2 + turn L + turn R with anti-shake | Same order; **reject printed photo / screen shake**. Prefer commercial liveness SDK for production. |
| Pending punch | Held until People approve | Show duty-pending; never treat support selfie as Present |

## Flutter implementation checklist

1. **Permissions** — fine location, camera, FGS location, notifications; disable battery optimization guidance.
2. **Attendance screen** — calendar/list/punches; **Location review needed** only when `openFlags.length > 0`; muted 9h monitoring line; no GPS Punch In/Out. If `shift.pendingApproval`, show “duty pending manager approval”.
3. **Support selfie pipeline (required — match web order)**  
   a. Confirm **inside geofence** (else show “outside allowed location”, camera disabled).  
   b. **Face match** to profile photo until stable pass (≥60%, multi-frame).  
   c. **Liveness challenges** (must match web):
      1. Blink twice — EAR drop with **stable face box** (reject photo shake)  
      2. Turn head to user's left, then face forward  
      3. Turn head to user's right, then face forward  
   d. Enable Capture; re-verify face match on captured frame.  
   Reference: `apps/connect/src/lib/face-liveness.ts`, `selfie-capture-panel.tsx`.  
   Upload only updates the review queue — **do not** refresh calendar as Present.
4. **`integritySignals` JSON** include `faceMatched`, `faceMatchPercent`, `livenessPassed`, `livenessChallenges: ["blink","turn_left","turn_right"]`, Play Integrity token, mock/dev/VPN flags.
5. **Tracker** — presence while logged in; after punch-in sample **9 hours** then stop; heartbeat every 3–5 min.
6. **Do not build** — edit punch lat/lng/time; force-present; always-visible GPS punch; treating support selfie as attendance; skipping face match before liveness.

## Admin review (People)

Primary: **People → Attendance → Location integrity**  
`https://people.dropxlogistics.com/attendance/integrity`  
Sub-tabs: Daily register | Location integrity (shown for anyone with Attendance view; integrity link for integrity permission or team managers)  
Inside integrity: Open flags | Support packages  

**Approve** support package / flag → activate held punch + rebuild day (Present).  
**Approve all** = temporary development shortcut on the flags tab.  
**Reject / dismiss** → calendar stays unchanged (no Present).

In-app People notifications (no email). Partner dashboard `/attendance/integrity` is legacy mirror.

## SQL prerequisite

```bash
# scripts/attendance_gps_integrity_v1.sql
# scripts/attendance_pending_selfie_punch_v1.sql
# scripts/people_web_notifications_v1.sql
# People: supabase/migrations/20260826200000_attendance_integrity_tabs_grants.sql
# People: supabase/migrations/20260826201500_pending_selfie_punch_flag_type.sql
```

## Acceptance tests for Flutter

1. Presence GPS while logged in (off-shift) is stored.
2. Biometric punch while phone outside → immediate `biometric_phone_mismatch`; calendar not Present until approve.
3. After punch-in, heartbeats for 9h then stop; outside >50m for >30 min → flag.
4. Support selfie **outside** geofence → camera disabled / submit rejected.
5. Support selfie: **face match first**, then blink + left + right; **printed photo / shaking a photo fails**; then upload works; attendance not marked.
6. No always-on GPS Punch In/Out UI.
7. Mock location / developer options → hard-block per policy.
8. Website cannot alter punch lat/lng/time.
9. Manager approve → punch appears on calendar; reject → still absent.
