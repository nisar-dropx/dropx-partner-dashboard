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

## Signing a release build

```sh
cp android/keystore.properties.example android/keystore.properties
# edit keystore.properties, filling in the real storePassword/keyPassword
cd android
./gradlew assembleRelease
```

The real keystore lives at `production/private/dropx-tracker-android/dropx-tracker-release.keystore`
— outside any git repo (`production/` itself has no `.git`), matching `apps/dropx-one-android`'s
convention. `keystore.properties` (gitignored) holds its password; `keystore.properties.example`
(committed) documents the shape for anyone setting up a new machine to build releases. **Back
the keystore + password up somewhere durable** (a password manager, a second secure location) —
if it's ever lost, this app can never be updated again under `com.dropxlogistics.onetracker`
without every device uninstalling and reinstalling fresh.

Distribution today is self-hosted, following `apps/dropx-one-android`'s pattern: build the
signed APK above, then wire up an equivalent of that app's `dropx-one-release.ts` +
`/api/app-release` + `public/downloads/*.apk` in `apps/connect` when you're ready to publish a
download link. A Play Store release is a separate, mostly non-code effort (developer account,
public privacy policy URL, Data Safety form disclosing location collection, and a Permissions
Declaration justifying background location for a workforce-tracking app — Play's strictest
review tier).

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

`MainActivity.java` keeps the WebView non-edge-to-edge (`WindowCompat.setDecorFitsSystemWindows`)
so Android reserves the real status-bar and nav-bar space itself — always correct on every
device, no per-device measuring needed. To match, `globals.css`'s `html.native-app` block sets
both `--dx-safe-top` and `--dx-safe-bottom` to `0px`, so the header/bottom-nav don't *also* add
padding on top of that native reservation (the double-reservation bug this replaced). That CSS
block has been silently reverted once already by an unrelated feature merge built on a stale
copy of the file (a block-move, not a line conflict, so git didn't flag it) — if the header/nav
ever look wrong again, check `git log -S "dx-safe-top: 0px" -- apps/connect/app/globals.css`
before assuming it's a new bug. Diagnose via `chrome://inspect` (or `adb forward` to the
`webview_devtools_remote_<pid>` socket) — that's how the original gap/clip bugs here were
actually found, not by guessing.

## Later, with company credentials: Firebase and Google Play

Not started — both need real accounts/credentials that weren't available when this app was
built. Written down here so the exact steps aren't re-derived from scratch later.

### Firebase project → unlocks push notifications + crash reporting

1. Create a Firebase project at <https://console.firebase.google.com> (or add this app to an
   existing DropX Logistics Firebase project, if one already exists for another product).
2. Add an Android app inside it with package name **`com.dropxlogistics.onetracker`** — must
   match exactly, or push tokens/crash reports won't resolve to this app.
3. Download the generated `google-services.json`, place it at
   `android/app/google-services.json` (that exact path — `app/build.gradle` already has a
   `try { file('google-services.json')... }` block that auto-applies the Google Services
   Gradle plugin only when the file exists; no `build.gradle` edit needed).
4. For push notifications: `npm install @capacitor/push-notifications@6 && npx cap sync android`,
   then rebuild. This plugin was deliberately removed earlier (see the section below) because
   calling `PushNotifications.register()` without a Firebase project crashes the whole app —
   safe to re-add once `google-services.json` is real.
5. For crash reporting: `npm install @capacitor/firebase-crashlytics` (or the equivalent Capacitor
   Community plugin — there's no first-party Capacitor Crashlytics plugin as of writing) and
   initialize it in `MainActivity.onCreate()`. Nothing else in this app depends on this, so it
   can be added independently of push notifications.

### Google Play Store path

**Decision already made: update the existing live "DropX One" listing (package
`com.team.dropxlogistics`, published by a colleague under the developer name "Helixcer",
100+ installs, last updated Aug 5 2026) rather than publish this app as a new, separate
listing.** That keeps the current Play Store URL, install count, and reviews, but has one hard
consequence worth stating plainly: **a Play Store app's package name (`applicationId`) can
never be changed once published.** This app was built as `com.dropxlogistics.onetracker` — to
become an update to the existing listing, it has to be rebuilt with `applicationId
"com.team.dropxlogistics"` in `android/app/build.gradle`, **signed with that same listing's
original upload key** (not the `dropx-tracker-release.keystore` this repo generated), and given
a `versionCode` higher than whatever the currently-published version already has. None of that
is optional — Play rejects an upload whose package name or signing certificate doesn't match
the existing listing, with no override.

**What to ask your colleague for, concretely** (his laptop crash is exactly why this needs to be
asked now, before it's needed under time pressure):

1. **The original upload keystore file** (a `.jks` or `.keystore` file) used to sign the
   currently-published "DropX One" build, plus its store password, key alias, and key password.
   Without this exact file, Play Store permanently refuses any future update to this listing —
   there is no recovery path from Google if it's genuinely lost (this is why this repo's own new
   keystore is backed up outside git, per the note above — the same discipline matters here).
   If he genuinely cannot recover it (laptop crash, no backup), the fallback is Play App
   Signing's *upload key reset* request, which Google requires supporting evidence for and
   which is not fast or guaranteed to succeed — worth asking him to check this file exists
   *before* assuming it needs a reset.
2. **Play Console access** — either he adds you (or the account you'll use going forward) as a
   user with Release Manager/Admin access on that developer account (Play Console → Users and
   permissions), or he does the upload himself once you hand him the signed AAB/APK built below.
   Google's own account-transfer process (moving the whole app to a different Play Console
   account entirely) is a separate, slower, more involved option — only worth it if he's leaving
   the company/project entirely, not for a routine handoff.
3. **Whether Play App Signing is enabled** for this listing (Play Console → your app → Setup →
   App integrity → App signing). If it is (Google's default for anything published after ~2021),
   Google holds the real signing key and only needs the *upload* key to match — meaningfully
   lowers the stakes if the original upload key genuinely can't be recovered, since Play App
   Signing supports a formal upload-key-reset flow in that case. If it's *not* enabled, the
   original keystore is the only thing standing between "can still update this app" and
   "permanently orphaned listing," so confirm this either way.
4. **The current live `versionCode`** (Play Console → your app → Release → Production, or ask
   him directly) so this app's `android/app/build.gradle` can be set higher than it, per Play's
   requirement that every new upload strictly increases `versionCode`.

**Then, to actually publish the update:**

1. In this repo, change `apps/dropx-tracker-android/android/app/build.gradle`:
   `applicationId "com.team.dropxlogistics"` (replacing `com.dropxlogistics.onetracker`), and
   `versionCode` set higher than the value from step 4 above.
2. Re-sign using the recovered original keystore (update `keystore.properties` to point at that
   file instead of `dropx-tracker-release.keystore`, and swap in its real
   password/alias/keyPassword) — **do not use this repo's own generated keystore for this
   listing**, only for `com.dropxlogistics.onetracker` if it's ever published as its own separate
   app later.
3. `./gradlew bundleRelease` (Play Store submissions want an `.aab` App Bundle, not the `.apk`
   this repo builds for the self-hosted download link — same signing config, different Gradle
   task) and upload the resulting `.aab` in Play Console → Release → Production → Create new
   release.
4. **Play Console account/policy items still needed regardless of who uploads:**
   - **A public privacy policy URL** — required for any app requesting location, must describe
     what's collected (background location while clocked in) and why. Doesn't need to be
     complex, but must be a real, publicly reachable page, not a placeholder. Check whether the
     existing listing already has one on file (Play Console → your app → Store presence → Store
     listing) before writing a new one.
   - **Data Safety form** (inside Play Console) — discloses that location data is collected,
     who it's shared with (nobody outside the company), and whether it's used for anything
     beyond the stated purpose. The existing listing already has one filled in for whatever the
     old app collected; it needs updating now that background location tracking is a new/changed
     data type this app collects that the old one may not have.
   - **Permissions Declaration for background location** — Play's strictest review tier.
     Google requires a specific justification for `ACCESS_BACKGROUND_LOCATION` and may ask for
     a short screen-recording demonstrating the core feature that needs it. A workforce
     attendance/dispatch app tracking during a clocked-in shift is a legitimate, commonly
     approved use case, but expect a review round-trip (days, occasionally a rejection-and-
     resubmit cycle) rather than instant approval — and since this update introduces background
     location where the old app may not have had it, expect this specific review to trigger even
     though the listing itself already exists.

## Changing the app icon / splash screen later

Both were generated from `apps/connect/public/app-icons/icon-512.png` (the plain square mark)
and `icon-maskable-512.png` (the same mark with adaptive-icon safe-zone padding baked in) — the
same source files the website's own PWA manifest uses, so updating the brand mark there and
regenerating from it keeps everything consistent. To swap in a different image instead, point
these two source paths at whatever new PNG you want (a 512×512 square works for both if you
don't have a maskable variant) and rerun:

```js
// scripts/gen-icons.mjs (write once, keep for reuse — not currently checked in)
import sharp from "sharp";
const SRC_ICON = "<path to your 512x512 square logo>";
const SRC_MASKABLE = "<path to a maskable variant, or reuse SRC_ICON>";
const RES = "android/app/src/main/res";
const densities = [
  { dir: "mipmap-mdpi", legacy: 48, fg: 108 },
  { dir: "mipmap-hdpi", legacy: 72, fg: 162 },
  { dir: "mipmap-xhdpi", legacy: 96, fg: 216 },
  { dir: "mipmap-xxhdpi", legacy: 144, fg: 324 },
  { dir: "mipmap-xxxhdpi", legacy: 192, fg: 432 }
];
for (const d of densities) {
  await sharp(SRC_ICON).resize(d.legacy, d.legacy).png().toFile(`${RES}/${d.dir}/ic_launcher.png`);
  await sharp(SRC_ICON).resize(d.legacy, d.legacy).png().toFile(`${RES}/${d.dir}/ic_launcher_round.png`);
  await sharp(SRC_MASKABLE).resize(d.fg, d.fg).png().toFile(`${RES}/${d.dir}/ic_launcher_foreground.png`);
}
```

For the splash screen (`android/app/src/main/res/drawable*/splash.png`, 11 files across
densities/orientations — sizes are whatever's already there, `sharp`'s `.metadata()` will tell
you), composite your logo centered over a plain white canvas at each of those exact
width/height pairs. `android/app/src/main/res/values/ic_launcher_background.xml`'s single color
value is the adaptive-icon background — currently white; change that one line for a different
background color without touching any image. After regenerating, `./gradlew assembleDebug` (or
`assembleRelease`) and reinstall to see it.

## Building an iOS app from this same Capacitor project

Not started — there is no `ios/` platform folder yet, and building/signing/installing one needs
things a Windows machine structurally cannot provide. Written down here so the steps aren't
re-derived later, and so this can be handed to whoever has a Mac.

### What's required (all Apple-side, unavoidable)

1. **A Mac.** Xcode — the only tool that can build, sign, or run an iOS app — only runs on
   macOS. There's no Windows equivalent, no cross-compile path, and no way around this even for
   just testing on a real iPhone. If you or your colleague don't own one, a cloud Mac rental
   (e.g. MacinCloud, community "Mac in the cloud" services) or a friend's Mac for a single
   afternoon is enough to do the one-time setup below.
2. **An Apple Developer Program account** — $99/year, enrolled at
   <https://developer.apple.com/programs/enroll/>, tied to an Apple ID. Required for anything
   beyond the iOS Simulator: installing on a real iPhone, TestFlight, or App Store submission
   all need this. (There's a free-tier "Xcode without a paid account" path that can run the app
   on your own iPhone for 7 days at a time via a personal signing certificate — fine for a quick
   look, useless for giving the app to anyone else or for the App Store.)
3. **Xcode** (free, from the Mac App Store) installed on that Mac.

### Steps, once a Mac is available

```sh
# From this folder (apps/dropx-tracker-android), on the Mac:
npm install
npm install @capacitor/ios@6
npx cap add ios
npx cap sync ios
npx cap open ios   # opens Xcode
```

In Xcode:

1. Select the project in the sidebar → the app target → **Signing & Capabilities** tab → sign in
   with the Apple ID tied to the Developer Program membership, and let Xcode auto-manage the
   signing certificate/provisioning profile.
2. Bundle identifier must be set to exactly `com.dropxlogistics.onetracker` (matching the
   Android `applicationId` in `android/app/build.gradle`) — Xcode pre-fills something generic by
   default; change it under the target's **General** tab.
3. Location permissions: iOS needs its own permission strings in `Info.plist`
   (`NSLocationWhenInUseUsageDescription` and, for background tracking specifically,
   `NSLocationAlwaysAndWhenInUseUsageDescription`) plus the `UIBackgroundModes` → `location`
   capability checked in **Signing & Capabilities**. Capacitor's `@capacitor/geolocation` plugin
   docs cover the exact keys; this app's own background-location plugin
   (`DropxOnePlugin`/`LocationTrackingService`) is Android-only Java today and would need an
   equivalent Swift/Objective-C implementation for background tracking to work on iOS at all —
   that's real native code to write, not just a config change, and is the biggest remaining gap
   before an iOS build does what the Android app does.
4. **Icon and splash**: Xcode's asset catalog (`Assets.xcassets`) needs iOS-shaped icon sizes
   (a single 1024×1024 App Store icon, sized down automatically) — different generation than the
   Android density buckets above; regenerate from the same source logo with a tool like
   `@capacitor/assets` (`npx @capacitor/assets generate`) rather than reusing the Android PNGs
   directly.
5. **Run on a real iPhone**: plug the iPhone into the Mac via cable (or use wireless debugging),
   select it as the run target in Xcode's toolbar, and press Run — this installs a signed debug
   build directly, no App Store needed for your own test device once it's registered under the
   Developer account.

### Distribution once it builds

- **TestFlight** (Apple's beta-testing service, included in the Developer Program): upload a
  build via Xcode → **Product → Archive → Distribute App → TestFlight**, then invite testers by
  email — they install a real TestFlight app from the App Store and get your build through that,
  no cable needed. This is the iOS equivalent of the self-hosted APK download link this app
  already has on Android, and the natural first step before a public App Store listing.
- **App Store**: same Archive/Distribute flow, choosing "App Store Connect" instead of
  TestFlight, then filling in the listing (screenshots, description, privacy details — see the
  Google Play section above for the same category of information, Apple's forms ask for
  equivalent things under App Store Connect's own "App Privacy" section) and submitting for
  Apple's review (typically 1–3 days, sometimes longer for a background-location app — expect
  Apple to ask the same kind of justification question Google Play's Permissions Declaration
  does).

Sideloading without TestFlight or the App Store (installing an `.ipa` file directly, the rough
equivalent of the self-hosted Android APK) is possible but far more restricted than Android:
either it's limited to devices registered under your Developer account (max 100 per year, added
one at a time in the portal) via **Ad Hoc** distribution, or it needs an **Enterprise** Apple
Developer Program ($299/year, requires D-U-N-S business verification, and is meant for internal
company-only distribution, not general public download) — there's no equivalent of "just host
the file and let anyone download and install it" the way Android allows.
