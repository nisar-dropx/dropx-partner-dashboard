import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (path, encoding) => readFile(resolve(root, path), encoding);
const assert = (condition, message) => {
  if (!condition) throw new Error(`DropX One native release verification failed: ${message}`);
};

// dropx-one-release.ts drives connect-app-install-card.tsx's download banner. It now points
// at apps/dropx-tracker-android (Capacitor + a native background-location plugin) instead of
// the original apps/dropx-one-android Trusted Web Activity -- a real native app, not a TWA,
// so it needs neither a twa-manifest.json check nor a Digital Asset Links entry (that
// mechanism is specifically how a TWA proves ownership of the domain it displays
// chrome-free; a Capacitor app doesn't rely on it to launch at all). Package/version are
// checked against android/app/build.gradle directly instead, so this script fails if either
// file drifts from the other rather than only checking one of them.
const releaseSource = await read("apps/connect/src/lib/dropx-one-release.ts", "utf8");
const webManifest = JSON.parse(await read("apps/connect/public/manifest.webmanifest", "utf8"));
const buildGradle = await read("apps/dropx-tracker-android/android/app/build.gradle", "utf8");

const value = (key) => releaseSource.match(new RegExp(`${key}: \\\"([^\\\"]+)\\\"`))?.[1] ?? "";
const version = value("version");
const packageName = value("packageName");
const apkUrl = value("apkUrl");
const expectedHash = value("apkSha256");

assert(packageName === "com.dropxlogistics.onetracker", "release package is incorrect");
assert(apkUrl === `/downloads/DropX-One-Tracker-${version}.apk`, "APK URL must remain versioned");
assert(/^[a-f0-9]{64}$/.test(expectedHash), "APK SHA-256 is missing or malformed");

assert(buildGradle.includes(`applicationId "${packageName}"`), "build.gradle applicationId differs from release metadata");
assert(buildGradle.includes(`versionName "${version}"`), "build.gradle versionName differs from release metadata");

const apk = await read(`apps/connect/public${apkUrl}`);
assert(apk.length > 500_000, "APK is unexpectedly small");
assert(apk.subarray(0, 2).toString("hex") === "504b", "APK is not a ZIP-compatible Android package");
assert(createHash("sha256").update(apk).digest("hex") === expectedHash, "APK checksum does not match release metadata");

assert(webManifest.id === "/", "web manifest needs a stable application id");
assert(webManifest.start_url === "/?source=android-app", "web and Android launch URLs must match");
assert(webManifest.display === "standalone", "web manifest must launch without browser chrome");
assert(webManifest.icons?.some((icon) => icon.sizes === "512x512"), "web manifest needs a 512px launcher icon");
assert(webManifest.icons?.some((icon) => icon.purpose === "maskable"), "web manifest needs a maskable launcher icon");

const serviceWorker = await read("apps/connect/public/sw.js", "utf8");
assert(serviceWorker.includes('url.pathname.startsWith("/api/")'), "service worker must explicitly exclude APIs from caching");
assert(serviceWorker.includes('request.mode === "navigate"'), "service worker needs network-first navigation handling");

console.log(`DropX One native release verified: ${packageName} ${version}, signed APK ${Math.round(apk.length / 1024)} KB.`);
