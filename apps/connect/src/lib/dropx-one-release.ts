// Points the login page's download banner (connect-app-install-card.tsx) at the
// Capacitor-based tracker app (apps/dropx-tracker-android) instead of the original
// apps/dropx-one-android Trusted Web Activity. The TWA's own APK stays published at its old
// URL (DropX-One-2.0.0.apk) in case anything else still links to it directly, but nothing in
// this app references it anymore -- this file is the only thing the banner reads from.
//
// packageName/version/versionCode/apkSha256 must stay in sync with
// apps/dropx-tracker-android/android/app/build.gradle and the checksummed file at apkUrl --
// scripts/verify-dropx-one-native.mjs enforces this at build time. As of this release, the
// Java package was renamed from com.dropxlogistics.onetracker to com.dropxlogistics.one so
// this app ships as an update to the existing live Play Store listing "DropX One" (confirmed
// against Play Console's App Signing page fingerprint, not the org chart / informal naming --
// legacyPlayStorePackage below was previously guessed as com.team.dropxlogistics before that
// verification).
export const dropxOneRelease = {
  appName: "DropX One",
  packageName: "com.dropxlogistics.one",
  version: "4.1.0",
  versionCode: 10,
  apkUrl: "/downloads/DropX-One-Tracker-4.1.0.apk",
  apkSha256: "e21f88ed4a74c2a47aa8b4d07a6e830c7c96c43a00755ab5d27f1b3494f27a64",
  releasedAt: "2026-09-21T15:40:00+05:30",
  rolloutPolicy: "coexist" as const,
  legacyPlayStorePackage: "com.dropxlogistics.one"
};
