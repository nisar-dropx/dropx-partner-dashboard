# Codex Flutter Handoff — GPS + Selfie Attendance (DropX One)

This note tells Codex how to finish the **native Android Flutter** app (`com.dropxlogistics.one`) after the web implementation.

**Keep this doc in sync with web.** If product rules, selfie pipeline, APIs, flags, or People review change, update this file in the same PR.

---

## Repos & URLs

| Area | Location |
|---|---|
| Connect web (DropX One) | `apps/connect` in `dropx-partner-dashboard` |
| Shared attendance APIs | `src/app/api/connect/attendance/*` (dashboard) |
| Core GPS / hold / flag logic | `src/lib/biometric/attendance-gps.ts` |
| People HRMS review | `dropx-hrms` → `https://people.dropxlogistics.com/attendance/integrity` |
| Connect production | `https://one.dropxlogistics.com/` |
| Partner integrity (legacy mirror) | `https://dashboard…/attendance/integrity` |

**Auth:** DropX Connect session cookie (`dropx_connect_session`). Connect proxies APIs via `DASHBOARD_URL`.

---

## Product rules (current)

1. **Primary punch = station biometric device.** Connect must **not** show always-on GPS Punch In/Out.
2. Connect shows **Location review needed** **only when** `openFlags.length > 0` (support selfie + live GPS for manager review).
3. While DropX One is logged in, the phone silently sends **presence GPS** (even off-shift) so buddy-punch can be checked on biometric punch.
4. After punch-in, in-shift tracking / continuous-outside flagging runs for **9 hours**, then stops (`LOCATION_TRACKING_MS`).
5. Continuous outside station geofence **> radius (default 50m) for > 30 minutes** during that window → flag `outside_geofence_gt_2h` (name is historical; threshold is **30 min**, not 2h).
6. Biometric punch while recent phone GPS is outside any company station → immediate `biometric_phone_mismatch`. Connect-linked workers with **no recent phone GPS** (within **20 min**) are also flagged (`phone_location_missing` in details). That punch is **held**.
7. Forgot punch-out reminders at **9.5h** and **10h** after punch-in → `forgot_punch_out`.
8. Employees **cannot** edit punch lat/lng/time from website or app.
9. Support selfie is **review-only** — never marks Present by itself (`attendanceMarked: false`).
10. **Duty vs calendar:** held punches may keep `shift.open` + `shift.pendingApproval` / `dutyOnly` for tracking UX, but calendar / `attendance_daily` stays unchanged until **Approve**.

### Held / pending attendance (critical)

11. App GPS / selfie punch-in stores a **held** punch: `calculated=false`, `is_flagged=true`, flag `pending_selfie_punch`.
12. Flagged biometric mismatch punches are also **held** until approve.
13. **Approve** (People) → activate punch (`calculated=true`) + rebuild day → Present.
    - Calendar **in/out time must stay the employee’s original punch time** (`client_captured_at` when valid, else stored `punch_time`).
    - Never write the **manager approval time** as punched-in time.
14. **Dismiss / reject** → calendar stays unchanged (no Present).
15. Manager is notified via **People in-app notifications only** (no email). Event: `attendance_location_flagged`.

---

## Key constants (from `attendance-gps.ts` / face libs)

| Constant | Value | Meaning |
|---|---|---|
| `FALLBACK_GEOFENCE_RADIUS_M` | **50** | Default station radius if not set |
| Station radius DB range | **10–5000 m** | Admin-configured per station |
| `OUTSIDE_CONTINUOUS_MS` | **30 min** | Continuous outside → flag |
| `LOCATION_TRACKING_MS` | **9 h** | In-shift tracking window after punch-in |
| `SHIFT_REMINDER_MS` | **9.5h, 10h** | Forgot punch-out reminders |
| `BIOMETRIC_SAMPLE_WINDOW_MS` | **20 min** | “Recent” phone GPS for mismatch check |
| Heartbeat server min interval | **2 min** | Rate limit (`retryAfterMs`) |
| Heartbeat client (web) | **~3 min** | Flutter: **3–5 min** |
| Face match percent | **≥ 60%** | Pass threshold |
| Face match distance | **≤ 0.42** | face-api euclidean cap |
| Face match streak | **3 frames** | Consecutive OK before liveness |
| Liveness sample rate (web) | as-fast-as-detect (recursive) | Do not use fixed interval + busy skip (misses blinks) |
| Blink detection | **1 blink**, ~5% EAR dip | Intentionally loose — manager reviews selfie |
| Blink hard-shake reject | center **> ~0.10** or scale **> ~0.32** | Soft micro-motion allowed |
| Head-turn yaw peak | **≥ ~0.11** | Then return \|yaw\| **≤ ~0.07** |
| Accuracy integrity penalty | **> 100 m** | −25 integrity score |
| Support selfie max size | **8 MB** | Server reject above |

Geofence resolution: prefer assigned station if inside; else closest company station that contains the point.

---

## Support selfie pipeline (must match web exactly)

UI: Connect Attendance → open flag → **Support selfie**.

### Step 0 — Geofence gate
- Read GPS; evaluate against `station` / `stations` from punch status.
- **Outside** → show *You are outside the allowed location…*; **camera disabled**.
- **Inside** → enable camera.
- Do not remount/reset the camera on quiet GPS refresh while the panel is open.
- Server also rejects support upload if outside / geofence unknown.

### Step 1 — Face match FIRST
- Compare live camera to **profile photo**.
- Pass only if distance ≤ **0.42** and percent ≥ **60**.
- Require **~3 consecutive** good frames (not a single lucky frame).
- If profile photo missing → block with clear error (upload profile photo first).
- Web: `apps/connect/src/lib/face-match.ts`

### Step 2 — Liveness (anti photo-spoof)
Only after face match passes. Order:

1. **Blink once** — loose EAR dip (manager reviews selfie). Soft motion OK.
2. **Turn head left**, then face forward (yaw; not waving the whole photo).
3. **Turn head right**, then face forward.

**Blink rules (web — match these sensitivities):**
- Sample pose **as fast as detection finishes** (recursive timeout). Fixed `setInterval` + busy lock drops frames and misses natural blinks.
- Blink is **intentionally loose** (manager reviews the stored selfie): **1 blink**, about a **5% EAR dip** (min ~0.008).
- Use the **more-closed eye** EAR so partial blinks still register.
- Reject only **extreme** phone/photo wave motion.
- Still photos usually fail (no EAR dip); head turns L/R remain after blink.

**Head-turn rules (web):**
- Yaw peak **≥ ~0.11** in the requested direction, then return to center **|yaw| ≤ ~0.07**.
- Reject huge translation/zoom without a clean yaw ramp.

Web: `apps/connect/src/lib/face-liveness.ts`, `selfie-capture-panel.tsx`  
Flutter: prefer **ML Kit Face Mesh** + commercial liveness SDK for production; never accept still photo / screen replay. Keep blink detection **sensitive to real blinks** — do not over-tighten anti-shake so natural blinks fail.

### Step 3 — Capture
- Enable Capture only when match + liveness done.
- Re-check face match on the captured frame before “Use selfie”.
- Upload via `support-evidence` with live GPS + selfie.

---

## Flag types

| `flag_type` | Meaning |
|---|---|
| `biometric_phone_mismatch` | Biometric punch while phone outside, or no recent phone GPS. Held punch. High severity. |
| `outside_geofence_gt_2h` | In-shift continuous outside ≥ **30 min**. High severity. (Legacy name.) |
| `pending_selfie_punch` | App/selfie GPS punch held until manager approve. |
| `integrity_risk` | Mock / developer mode / VPN / poor accuracy on app punch. |
| `outside_geofence_punch` | Reserved in schema; punch path rejects outside rather than storing this. |
| `forgot_punch_out` | No punch-out after 9.5h / 10h. |

Flag statuses: `open` | `resolved` | `dismissed`.  
One open flag per `(company_id, enrolment_id, punch_date, flag_type)`.

---

## REST contracts (reuse exactly)

### `GET /api/connect/attendance/punch?accountId&profileType`

Returns:

```json
{
  "enrolmentId": "...",
  "locationId": "...",
  "shift": {
    "punchDate": "YYYY-MM-DD",
    "open": true,
    "inTime": "ISO|null",
    "outTime": "ISO|null",
    "punchCount": 1,
    "pendingApproval": true,
    "dutyOnly": true
  },
  "station": {
    "id": "...",
    "code": "...",
    "name": "...",
    "latitude": 0,
    "longitude": 0,
    "radiusM": 50
  },
  "stations": [],
  "openFlags": [
    {
      "id": "...",
      "flag_type": "biometric_phone_mismatch",
      "severity": "high",
      "message": "...",
      "status": "open",
      "punch_date": "YYYY-MM-DD",
      "created_at": "ISO",
      "details": {}
    }
  ]
}
```

Use `station` / `stations` for client geofence. Show an action card **only** when `openFlags.length > 0` (submit selfie). Do **not** show monitoring / pending-manager / duty-status banners — GPS tracking is silent. `pendingApproval` / `dutyOnly` are only true when open flags exist (held punches alone must not surface UX).

### `POST /api/connect/attendance/punch` (legacy / compatibility)

JSON or multipart: `accountId`, `profileType`, `action` (`in`|`out`), `lat`, `lng`, `accuracyM`, `altitudeM`, `clientCapturedAt`, `integritySignals`, `faceMatched` (must be true; selfie file ignored server-side).

- Product UI should **not** expose Punch In/Out.
- If called: creates **held** punch + `pending_selfie_punch`; returns `pendingApproval: true`, `supportRequired: true`, `isFlagged: true`.
- Reject mock location / developer mode when signaled.

### `POST /api/connect/attendance/location-heartbeat` (multipart)

Fields: `accountId`, `profileType`, `lat`, `lng`, `accuracyM`, `altitudeM`, `clientCapturedAt`, `sessionId`, `integritySignals`.

Behavior:
- Accepted as **presence** even off-shift.
- In-shift continuous-outside flagging only while shift open **and** within **9h** of punch-in.
- Rate-limited (~2 min). Response may include `skipped: true`, `reason: "rate_limited" | "tracking_window_ended"`, `retryAfterMs`.
- Normal response includes `mode` (`presence`|`shift`), `geofence`, `outsideMs`, `outsideFlagId`, `trackingWindowMs`, `shift`.

### `POST /api/connect/attendance/support-evidence` (multipart)

Fields: `accountId`, `profileType`, `flagId`, `punchId?`, `punchDate`, `lat`, `lng`, `accuracyM`, `clientCapturedAt`, `remarks`, `selfie`.

- Only for open flags belonging to the signed-in worker.
- **Server rejects** outside / unknown geofence.
- Does **not** insert punches or rebuild attendance.
- Response: `ok`, `review`, **`attendanceMarked: false`**.

### Recommended `integritySignals` JSON (Flutter)

```json
{
  "faceMatched": true,
  "faceMatchPercent": 72,
  "livenessPassed": true,
  "livenessChallenges": ["blink", "turn_left", "turn_right"],
  "mockLocation": false,
  "developerMode": false,
  "vpnSuspected": false,
  "clientPlatform": "android",
  "playIntegrityToken": "..."
}
```

---

## Connect UI expectations (Flutter parity)

1. **Attendance home** — calendar / list / punches; month nav; no GPS Punch In/Out.
2. **No pending-approval / duty / monitoring banners** — never tell the worker they are being monitored or that duty is “pending manager approval”.
3. **Action needed card** only if `openFlags.length > 0` — generic “Submit selfie” (do not show flag_type / internal messages).
4. **Support sheet** — geofence gate; camera gated; face match → liveness → capture → submit. Neutral copy only.
5. **Silent tracker** — presence while logged in; after punch-in continue **9h**; heartbeat every **3–5 min**; no UI copy.

Do **not** build: edit punch lat/lng/time; force Present; always-visible GPS punch; treating support selfie as attendance; skipping face match before liveness; remounting camera mid-liveness on GPS refresh; worker-facing monitoring jargon.

---

## People HRMS admin review (managers)

Primary: **People → Attendance → Location integrity**  
`https://people.dropxlogistics.com/attendance/integrity`

### Navigation / access
- Attendance sub-tabs: **Daily register** | **Location integrity**.
- Integrity tab visible for `attendance.view` users; integrity link for managers / integrity permissions / team leads.
- Inside integrity: **Open flags** | **Support packages**.

### Flag review popup (centered modal)
- Open via **Open** on a flag (`?flagId=`).
- Shows **worker name + biometric ID + allowed station** (from biometric enrolment mapping).
- Shows flag details, device vs station, last phone GPS (if any), linked support selfies.
- Footer for open flags (managers):
  - **Close** — closes instantly (must not wait on a full page reload).
  - **Dismiss flag** — closes flag; **does not** activate held punch; redirects out of the modal.
  - **Approve punch** — resolves flag, auto-approves linked pending support packages, activates held punch, rebuilds day with **original punch time**, redirects out of the modal.
- Hint: Approve counts held punch toward attendance; Dismiss leaves calendar unchanged.

### Temporary development shortcut
- **Approve all (N)** on Open flags tab — bulk-resolves open flags (team or company depending on permission).
- Must be **batched** (bulk flag/review updates + bulk punch activate + parallel day rebuilds). Do not approve flags one-by-one serially (hangs on ~200+ flags).
- Temporary only while development continues.

### Support packages tab
- Per package: Approve / Reject (remarks required on reject).
- Approve activates held punch when linked (original punch time preserved).

### Notifications
- **In-app only** — bell on **Overview** and **People Pulse** page headers (top-right, beside Open attendance / directory).
- Not a sidebar nav item.
- Bell opens a small popover; **Show all notifications** → `/notifications`.
- Source key pattern: `attendance-flag:{flagId}`.

Partner dashboard `/attendance/integrity` remains a legacy mirror with Approve / Dismiss on flags.

---

## Web vs Flutter capability table

| Capability | Web (Connect) | Flutter requirement |
|---|---|---|
| Mock GPS | Client signal | **Hard-block** if mock enabled |
| Developer options | Not reliable | **Hard-block** until off |
| VPN | Heuristic | Detect; block or force flag per policy |
| Background location | Only while app/tab open | Foreground service: login → **9h after punch-in** |
| Device integrity | None | **Play Integrity** on heartbeats |
| Punch UI | Flag / support only | No always-on GPS Punch In/Out |
| Geofence gate | Camera off outside | Same — disable camera + clear message |
| Face match | ≥60%, ≤0.42, 3-frame streak | Same thresholds (ML Kit / embeddings) |
| Liveness | Blink×1 + L + R (loose) | Manager reviews selfie; prefer commercial SDK on Flutter |
| Heartbeat cadence | ~3 min client; 2 min server floor | **3–5 min** |
| Pending punch UX | silent + openFlags only | No duty/monitoring banners; action card only when flags open |
| Camera remount | Must stay stable during liveness | Do not reset challenges on GPS refresh |
| Approve punch time | Original punch time, never approval time | Same |

---

## Flutter implementation checklist

1. Permissions — fine location, camera, FGS location, notifications; battery optimization guidance.
2. Attendance screens — calendar/list/punches; Location review only when flags exist; pending-approval banner; no GPS Punch In/Out.
3. Presence + shift tracker — presence while logged in; 9h after punch-in; heartbeat 3–5 min; Play Integrity + mock/dev/VPN signals.
4. Support selfie pipeline — geofence → face match → blink×1 → turn L → turn R → capture → upload; never mark Present locally after upload.
5. Open-flag polling — refresh punch status periodically so new flags appear without restart.
6. Do not build — punch edit; force Present; skip match/liveness; always-on GPS punch UI.

---

## SQL / migrations (shared Supabase — run once)

**Partner dashboard scripts**
```text
scripts/attendance_gps_integrity_v1.sql
scripts/attendance_pending_selfie_punch_v1.sql
scripts/people_web_notifications_v1.sql
scripts/people_attendance_integrity_tabs_grants_v1.sql
```

**People HRMS migrations** (same DB; mirrors)
```text
supabase/migrations/20260826190000_people_web_notifications_attendance_integrity.sql
supabase/migrations/20260826200000_attendance_integrity_tabs_grants.sql
supabase/migrations/20260826201500_pending_selfie_punch_flag_type.sql
```

Without these, integrity queues / notifications / pending flag types fail or return schema errors.

---

## Web file references

| Purpose | Path |
|---|---|
| Constants, geofence, hold/activate, flags | `src/lib/biometric/attendance-gps.ts` |
| People notify on flag | `src/lib/attendance-flag-notifications.ts` |
| Punch GET/POST | `src/app/api/connect/attendance/punch/route.ts` |
| Heartbeat | `src/app/api/connect/attendance/location-heartbeat/route.ts` |
| Support selfie upload | `src/app/api/connect/attendance/support-evidence/route.ts` |
| Biometric mismatch hook | `src/app/api/biometric/punch/route.ts` |
| Connect attendance UI | `apps/connect/src/components/connect-attendance.tsx` |
| Silent GPS monitor | `apps/connect/src/components/attendance-location-monitor.tsx` |
| Selfie panel (match → liveness → capture) | `apps/connect/src/components/selfie-capture-panel.tsx` |
| Face match | `apps/connect/src/lib/face-match.ts` |
| Liveness | `apps/connect/src/lib/face-liveness.ts` |
| People integrity page | `dropx-hrms/src/app/attendance/integrity/page.tsx` |
| People integrity actions | `dropx-hrms/src/app/attendance/integrity/actions.ts` |
| Flag modal | `dropx-hrms/src/components/integrity-flag-modal.tsx` |
| Name/station labels | `dropx-hrms/src/lib/integrity-worker-labels.ts` |
| Held punch activate / bulk | `dropx-hrms/src/lib/attendance-held-punch.ts` |
| Notifications bell | `dropx-hrms/src/components/people-notifications-bell.tsx` |
| Notifications panel (full page) | `dropx-hrms/src/components/people-notifications-panel.tsx` |
| Attendance sub-tabs | `dropx-hrms/src/components/attendance-section-tabs.tsx` |

---

## Acceptance tests for Flutter

1. Presence GPS while logged in (off-shift) is stored.
2. Biometric punch while phone outside → `biometric_phone_mismatch`; calendar not Present until approve.
3. Connect-linked worker with no recent phone GPS → same flag + hold.
4. After punch-in, heartbeats for 9h then stop; outside radius >30 min continuous → `outside_geofence_gt_2h`.
5. Support selfie outside geofence → camera disabled and/or submit rejected.
6. Support selfie: **face match first**, then blink ×1 + left + right (loose); upload succeeds; **attendance not marked**.
7. No always-on GPS Punch In/Out UI.
8. Mock location / developer options → hard-block.
9. App/website cannot alter punch lat/lng/time.
10. Manager **Approve punch** → Present on calendar at the **original punch time** (not approve time); **Dismiss/reject** → still absent.
11. Reminders at 9.5h and 10h if no punch-out.
12. Camera/liveness session does not reset when background GPS refresh runs.

---

## Changelog note (for Codex)

Recent web/People work that Flutter must include (do not ship older behavior):

- No always-on GPS punch UI; biometric primary.
- Held punches until People approve; support selfie review-only.
- Presence GPS + 9h window + 50m/30min continuous outside.
- Support selfie: **inside geofence → face match → liveness → capture**.
- Liveness: blink×1 (loose ~5% EAR dip) then head turns; manager reviews stored selfie.
- Head turns L/R after blinks.
- Approve punch keeps **original punch time** (never manager approve time).
- People centered flag modal: Approve / Dismiss redirect out; Close is instant.
- Temporary **Approve all** must be batched (not serial per-flag).
- Notifications bell on Overview / People Pulse (popover → full `/notifications`).
- Name + allowed station on integrity UI.
- Server rejects support evidence outside geofence.
