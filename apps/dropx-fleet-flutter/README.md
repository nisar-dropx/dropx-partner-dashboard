# DropX Fleet Android

Flutter Android shell for the responsive Fleet portal. It preserves every Fleet menu and action in the same secured web application, keeps external links in the device browser, and handles Android back navigation.

Build with a Flutter 3.24+ / Android SDK environment:

```sh
flutter pub get
flutter analyze
flutter build appbundle --release
```

The production app URL is defined in `lib/main.dart`. Signing configuration must be supplied by the release pipeline; keystores are intentionally excluded from source control.
