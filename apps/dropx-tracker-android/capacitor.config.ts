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
    allowMixedContent: false
  }
};

export default config;
