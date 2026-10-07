# DropX Fleet Android

The Android app opens the complete Fleet workspace in a verified Trusted Web Activity. There is one permission-scoped workflow for desktop, mobile browser and Android. Requires Android 6+ and a supported browser (current Chrome recommended); internet is required for operations. If verification/browser support is unavailable, it opens a browser tab instead of silently falling back to an insecure embedded WebView.

## Build

JDK 17, Android SDK 36, Gradle wrapper 8.11.1. Set ANDROID_HOME and JAVA_HOME. Supply FLEET_KEYSTORE, FLEET_STORE_PASSWORD, FLEET_KEY_ALIAS and FLEET_KEY_PASSWORD through secure environment variables, then run `./gradlew :app:assembleRelease :app:lintRelease`. No signing material belongs in Git.

Version 3.0.1 (3001) retains package com.dropxlogistics.fleet and the certificate of the previously distributed 2.1.0 APK for in-place upgrades. That legacy certificate has an Android Debug subject; this release itself is non-debuggable. Do not regenerate/change the key: Android would reject updates. Any future signing-key migration requires a separately planned upgrade path.

The public signing fingerprint is published on Fleet only at /.well-known/assetlinks.json. Verify it against apksigner before each release. Verify APK version, signature, debuggable flag and SHA-256, then update public/downloads/fleet-android.json and the versioned APK. Deployment must follow the workspace GitHub-first policy. Never publish unsigned builds. Existing Flutter source is retained for history; the login download points to this complete-workspace client.

Device release checks: upgrade from 2.1.0; cold/warm launch; verified full-screen domain; Google/OTP login; role scope; back navigation; camera/gallery multi-upload; PDF/Excel downloads; maps; rotation; keyboard; loss/recovery of connectivity; Android 6/current Android. Browser resize checks alone do not certify these native integration paths.

Automated package check: `node scripts/verify-fleet-android-release.mjs` from the repository root, with ANDROID_HOME and JAVA_HOME set. This checks the published file, download aliases, version, signature continuity, Digital Asset Links, release mode and icons.
