# DropX One Tracker (Android)

A Capacitor shell around `https://one.dropxlogistics.com` (the same site `apps/connect`
deploys, and the same site `apps/dropx-one-android`'s Trusted Web Activity wraps) — plus one
custom native plugin, **DropxOne**, that keeps reporting a worker's GPS location in the
background even when the app is minimized, the screen is off, or the device has rebooted.

## Why this app exists, and how it differs from `apps/dropx-one-android`

`apps/dropx-one-android` is a Bubblewrap **Trusted Web Activity** — pure Chrome showing the
site full-screen, zero native code. That's enough for "the UI is always the website, never
rebuild the app," but a TWA cannot run anything once it's backgrounded: `navigator.geolocation`
in the web page gets suspended the moment Android backgrounds the tab.

This app keeps the exact same "website is the UI" property (the WebView just points at
`one.dropxlogistics.com` — see `capacitor.config.ts`'s `server.url` — so a new screen or
feature on the site ships without touching this app at all) but adds one thing a TWA
structurally can't do: a real Android foreground `Service`
(`android/app/src/main/java/com/dropxlogistics/onetracker/location/LocationTrackingService.java`)
that keeps posting location pings on its own, independent of whether the WebView is visible.

## How the pieces fit together

The website already had a native-bridge seam waiting for this
(`apps/connect/src/components/connect-native-bridge.tsx`) — it calls
`Capacitor.Plugins.DropxOne.configureAttendance(...)` then `.startBackgroundLocation()` /
`.stopBackgroundLocation()` once a worker is punched in (see that file's
`shouldRunBackgroundTracking`). This app's job is entirely to make those calls do something:

- `DropxOnePlugin.java` — the Capacitor plugin (`@CapacitorPlugin(name = "DropxOne")`),
  handles the location-permission flow and starts/stops the service.
- `LocationTrackingService.java` — a foreground `Service` (persistent notification, required
  on Android 8+) that polls `FusedLocationProviderClient` every ~2 minutes and POSTs to the
  **same** `/api/connect/attendance/location-heartbeat` endpoint the website's own foreground
  heartbeat (`attendance-location-monitor.tsx`) already posts to — reusing the same
  `attendance_location_samples` table, geofencing, and 9h/2min server-side gating. Auth is the
  same `dropx_connect_session` cookie the website login already set: Capacitor's WebView shares
  Android's system `CookieManager` with native code, and `CookieManager.getCookie()` can read
  that cookie even though it's `httpOnly` (that only blocks *JavaScript* access).
- `BootReceiver.java` — restarts the service after a reboot if tracking was left enabled.
- `MainActivity.java` — also injects the device's *real* status-bar/nav-bar inset heights into
  two CSS custom properties the site already defines for this purpose, `--dx-safe-top` and
  `--dx-safe-bottom` (see `globals.css`'s `html.native-app` block and `.dx-mobile-nav`) — Android's
  WebView doesn't wire real window insets into CSS `env(safe-area-inset-*)` the way iOS does,
  so without this the site falls back to a hardcoded guess that doesn't match every device.

## Build & run

```sh
npm install
npx cap sync android
cd android
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Signing/release for a Play Store or self-hosted APK build isn't set up yet — mirror
`apps/dropx-one-android`'s pattern (release keystore kept outside git, its own release-metadata
file + `public/downloads/*.apk` entry in `apps/connect`) when that's needed.

## Push notifications: disabled until you add a Firebase project

`connect-native-bridge.tsx` also calls `Capacitor.Plugins.PushNotifications.register()`, which
needs `@capacitor/push-notifications` **and** a real Firebase project — without one,
`register()` throws `FirebaseApp is not initialized`, and because Capacitor's plugin dispatcher
lets that crash the whole app (not just that one call), the entire app used to crash right
after login. The `@capacitor/push-notifications` plugin has been removed from this app for now
specifically to avoid that crash — `pushPlugin()` in `connect-native-bridge.tsx` already
null-guards a missing plugin (`?? null` then `if (!push) return;`), so removing it is safe and
requires no website changes.

**To re-enable push notifications once you have a Firebase project:**

1. Create a Firebase project at <https://console.firebase.google.com> (or reuse an existing
   one for DropX Logistics).
2. Inside it, add an Android app with package name **`com.dropxlogistics.onetracker`** — must
   match `capacitor.config.ts`'s `appId` and `android/app/build.gradle`'s `applicationId`
   exactly, or push tokens won't resolve.
3. Download the generated `google-services.json` and place it at
   **`android/app/google-services.json`** (this exact path — `app/build.gradle` already has a
   `try { file('google-services.json')... }` block that auto-applies the Google Services
   Gradle plugin only when that file exists, so no `build.gradle` edit is needed).
4. From this folder, run:
   ```sh
   npm install @capacitor/push-notifications@6
   npx cap sync android
   ```
5. Rebuild (`cd android && ./gradlew assembleDebug`) and reinstall. `PushNotifications.register()`
   should now succeed instead of crashing.

If you're changing the package name (`applicationId`) at some point too, redo step 2 with the
new package name — a `google-services.json` is tied to one specific package name.

## Safe-area / layout notes

`--dx-safe-top` / `--dx-safe-bottom` are injected by `MainActivity.java` on every page load
(window insets are dispatched once at launch and again on real changes like rotation, but
*not* on WebView navigation — so it has to be re-applied via a `WebViewListener.onPageLoaded`
hook, not just the one-time insets callback). If the header or bottom nav ever look wrong on a
new device, check `adb shell settings get secure location_mode` isn't the issue (unrelated) and
inspect these two custom properties via `chrome://inspect` (or `adb forward` to the
`webview_devtools_remote_<pid>` socket) rather than guessing — that's how the original gap/clip
bugs here were actually diagnosed.
