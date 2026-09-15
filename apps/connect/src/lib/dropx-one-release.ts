// Points the login page's download banner (connect-app-install-card.tsx) at the new
// Capacitor-based tracker app (apps/dropx-tracker-android) instead of the original
// apps/dropx-one-android Trusted Web Activity. The TWA's own APK stays published at its old
// URL (DropX-One-2.0.0.apk) in case anything else still links to it directly, but nothing in
// this app references it anymore -- this file is the only thing the banner reads from.
export const dropxOneRelease = {
  appName: "DropX One",
  packageName: "com.dropxlogistics.onetracker",
  version: "1.0.0",
  versionCode: 10000,
  apkUrl: "/downloads/DropX-One-Tracker-1.0.0.apk",
  apkSha256: "74b972ce1d2b7addf8fe56a85ba5d75cf97c0eaa10b33d7d747ea8c76af8023a",
  releasedAt: "2026-09-15T06:04:00+05:30",
  rolloutPolicy: "coexist" as const,
  legacyPlayStorePackage: "com.team.dropxlogistics"
};
