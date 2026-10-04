# DropX Fleet Android

Native Flutter client for DropX Fleet. The app uses native navigation, lists,
filters, forms and approval actions; it does not embed the web portal. It keeps a
secure server session, respects the same company, station and role permissions as
the Fleet portal, and caches the latest snapshot for fast reopening.

Build with Flutter 3.24+ and an Android SDK. Supply the public Supabase project
configuration as Dart defines; secrets must never be embedded in the APK:

```sh
flutter pub get
flutter analyze
flutter build apk --release \
  --dart-define=SUPABASE_URL="$NEXT_PUBLIC_SUPABASE_URL" \
  --dart-define=SUPABASE_ANON_KEY="$NEXT_PUBLIC_SUPABASE_ANON_KEY"
```

The Android OAuth redirect is `com.dropxlogistics.fleet://login-callback`; add it
to the Supabase redirect allowlist. The direct-download rollout APK uses the
Android development key so it installs immediately. Replace that signing config
with the DropX Play upload key before publishing to Google Play; keystores remain
excluded from source control.
