# DropX One Android

DropX One Android is a Trusted Web Activity for `https://one.dropxlogistics.com`.
The web product remains the single source of truth, so normal DropX One web releases appear in the Android app without rebuilding the APK.

## Release identity

- Package: `com.dropxlogistics.one`
- Version: `2.0.0` (`20000`)
- Host: `one.dropxlogistics.com`
- Signing alias: `dropx-one-release`

The release keystore is intentionally outside Git. On the release Mac it is stored at:

`../../../../private/dropx-one-android/dropx-one-release.keystore`

Its password is stored in macOS Keychain under service `com.dropxlogistics.one.signing` and account `dropx-one-release`. Back up the keystore and credential together; future APKs must use the same signing key.

## Build

Install Bubblewrap, then run from this directory:

```sh
bubblewrap build
```

Copy `app-release-signed.apk` to the versioned path under `apps/connect/public/downloads`, calculate its SHA-256, and update `apps/connect/src/lib/dropx-one-release.ts`.

## Full-screen verification

Android verifies the app/site ownership through:

`https://one.dropxlogistics.com/.well-known/assetlinks.json`

Keep the package and certificate fingerprint in that file aligned with this APK. If verification fails, Android deliberately opens a browser custom tab with visible browser controls.
