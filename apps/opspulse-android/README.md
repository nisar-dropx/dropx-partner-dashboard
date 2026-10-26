# OpsPulse Android

Signed Trusted Web Activity for https://ops.dropxlogistics.com, sharing the production web experience and browser-managed Google sign-in. Package `com.dropxlogistics.opspulse` and the original signing key are retained for in-place updates. Version 2.1.0 (code 3) requires Android 7.0+. Uses Android Browser Helper 2.7.4, compile/target SDK 36.

## Build

Use Java 17 and Android SDK 36. Set `JAVA_HOME`, `ANDROID_HOME`, `OPSPULSE_KEYSTORE` and `OPSPULSE_KEYSTORE_PASSWORD_FILE` to local private files. The key alias is `opspulse`. Do not commit signing material or create a replacement key.

```sh
./gradlew assembleRelease --no-daemon
```

Before publishing, run Android SDK `apksigner verify --verbose --print-certs` and `aapt dump badging` against `app/build/outputs/apk/release/app-release.apk`. Confirm the certificate matches `public/.well-known/assetlinks.json` and the package/version match this project. Copy the verified APK to `public/downloads/DropX-OpsPulse.apk`, regenerate its size/SHA-256/version metadata in `public/downloads/opspulse-android.json`, and run `node scripts/verify-opspulse-app.mjs` from the repository root.

The branded splash, adaptive icon, verified HTTPS app links and notification delegation are packaged. Authenticated data stays online-only; the service worker stores static assets and a generic offline recovery page. The notification permission alone does not enable push delivery—existing server notification configuration still applies.

## Device release checks

Install the prior APK, upgrade to the new APK, and check the app icon, splash, full-screen verified origin, Google sign-in, scope selection, audit attachment picker, PDF download, mobile menu, sign-out and airplane-mode recovery on a physical Android device. No device was attached during the 2026-10-20 build: signature/manifest/build checks passed, but device acceptance remains outstanding.

**Launch behavior:** The 2.1.0 package uses the solid `Theme.DeviceDefault.Light.NoActionBar` launcher theme. Verified origins open as a Trusted Web Activity; when verification is unavailable, Android Browser Helper falls back to a browser Custom Tab to retain browser-managed Google sign-in. It does not embed Google authentication in an app WebView. The previous transparent launcher theme is no longer used.

The 2026-10-27 release build, package/version, SHA-256, original certificate and web association checks passed. No physical Android device was attached; upgrade, launch, camera and sign-in acceptance on an actual device remain required.

Windows and Mac use the browser-installed web app from login or `/downloads/app`; they do not use this APK and no unsigned EXE/DMG is distributed.
