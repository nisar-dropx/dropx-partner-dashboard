package com.dropxlogistics.onetracker.location;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Backing store for what connect-native-bridge.tsx's configureAttendance() sent down,
 * so LocationTrackingService (running in its own process lifecycle, independent of the
 * WebView/JS) knows who it's posting pings for, and BootReceiver knows whether to
 * restart tracking after a reboot.
 */
final class TrackingPrefs {
  private static final String PREFS_NAME = "dropx_one_tracking";
  private static final String KEY_ACCOUNT_ID = "accountId";
  private static final String KEY_PROFILE_TYPE = "profileType";
  private static final String KEY_SERVER_URL = "serverUrl";
  private static final String KEY_ENABLED = "locationTrackingEnabled";
  private static final String KEY_RUNNING = "trackingRunning";
  private static final String KEY_REQUESTED_INITIAL_PERMISSION = "requestedInitialLocationPermission";

  private TrackingPrefs() {}

  private static SharedPreferences prefs(Context context) {
    return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
  }

  static void save(Context context, String accountId, String profileType, String serverUrl, boolean enabled) {
    prefs(context).edit()
      .putString(KEY_ACCOUNT_ID, accountId)
      .putString(KEY_PROFILE_TYPE, profileType)
      .putString(KEY_SERVER_URL, serverUrl)
      .putBoolean(KEY_ENABLED, enabled)
      .apply();
  }

  static void setRunning(Context context, boolean running) {
    prefs(context).edit().putBoolean(KEY_RUNNING, running).apply();
  }

  static boolean wasRunning(Context context) {
    return prefs(context).getBoolean(KEY_RUNNING, false);
  }

  static boolean locationTrackingEnabled(Context context) {
    return prefs(context).getBoolean(KEY_ENABLED, false);
  }

  static String accountId(Context context) {
    return prefs(context).getString(KEY_ACCOUNT_ID, "");
  }

  static String profileType(Context context) {
    return prefs(context).getString(KEY_PROFILE_TYPE, "");
  }

  static String serverUrl(Context context) {
    return prefs(context).getString(KEY_SERVER_URL, "");
  }

  static boolean hasRequestedInitialLocationPermission(Context context) {
    return prefs(context).getBoolean(KEY_REQUESTED_INITIAL_PERMISSION, false);
  }

  static void setRequestedInitialLocationPermission(Context context, boolean requested) {
    prefs(context).edit().putBoolean(KEY_REQUESTED_INITIAL_PERMISSION, requested).apply();
  }
}
