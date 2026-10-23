# OpsPulse Android

Signed Trusted Web Activity for https://ops.dropxlogistics.com, sharing the production web experience and browser-managed Google sign-in. Package `com.dropxlogistics.opspulse` and the original signing key are retained for in-place updates. Version 2.0.0 (code 2) requires Android 7.0+. Uses Android Browser Helper 2.7.4, compile/target SDK 36.

## Build

Use Java 17 and Android SDK 36. Set `JAVA_HOME`, `ANDROID_HOME`, `OPSPULSE_KEYSTORE` and `OPSPULSE_KEYSTORE_PASSWORD_FILE` to local private files. The key alias is `opspulse`. Do not commit signing material or create a replacement key.

```sh
./gradlew assembleRelease --no-daemon
```

Before publishing, run Android SDK `apksigner verify --verbose --print-certs` and `aapt dump badging` against `app/build/outputs/apk/release/app-release.apk`. Confirm the certificate matches `public/.well-known/assetlinks.json` and the package/version match this project. Copy the verified APK to `public/downloads/DropX-OpsPulse.apk`, regenerate its size/SHA-256/version metadata in `public/downloads/opspulse-android.json`, and run `node scripts/verify-opspulse-app.mjs` from the repository root.

The branded splash, adaptive icon, verified HTTPS app links and notification delegation are packaged. Authenticated data stays online-only; the service worker stores static assets and a generic offline recovery page. The notification permission alone does not enable push delivery—existing server notification configuration still applies.

## Device release checks

Install the prior APK, upgrade to the new APK, and check the app icon, splash, full-screen verified origin, Google sign-in, scope selection, audit attachment picker, PDF download, mobile menu, sign-out and airplane-mode recovery on a physical Android device. No device was attached during the 2026-10-20 build: signature/manifest/build checks passed, but device acceptance remains outstanding.

**Auto-close note:** `Theme.Translucent.NoTitleBar` plus `FALLBACK_STRATEGY=customtabs` caused the shell to open then exit when Digital Asset Links were not verified (Custom Tab closed → LauncherActivity finished). The package now uses a solid day/night theme and `webview` fallback so the shell stays open. Until a rebuilt signed APK is published, tell users to install via Chrome → Install app / Add to Home screen on `ops.dropxlogistics.com` (see login UI).

Windows and Mac use the browser-installed web app from login or `/downloads/app`; they do not use this APK and no unsigned EXE/DMG is distributed.
