# Play Store submission content (draft, ready to paste in)

Prepared ahead of time so submission isn't blocked on writing this from scratch once the
signing-key question with the existing `com.dropxlogistics.one` listing is resolved. Review and
adjust wording before actually submitting — this is a first draft, not final copy.

## Data Safety form (Play Console → your app → App content → Data safety)

**Does your app collect or share any of the required user data types?** Yes.

| Data type | Collected? | Shared? | Purpose |
|---|---|---|---|
| **Location — Precise location** | Yes | No (not shared outside the company) | App functionality (attendance tracking, dispatch/routing while clocked in) |
| **Personal info — Name** | Yes | No | App functionality (identifying the worker) |
| **Personal info — Phone number** | Yes | No | App functionality (login/identification) |

For each data type, the form will also ask:
- **Is this data collected, shared, or both?** Collected (not shared with any third party — stays
  within the company's own systems).
- **Is this data processing user-controlled (optional)?** No — required for the app's core
  attendance/dispatch function; a worker who declines location access can still use the rest of
  the app, but background tracking (and therefore automatic attendance/dispatch) won't work for
  them (match this to however `DropxOnePlugin`'s consent dialog and permission flow actually
  behaves before finalizing — the form must describe reality, not intent).
- **Is this data encrypted in transit?** Yes (HTTPS to `one.dropxlogistics.com`, same as the rest
  of the site).
- **Can users request data deletion?** Yes, if the company already has a process for this (an HR
  request, an admin panel, etc.) — say so and describe it briefly; if there's no such process
  today, that needs to exist before answering yes here.

## Permissions Declaration for background location

Google requires this whenever an app declares `ACCESS_BACKGROUND_LOCATION`. Submitted via
Play Console → App content → Permissions declaration form, or via a review question if it comes
up after submission.

**Draft justification text:**

> DropX One Tracker is an internal workforce attendance and dispatch app used by our company's
> employees and independent contractors while they are on a working shift. Background location
> access is used exclusively to record a worker's position for attendance verification and
> live dispatch visibility while they are clocked in — this is the app's core function, and the
> feature is unusable without it (the whole point of the app is to track on-duty location
> without requiring the worker to keep the screen open).
>
> Location is never collected outside of a clocked-in shift: the background service starts only
> when the worker punches in and stops automatically when they punch out (see
> `LocationTrackingService`/`DropxOnePlugin` — `startBackgroundLocation()`/
> `stopBackgroundLocation()`, called from the same shift punch-in/out flow as the rest of the
> attendance system). Before background location is ever requested, the app shows an explicit
> in-app disclosure (see screenshot/recording below) telling the worker exactly what is
> collected, why, and when it stops, and requires them to acknowledge it before the OS
> permission prompt appears.
>
> This data is used only by the worker's employer for attendance and dispatch purposes and is
> never sold or shared with third parties.

**What Google will likely ask for alongside this text:**
- A short screen recording showing: (1) the in-app consent/disclosure screen appearing before
  the permission prompt, (2) the permission being granted, (3) the app actually using location
  for its stated purpose (e.g. the live attendance/dispatch view showing the worker's position).
- Confirm the exact wording of the in-app disclosure matches what's declared here — Google
  checks for this consistency specifically (this is what the existing `com.dropxlogistics.one`
  listing got rejected for on 31 Aug 2026 — see the two Policy Center issues: "Feature doesn't
  meet requirements to access location in the background" and "Missing Prominent Disclosure").
  This app's `DropxOnePlugin.showConsentThenRequestInitialPermission()` dialog already exists
  and reads:
  > "Location while you're on duty" / "DropX One shares your location with your employer while
  > you're clocked in, for attendance and dispatch purposes. It keeps running in the background
  > during your shift, even if you close the app, and stops when you're off the clock."

## Privacy policy URL — NOT drafted here, needs an explicit decision

Required for any submission (new listing or update) requesting location. This needs to be a
real, publicly reachable page describing what's collected and why — worth checking first whether
the existing `com.dropxlogistics.one` listing already has one on file (Play Console → your app →
Store presence → Store listing → Privacy Policy field) that can be reused/updated rather than
written from scratch, since it's a real company-facing legal document, not something to draft
unprompted.
