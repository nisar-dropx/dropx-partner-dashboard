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

# CONFIRMED root cause (ionic-team/capacitor issue #8589): R8 full mode folds
# PluginHandle.getPluginAnnotation() to always return null, because R8's static analysis can't
# see that the pluginAnnotation field is actually set via clazz.getAnnotation(...) reflection
# inside PluginHandle's constructor — from R8's point of view nothing ever writes a non-null
# value to that field, so it "optimizes" the getter to unconditionally return null. Every
# plugin's checkPermissions()/requestPermissions() then crashes Bridge.getPermissionStates()
# with a NullPointerException the instant it reads that null annotation, exactly what was
# reproduced here — confirmed happening only on release/minified builds, never on an unminified
# debug build. None of the -keep class {*;} rules tried before this fixed it because they keep
# METHODS and the CLASS shape, not R8's field-value inference specifically. This is the actual
# documented fix: explicitly keep PluginHandle's relevant fields/methods as a unit so R8 can no
# longer treat pluginAnnotation as provably-always-null.
-keep @interface com.getcapacitor.annotation.**
-keep @interface com.getcapacitor.PluginMethod
-keepclassmembers class com.getcapacitor.PluginHandle {
  java.lang.Class pluginClass;
  com.getcapacitor.annotation.CapacitorPlugin pluginAnnotation;
  com.getcapacitor.NativePlugin legacyPluginAnnotation;
  com.getcapacitor.annotation.CapacitorPlugin getPluginAnnotation();
}
-keepattributes *Annotation*
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keep class com.capacitorjs.plugins.pushnotifications.** { *; }

# play-services-location and androidx.work also do some of their own reflection-based
# component lookup (Services/Receivers started by class reference from the manifest).
-keep class com.google.android.gms.location.** { *; }

