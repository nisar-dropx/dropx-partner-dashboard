# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# Capacitor's Bridge dispatches JS calls to native plugin methods by MATCHING METHOD NAME
# STRINGS via reflection (e.g. the web call Plugins.DropxOne.configureAttendance(...) has to
# find a real method literally named configureAttendance on DropxOnePlugin at runtime). R8
# renaming/stripping those methods would silently break every native call with no crash — the
# JS side would just get an error the WebView console shows, not something that surfaces on
# the device otherwise. Capacitor's own AAR may already cover this, but relying on that
# without verifying it (can't inspect a release build's WebView console the way a debug
# build's can be) isn't worth the risk for a location-tracking feature.
-keep class com.dropxlogistics.one.location.DropxOnePlugin { *; }
-keepclassmembers class * extends com.getcapacitor.Plugin {
    @com.getcapacitor.annotation.PluginMethod public *;
}
-keep class com.dropxlogistics.one.location.LocationTrackingService { *; }
-keep class com.dropxlogistics.one.location.BootReceiver { *; }
-keep class com.dropxlogistics.one.location.TrackingInterruptionReporter { *; }
-keep class com.dropxlogistics.one.MainActivity { *; }

# getPermissionStates() (called by every plugin's checkPermissions()/requestPermissions(), our
# own and any bundled Capacitor plugin like @capacitor/push-notifications) reads the
# @CapacitorPlugin/@Permission ANNOTATIONS on a plugin class via reflection to know what
# permissions/aliases it declares — the method-name keep rule above doesn't cover that, since
# R8 can strip annotation metadata even off a class/method it otherwise keeps intact.
-keepattributes *Annotation*
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }

# PushNotificationsPlugin.requestPermissions(PluginCall) overrides Plugin's own same-named,
# same-signature, identically-@PluginMethod-annotated method — a plain -keep on the class (even
# with { *; }) still let R8's optimizer merge/devirtualize that override away in testing (it was
# confirmed absent from the R8 mapping/seeds output, and crashed getPermissionStates() with a
# NullPointerException on every release build, but never an unminified debug build). Disabling
# optimization for just this plugin's class (still allowed to be renamed/shrunk elsewhere, just
# not restructured) is what actually kept the real override intact and resolved it.
-keep class com.capacitorjs.plugins.pushnotifications.** { *; }
-keepclassmembers class com.capacitorjs.plugins.pushnotifications.** { *; }
-keep,allowshrinking,allowobfuscation class com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin

# play-services-location and androidx.work also do some of their own reflection-based
# component lookup (Services/Receivers started by class reference from the manifest).
-keep class com.google.android.gms.location.** { *; }

