# DropX Finance Android

Signed Android Trusted Web Activity for https://fin.dropxlogistics.com.

- Package: `com.dropxlogistics.finance`
- Version: `1.0.0` / `10000`, Android 7+ (API 24), target API 36.
- Google Android Browser Helper 2.6.2, AGP 8.9.1, Gradle 8.11.1, JDK 17.
- A verified origin opens without the browser toolbar. Google sign-in and external origins retain their browser security UI. No WebView password interception or additional native data permissions.
- Native launcher, branded splash, system back and safe HTTPS app links. Live views, downloads, session and permissions come from the Finance site.
- Offline mode shows a connection screen. The service worker does not cache salaries, financial pages, APIs or exports.

## Build and release

Set JAVA_HOME to JDK 17 and ANDROID_HOME to an installed SDK with platform 36 and build-tools 36.1.0. Put sdk.dir in untracked local.properties. Run `./gradlew assembleRelease --no-daemon` here. Align with zipalign, then sign the release APK with apksigner. Verify the APK certificate matches the Finance-only `/.well-known/assetlinks.json` response.

On the release Mac, the persistent Finance keystore and its password file are outside Git at `/Users/jamsheer/Documents/Codex/private/dropx-finance-android/`, with alias `dropx-finance-release`. Keep a secure backup of that directory: subsequent releases must use this same key. Never place signing files inside the repository or deployment.

Copy the signed APK to `public/downloads/DropX-Finance-<version>.apk` and update `src/lib/finance/android-release.ts` with its version, size and SHA-256. Run the Finance mobile tests and the required build chain. Follow AGENTS.md: commit/push, verify remote SHA, deploy only the Finance project, inspect routes, then promote and verify the custom domain.

The packaged app is not a separate offline accounting database. Android ownership verification requires a compatible browser and the deployed digital asset link. No Play Store publication is implied by direct APK distribution.
