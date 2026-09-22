package com.dropxlogistics.one.location;

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
  private static final String KEY_SHOWN_INITIAL_CONSENT = "requestedInitialLocationPermission";
  private static final String KEY_REQUESTED_BATTERY_EXEMPTION = "requestedBatteryExemption";
  private static final String KEY_LAST_HEARTBEAT_AT = "lastHeartbeatAt";
  private static final String KEY_INTERRUPTION_REPORTED_FOR_HEARTBEAT_AT = "interruptionReportedForHeartbeatAt";
  private static final String KEY_INTEGRITY_CHECK_INTERVAL_SECONDS = "integrityCheckIntervalSeconds";
  private static final String KEY_INTERNET_OFF_PENDING_HRMS_REPORT = "internetOffPendingHrmsReport";

  private TrackingPrefs() {}

  private static SharedPreferences prefs(Context context) {
    return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
  }

  static void save(
    Context context,
    String accountId,
    String profileType,
    String serverUrl,
    boolean enabled,
    int integrityCheckIntervalSeconds
  ) {
    prefs(context).edit()
      .putString(KEY_ACCOUNT_ID, accountId)
      .putString(KEY_PROFILE_TYPE, profileType)
      .putString(KEY_SERVER_URL, serverUrl)
      .putBoolean(KEY_ENABLED, enabled)
      .putInt(KEY_INTEGRITY_CHECK_INTERVAL_SECONDS, integrityCheckIntervalSeconds)
      .apply();
  }

  /** Admin-editable at /attendance/integrity (hr_company_settings.integrity_check_interval_seconds). */
  static int integrityCheckIntervalSeconds(Context context) {
    int seconds = prefs(context).getInt(KEY_INTEGRITY_CHECK_INTERVAL_SECONDS, 30);
    return seconds >= 15 && seconds <= 600 ? seconds : 30;
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

  static boolean hasShownInitialConsent(Context context) {
    return prefs(context).getBoolean(KEY_SHOWN_INITIAL_CONSENT, false);
  }

  static void setShownInitialConsent(Context context, boolean shown) {
    prefs(context).edit().putBoolean(KEY_SHOWN_INITIAL_CONSENT, shown).apply();
  }

  static boolean hasRequestedBatteryExemption(Context context) {
    return prefs(context).getBoolean(KEY_REQUESTED_BATTERY_EXEMPTION, false);
  }

  static void setRequestedBatteryExemption(Context context, boolean requested) {
    prefs(context).edit().putBoolean(KEY_REQUESTED_BATTERY_EXEMPTION, requested).apply();
  }

  /**
   * Written by LocationTrackingService on every successful heartbeat POST — the single
   * source of truth MainActivity's onResume gate reads to notice the service died without
   * TrackingPrefs itself ever being told (force-stop, an OEM battery killer, a crash) — see
   * MainActivity.checkForTrackingInterruption().
   */
  static void setLastHeartbeatAt(Context context, long epochMs) {
    prefs(context).edit().putLong(KEY_LAST_HEARTBEAT_AT, epochMs).apply();
  }

  static long lastHeartbeatAt(Context context) {
    return prefs(context).getLong(KEY_LAST_HEARTBEAT_AT, 0L);
  }

  /**
   * Guards against reporting the exact same interruption gap more than once — MainActivity
   * checks on every resume, which would otherwise re-report the same stale lastHeartbeatAt
   * repeatedly until the next real heartbeat lands.
   */
  static boolean hasReportedInterruptionFor(Context context, long heartbeatAtEpochMs) {
    return prefs(context).getLong(KEY_INTERRUPTION_REPORTED_FOR_HEARTBEAT_AT, -1L) == heartbeatAtEpochMs;
  }

  static void setReportedInterruptionFor(Context context, long heartbeatAtEpochMs) {
    prefs(context).edit().putLong(KEY_INTERRUPTION_REPORTED_FOR_HEARTBEAT_AT, heartbeatAtEpochMs).apply();
  }

  /**
   * See LocationTrackingService.refreshInternetEnabledAlert() — set true the moment an
   * internet_off report attempt is made while offline, cleared only after the guaranteed
   * follow-up report succeeds once connectivity is confirmed back. Persisted rather than kept
   * as a field on the Service instance because the service can be torn down and restarted
   * (observed happening around a reconnect, when connect-native-bridge.tsx's polling sync
   * re-triggers configureAttendance()/startBackgroundLocation()) before its next tick would
   * have fired the recovery report — an in-memory flag would silently lose that outage record
   * across the restart exactly the way the original unpersisted "retry on next tick" comment did.
   */
  static boolean isInternetOffPendingHrmsReport(Context context) {
    return prefs(context).getBoolean(KEY_INTERNET_OFF_PENDING_HRMS_REPORT, false);
  }

  static void setInternetOffPendingHrmsReport(Context context, boolean pending) {
    prefs(context).edit().putBoolean(KEY_INTERNET_OFF_PENDING_HRMS_REPORT, pending).apply();
  }
}
