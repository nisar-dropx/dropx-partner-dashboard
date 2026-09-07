import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (path, encoding) => readFile(resolve(root, path), encoding);
const assert = (condition, message) => {
  if (!condition) throw new Error(`DropX One native release verification failed: ${message}`);
};

const releaseSource = await read("apps/connect/src/lib/dropx-one-release.ts", "utf8");
const webManifest = JSON.parse(await read("apps/connect/public/manifest.webmanifest", "utf8"));
const assetLinks = JSON.parse(await read("apps/connect/public/.well-known/assetlinks.json", "utf8"));
const twaManifest = JSON.parse(await read("apps/dropx-one-android/twa-manifest.json", "utf8"));

const value = (key) => releaseSource.match(new RegExp(`${key}: \\\"([^\\\"]+)\\\"`))?.[1] ?? "";
const version = value("version");
const packageName = value("packageName");
const apkUrl = value("apkUrl");
const expectedHash = value("apkSha256");

assert(version === "2.0.0", "release version must be 2.0.0");
assert(packageName === "com.dropxlogistics.one", "release package is incorrect");
assert(apkUrl === `/downloads/DropX-One-${version}.apk`, "APK URL must remain versioned");
assert(/^[a-f0-9]{64}$/.test(expectedHash), "APK SHA-256 is missing or malformed");

const apk = await read(`apps/connect/public${apkUrl}`);
assert(apk.length > 1_000_000, "APK is unexpectedly small");
assert(apk.subarray(0, 2).toString("hex") === "504b", "APK is not a ZIP-compatible Android package");
assert(createHash("sha256").update(apk).digest("hex") === expectedHash, "APK checksum does not match release metadata");

assert(webManifest.id === "/", "web manifest needs a stable application id");
assert(webManifest.start_url === "/?source=android-app", "web and Android launch URLs must match");
assert(webManifest.display === "standalone", "web manifest must launch without browser chrome");
assert(webManifest.icons?.some((icon) => icon.sizes === "512x512"), "web manifest needs a 512px launcher icon");
assert(webManifest.icons?.some((icon) => icon.purpose === "maskable"), "web manifest needs a maskable launcher icon");

assert(twaManifest.packageId === packageName, "TWA package differs from release metadata");
assert(twaManifest.host === "one.dropxlogistics.com", "TWA host is not DropX One");
assert(twaManifest.appVersionName === version, "TWA version differs from release metadata");
assert(twaManifest.appVersionCode === 20000, "TWA version code is incorrect");
assert(!JSON.stringify(twaManifest).includes("127.0.0.1"), "TWA manifest contains a local development URL");

const association = assetLinks.find((item) => item?.target?.package_name === packageName);
assert(association, "Digital Asset Links does not include the Android package");
assert(association.target.sha256_cert_fingerprints?.includes("44:FF:57:8E:D5:30:9C:2E:B9:56:65:A4:DA:4F:A5:EB:21:00:12:56:B4:5C:23:50:6D:E8:93:54:39:B2:1E:61"), "Digital Asset Links fingerprint differs from the signed APK");

const serviceWorker = await read("apps/connect/public/sw.js", "utf8");
assert(serviceWorker.includes('url.pathname.startsWith("/api/")'), "service worker must explicitly exclude APIs from caching");
assert(serviceWorker.includes('request.mode === "navigate"'), "service worker needs network-first navigation handling");

console.log(`DropX One native release verified: ${packageName} ${version}, signed APK ${Math.round(apk.length / 1024)} KB.`);
