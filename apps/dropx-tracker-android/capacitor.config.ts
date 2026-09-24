import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The website is the UI, always. This app never ships its own screens — the WebView
 * just loads one.dropxlogistics.com (same app.connect deploy the dropx-one-android TWA
 * points at) and stays that way; UI changes ship by deploying apps/connect, never by
 * rebuilding this app. The only thing native code here does is the DropxOne plugin's
 * background location service (see android/app/src/main/java/.../DropxOnePlugin.kt),
 * which connect-native-bridge.tsx already calls today.
 */
const config: CapacitorConfig = {
  // Ships as an update to the existing live Play Store listing (com.dropxlogistics.one) —
  // must match android/app/build.gradle's applicationId AND namespace, and the Java package
  // the native source actually lives in (com.dropxlogistics.one) — all kept identical.
  appId: "com.dropxlogistics.one",
  appName: "DropX One",
  webDir: "www",
  server: {
    url: "https://one.dropxlogistics.com",
    androidScheme: "https"
  },
  android: {
    allowMixedContent: false,
    // Google rejected a release for "Device and Network Abuse policy: causing users to
    // download/install applications from unknown sources" — the actual trigger was the login
    // page's own APK-download banner (ConnectAppInstallCard, meant for browser visitors so they
    // can sideload this app before it existed on Play, or if Play access breaks). It was already
    // hidden client-side for in-app viewers via a Capacitor-in-UA sniff, but the underlying HTML
    // still contained the download link/button regardless — Play's review tooling doesn't
    // necessarily execute that client-side check, so it saw the link as present. This appended
    // UA token lets the server (see apps/connect's WorkspaceLayout) detect the native app
    // DEFINITIVELY via a header, before rendering anything, and omit that link's markup
    // entirely for native-app requests rather than just hiding it after the fact.
    appendUserAgent: "DropXOneNative/1"
  }
};

export default config;
