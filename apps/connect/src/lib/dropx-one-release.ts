// Points the login page's download banner (connect-app-install-card.tsx) at the new
// Capacitor-based tracker app (apps/dropx-tracker-android) instead of the original
// apps/dropx-one-android Trusted Web Activity. The TWA's own APK stays published at its old
// URL (DropX-One-2.0.0.apk) in case anything else still links to it directly, but nothing in
// this app references it anymore -- this file is the only thing the banner reads from.
export const dropxOneRelease = {
  appName: "DropX One",
  packageName: "com.dropxlogistics.onetracker",
  version: "1.0.1",
  versionCode: 10001,
  apkUrl: "/downloads/DropX-One-Tracker-1.0.1.apk",
  apkSha256: "759873a0bdb863adb1ca0e10198e48864377a850b06ba88aade561f6902c7a67",
  releasedAt: "2026-09-15T11:26:00+05:30",
  rolloutPolicy: "coexist" as const,
  legacyPlayStorePackage: "com.team.dropxlogistics"
};
