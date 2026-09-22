package com.dropxlogistics.one.location;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.location.Location;
import android.location.LocationManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.webkit.CookieManager;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.location.LocationManagerCompat;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Foreground Service so Android keeps this alive with the app minimized or the screen
 * off — plain WebView `navigator.geolocation` calls get suspended the moment the app is
 * backgrounded, which is exactly what this exists to work around.
 *
 * Two separate destinations per GPS fix, on purpose:
 *  - /api/connect/attendance/live-position — cheap (one auth lookup + one upsert), posted on
 *    every fix (~LIVE_INTERVAL_MS) for an actually-live map.
 *  - /api/connect/attendance/location-heartbeat — the SAME compliance/anti-fraud heartbeat
 *    the web page (attendance-location-monitor.tsx) posts to (geofence, integrity flags,
 *    outside-zone duration), throttled to COMPLIANCE_INTERVAL_MS client-side to match the
 *    server's own floor — no point round-tripping a call the server would just rate-limit
 *    away.
 *
 * Auth: Capacitor's WebView shares the Android system CookieManager with native code,
 * so the dropx_connect_session cookie set by the website login (httpOnly — unreadable
 * from JS, but not from native CookieManager) is read here and sent exactly the way the
 * browser would send it. No separate device/token auth needed.
 */
public class LocationTrackingService extends Service {
  private static final String TAG = "DropxOneLocation";
  private static final String CHANNEL_ID = "dropx_one_location_tracking";
  private static final String LOCATION_OFF_CHANNEL_ID = "dropx_one_location_off_alert";
  private static final String INTERNET_OFF_CHANNEL_ID = "dropx_one_internet_off_alert";
  private static final String INTEGRITY_RISK_CHANNEL_ID = "dropx_one_integrity_risk_alert";
  private static final int NOTIFICATION_ID = 4471;
  private static final int LOCATION_OFF_NOTIFICATION_ID = 4472;
  private static final int INTEGRITY_RISK_NOTIFICATION_ID = 4473;
  private static final int INTERNET_OFF_NOTIFICATION_ID = 4474;
  /** How often GPS is sampled and the cheap live-position endpoint is posted to. */
  private static final long LIVE_INTERVAL_MS = 30 * 1000;
  /** Matches HEARTBEAT_MIN_INTERVAL_MS on the server — client-side throttle for the heavier call. */
  private static final long COMPLIANCE_INTERVAL_MS = 10 * 60 * 1000;

  private FusedLocationProviderClient fusedLocationClient;
  private LocationCallback locationCallback;
  private ExecutorService uploadExecutor;
  private String sessionId;
  private BroadcastReceiver locationModeReceiver;
  private long lastComplianceHeartbeatAt = 0L;

  // Repeating self-check (interval admin-editable, see TrackingPrefs.integrityCheckIntervalSeconds)
  // that re-notifies AND re-logs to HRMS on every tick while a problem persists — location off,
  // internet off, or developer mode / USB debugging / mock location on. Distinct from
  // postHeartbeat()'s mock/dev/VPN reporting above, which only fires alongside a real GPS fix
  // (so it's silent if Location itself is off, exactly the gap this loop closes) and only once
  // per COMPLIANCE_INTERVAL_MS (10 min) rather than the worker-visible cadence requested here.
  private final Handler integrityCheckHandler = new Handler(Looper.getMainLooper());
  private Runnable integrityCheckRunnable;
  /**
   * Debounce counters for refreshLocationEnabledAlert()/refreshInternetEnabledAlert() — a
   * single bad tick's OS reading (LocationManagerCompat.isLocationEnabled() or
   * ConnectivityManager's active-network check) can be a one-off blip rather than a real,
   * sustained problem: the OS briefly reports location/network unready for a tick right around
   * a Location/internet toggle settling, or right after LocationTrackingService itself restarts
   * (observed happening around reconnects, when connect-native-bridge.tsx's polling sync
   * re-triggers configureAttendance()/startBackgroundLocation()). Reporting on the very first
   * bad tick turned exactly those transients into real, wrongly-created attendance_integrity_flags
   * rows for a worker whose location/internet were genuinely fine. Requiring the SAME problem on
   * CONSECUTIVE_BAD_TICKS_THRESHOLD consecutive ticks before alerting/reporting filters those
   * out while still catching a real outage within one extra tick's delay.
   */
  private static final int CONSECUTIVE_BAD_TICKS_THRESHOLD = 2;
  private int consecutiveLocationOffTicks = 0;
  private int consecutiveInternetOffTicks = 0;

  @Override
  public void onCreate() {
    super.onCreate();
    fusedLocationClient = LocationServices.getFusedLocationProviderClient(this);
    uploadExecutor = Executors.newSingleThreadExecutor();
    sessionId = UUID.randomUUID().toString();

    // Tracking can only run with the device's Location setting on — if the worker (or
    // anyone) turns it off at the system level while a shift is open, put up a notification
    // that can't be swiped away, only cleared by turning Location back on, mirroring the
    // always-visible persistent notification pattern above but for a problem state instead
    // of the normal running state.
    locationModeReceiver = new BroadcastReceiver() {
      @Override
      public void onReceive(Context context, Intent intent) {
        refreshLocationEnabledAlert();
      }
    };
    registerReceiver(locationModeReceiver, new IntentFilter(LocationManager.MODE_CHANGED_ACTION));
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    startForeground(NOTIFICATION_ID, buildNotification());
    startLocationUpdates();
    startIntegrityCheckLoop();
    // START_STICKY: if the OS kills this process under memory pressure, restart it with
    // a null intent — onStartCommand re-reads TrackingPrefs itself, so tracking resumes.
    return START_STICKY;
  }

  /**
   * Runs immediately, then re-schedules itself every TrackingPrefs.integrityCheckIntervalSeconds()
   * for as long as the service is alive — reads that pref fresh on every tick (not cached at
   * loop-start) so an admin changing it in HRMS takes effect on this worker's very next check
   * without needing the app reopened. Only one loop ever runs per service instance: if this is
   * called again (onStartCommand can fire more than once per service lifetime, e.g. a second
   * startBackgroundLocation() call), the pending callback is cancelled first.
   */
  private void startIntegrityCheckLoop() {
    if (integrityCheckRunnable != null) {
      integrityCheckHandler.removeCallbacks(integrityCheckRunnable);
    }
    integrityCheckRunnable = () -> {
      runIntegrityCheck();
      long intervalMs = TrackingPrefs.integrityCheckIntervalSeconds(this) * 1000L;
      integrityCheckHandler.postDelayed(integrityCheckRunnable, intervalMs);
    };
    integrityCheckHandler.post(integrityCheckRunnable);
  }

  /**
   * The actual per-tick check: Location on/off and Internet on/off are both re-evaluated and
   * re-notified/re-reported every tick while the problem persists (not just once) — refreshLocationEnabledAlert()
   * and refreshInternetEnabledAlert() below both unconditionally notify() (not just on a
   * state change), which on Android replaces the existing notification with a fresh one, and
   * both post to HRMS on every call where the problem is present. Developer mode / USB
   * debugging / mock location are already checked on every real heartbeat (postHeartbeat());
   * this loop doesn't duplicate that GPS-dependent path, since a location fix might arrive
   * less often than this loop runs.
   */
  private void runIntegrityCheck() {
    refreshLocationEnabledAlert();
    refreshInternetEnabledAlert();
  }

  private void refreshLocationEnabledAlert() {
    LocationManager locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
    boolean enabled = locationManager != null && LocationManagerCompat.isLocationEnabled(locationManager);
    NotificationManagerCompat notifications = NotificationManagerCompat.from(this);
    if (enabled) {
      consecutiveLocationOffTicks = 0;
      notifications.cancel(LOCATION_OFF_NOTIFICATION_ID);
      return;
    }
    consecutiveLocationOffTicks++;
    if (consecutiveLocationOffTicks < CONSECUTIVE_BAD_TICKS_THRESHOLD) return;
    // notify() with the same id replaces the existing notification rather than stacking a
    // new one — safe to call unconditionally on every integrity-check tick, and is what
    // makes this "repeat" every tick instead of firing once on the MODE_CHANGED_ACTION
    // broadcast alone (that broadcast only fires on a state CHANGE, so a worker who leaves
    // Location off for the whole shift would otherwise only ever see it once).
    notifications.notify(LOCATION_OFF_NOTIFICATION_ID, buildLocationOffAlert());
    reportProblemToHrms("location_off", "Location is turned off");
  }

  private Notification buildLocationOffAlert() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      NotificationManager manager = getSystemService(NotificationManager.class);
      NotificationChannel channel = new NotificationChannel(
        LOCATION_OFF_CHANNEL_ID,
        "DropX One alerts",
        NotificationManager.IMPORTANCE_HIGH
      );
      channel.setDescription("Shown when Location is turned off and DropX One needs it back on.");
      manager.createNotificationChannel(channel);
    }

    PendingIntent openLocationSettings = PendingIntent.getActivity(
      this,
      1,
      new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS),
      PendingIntent.FLAG_IMMUTABLE
    );

    return new NotificationCompat.Builder(this, LOCATION_OFF_CHANNEL_ID)
      .setContentTitle("DropX One")
      .setContentText("Location is turned off — tap to turn it back on")
      .setStyle(new NotificationCompat.BigTextStyle().bigText(
        "Location is turned off while you're clocked in. This is being logged to HRMS — turn it " +
        "back on now or today's attendance may be marked absent."
      ))
      .setSmallIcon(getApplicationInfo().icon)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      // Not swipe-dismissible on purpose — this only goes away once Location is back on
      // (refreshLocationEnabledAlert cancels it once isLocationEnabled() is true again), not
      // because the worker dismissed the warning without fixing it.
      .setOngoing(true)
      .setContentIntent(openLocationSettings)
      .build();
  }

  /**
   * Mirrors refreshLocationEnabledAlert() for the internet-off case: Location being on doesn't
   * imply the device has a working network path, and a heartbeat/live-position POST with no
   * internet fails silently from the worker's point of view (postLivePosition/postHeartbeat
   * above only log a warning, they don't surface anything on-device) — this makes that failure
   * visible and logs it, the same way losing Location itself already is.
   */
  private void refreshInternetEnabledAlert() {
    boolean connected = isInternetConnected();
    NotificationManagerCompat notifications = NotificationManagerCompat.from(this);
    if (connected) {
      consecutiveInternetOffTicks = 0;
      notifications.cancel(INTERNET_OFF_NOTIFICATION_ID);
      // Every reportProblemToHrms() attempt made while offline necessarily fails (there's no
      // network path to send it over), and refreshInternetEnabledAlert() only calls it from the
      // !connected branch — so without this, an outage would leave HRMS with zero record that
      // it ever happened, even though the worker did see the local alert. TrackingPrefs' flag
      // (not a field on this Service — see its own doc for why) flips true the moment a send
      // attempt is made below; this fires exactly one follow-up report on the first tick
      // connectivity is confirmed back, so HRMS always gets at least one record of the outage
      // regardless of how many of the offline attempts failed to send or whether the service
      // itself got torn down and restarted in between.
      if (TrackingPrefs.isInternetOffPendingHrmsReport(this)) {
        TrackingPrefs.setInternetOffPendingHrmsReport(this, false);
        reportProblemToHrms("internet_off", "Internet was turned off and is now back on");
      }
      return;
    }
    consecutiveInternetOffTicks++;
    if (consecutiveInternetOffTicks < CONSECUTIVE_BAD_TICKS_THRESHOLD) return;
    notifications.notify(INTERNET_OFF_NOTIFICATION_ID, buildInternetOffAlert());
    TrackingPrefs.setInternetOffPendingHrmsReport(this, true);
    reportProblemToHrms("internet_off", "Internet is turned off");
  }

  private boolean isInternetConnected() {
    ConnectivityManager connectivityManager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
    if (connectivityManager == null) return true; // fail open — don't alarm on a service lookup failure
    Network activeNetwork = connectivityManager.getActiveNetwork();
    if (activeNetwork == null) return false;
    NetworkCapabilities capabilities = connectivityManager.getNetworkCapabilities(activeNetwork);
    return capabilities != null
      && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
      && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
  }

  private Notification buildInternetOffAlert() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      NotificationManager manager = getSystemService(NotificationManager.class);
      NotificationChannel channel = new NotificationChannel(
        INTERNET_OFF_CHANNEL_ID,
        "DropX One alerts",
        NotificationManager.IMPORTANCE_HIGH
      );
      channel.setDescription("Shown when internet access is off and DropX One can't report attendance/location.");
      manager.createNotificationChannel(channel);
    }

    PendingIntent openNetworkSettings = PendingIntent.getActivity(
      this,
      3,
      new Intent(Settings.ACTION_WIRELESS_SETTINGS),
      PendingIntent.FLAG_IMMUTABLE
    );

    return new NotificationCompat.Builder(this, INTERNET_OFF_CHANNEL_ID)
      .setContentTitle("DropX One")
      .setContentText("Internet is turned off — tap to turn it back on")
      .setStyle(new NotificationCompat.BigTextStyle().bigText(
        "Internet access is off while you're clocked in, so attendance/location can't be reported. " +
        "This will be logged to HRMS once connection is back — turn it on now or today's attendance " +
        "may be marked absent."
      ))
      .setSmallIcon(getApplicationInfo().icon)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setOngoing(true)
      .setContentIntent(openNetworkSettings)
      .build();
  }

  /**
   * Reports a persisting problem (location_off / internet_off) to HRMS via the same
   * tracking-interruption endpoint TrackingInterruptionReporter posts to — reused rather than
   * adding a third endpoint, since the server-side handling (open/refresh an integrity_risk
   * flag tied to the open shift) is identical regardless of which problem caused the gap.
   * Best-effort and silent on failure here by design (matches TrackingInterruptionReporter):
   * while internet is actually off every send attempt necessarily fails, and each tick's own
   * still-offline attempt is the real retry for that case. The one attempt this can't retry by
   * itself is the last one made right as the outage ends — see refreshInternetEnabledAlert()'s
   * internetOffPendingHrmsReport flag, which covers that gap with one guaranteed follow-up
   * report on the first tick connectivity is confirmed back.
   */
  private void reportProblemToHrms(String reasonCode, String reasonLabel) {
    String serverUrl = TrackingPrefs.serverUrl(this);
    String accountId = TrackingPrefs.accountId(this);
    String profileType = TrackingPrefs.profileType(this);
    if (serverUrl.isEmpty() || accountId.isEmpty() || profileType.isEmpty()) return;

    uploadExecutor.execute(() -> {
      HttpURLConnection connection = null;
      try {
        URL endpoint = new URL(serverUrl.replaceAll("/$", "") + "/api/connect/attendance/tracking-interruption");
        connection = (HttpURLConnection) endpoint.openConnection();
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(10_000);
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded; charset=utf-8");

        String cookie = CookieManager.getInstance().getCookie(serverUrl);
        if (cookie != null && !cookie.isEmpty()) {
          connection.setRequestProperty("Cookie", cookie);
        }

        String body = "accountId=" + URLEncoder.encode(accountId, "UTF-8")
          + "&profileType=" + URLEncoder.encode(profileType, "UTF-8")
          + "&reasonCode=" + URLEncoder.encode(reasonCode, "UTF-8")
          + "&reasonLabel=" + URLEncoder.encode(reasonLabel, "UTF-8");
        try (OutputStream out = connection.getOutputStream()) {
          out.write(body.getBytes(StandardCharsets.UTF_8));
        }
        int status = connection.getResponseCode();
        java.io.InputStream responseStream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        String responseBody = readStream(responseStream);
        if (status >= 400) {
          Log.w(TAG, "Problem report (" + reasonCode + ") rejected, status=" + status + ", body=" + responseBody);
        } else {
          Log.i(TAG, "Problem report (" + reasonCode + ") sent, status=" + status + ", body=" + responseBody);
        }
      } catch (Exception e) {
        Log.w(TAG, "Problem report (" + reasonCode + ") failed to send.", e);
      } finally {
        if (connection != null) connection.disconnect();
      }
    });
  }

  /**
   * Shown when the server's heartbeat response confirms it opened an attendance_integrity_flags
   * row for this shift (see postHeartbeat's integrityRiskFlagId check) — i.e. HRMS has already
   * recorded the risk, this is just making sure the worker sees it too, immediately, on the
   * device that caused it. Swipe-dismissible (unlike the location-off alert): dismissing this
   * doesn't undo the HRMS flag or retroactively fix today's attendance, so there's no ongoing
   * problem state to force the worker to acknowledge the way there is with Location being off.
   */
  private void showIntegrityRiskAlert(boolean developerMode, boolean mockLocation, boolean vpnSuspected) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      NotificationManager manager = getSystemService(NotificationManager.class);
      NotificationChannel channel = new NotificationChannel(
        INTEGRITY_RISK_CHANNEL_ID,
        "DropX One alerts",
        NotificationManager.IMPORTANCE_HIGH
      );
      channel.setDescription("Shown when a device signal (mock location, developer mode, VPN) puts today's attendance at risk.");
      manager.createNotificationChannel(channel);
    }

    java.util.List<String> reasons = new java.util.ArrayList<>();
    if (mockLocation) reasons.add("fake/mock location");
    if (developerMode) reasons.add("developer mode");
    if (vpnSuspected) reasons.add("VPN");
    String reasonText = String.join(" and ", reasons);

    Intent openApp = new Intent(this, com.dropxlogistics.one.MainActivity.class);
    PendingIntent contentIntent = PendingIntent.getActivity(this, 2, openApp, PendingIntent.FLAG_IMMUTABLE);

    Notification notification = new NotificationCompat.Builder(this, INTEGRITY_RISK_CHANNEL_ID)
      .setContentTitle("Attendance at risk")
      .setContentText("Detected " + reasonText + " — turn it off now or today's attendance may be marked absent.")
      .setStyle(new NotificationCompat.BigTextStyle().bigText(
        "Detected " + reasonText + " while you're clocked in. This has been logged to HRMS. " +
        "Turn it off now — continuing like this may result in today's attendance being marked absent."
      ))
      .setSmallIcon(getApplicationInfo().icon)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setAutoCancel(true)
      .setContentIntent(contentIntent)
      .build();
    NotificationManagerCompat.from(this).notify(INTEGRITY_RISK_NOTIFICATION_ID, notification);
  }

  private static String readStream(java.io.InputStream in) {
    try (java.util.Scanner scanner = new java.util.Scanner(in, StandardCharsets.UTF_8).useDelimiter("\\A")) {
      return scanner.hasNext() ? scanner.next() : "";
    } catch (Exception e) {
      return null;
    }
  }

  private void startLocationUpdates() {
    if (locationCallback != null) return; // already running

    LocationRequest request = new LocationRequest.Builder(Priority.PRIORITY_BALANCED_POWER_ACCURACY, LIVE_INTERVAL_MS)
      .setMinUpdateIntervalMillis(LIVE_INTERVAL_MS)
      .build();

    locationCallback = new LocationCallback() {
      @Override
      public void onLocationResult(LocationResult result) {
        Location location = result.getLastLocation();
        if (location != null) uploadLocation(location);
      }
    };

    try {
      fusedLocationClient.requestLocationUpdates(request, locationCallback, null);
      // requestLocationUpdates alone waits for the first full interval to elapse before
      // delivering anything — up to INTERVAL_MS with nothing sent. getLastLocation() usually
      // has a recent-enough cached fix already, so the first ping goes out immediately
      // instead of the worker's location silently lagging by however long is left of the
      // very first interval after a punch-in.
      fusedLocationClient.getLastLocation().addOnSuccessListener(location -> {
        if (location != null) uploadLocation(location);
      });
    } catch (SecurityException e) {
      // Deliberately NOT stopSelf() here — this used to kill the entire foreground service,
      // including startIntegrityCheckLoop()'s repeating location_off/internet_off detection,
      // for the exact scenario that loop exists to catch (GPS access failing mid-shift). A
      // worker who has Location genuinely off then got silently untracked instead of alerted,
      // with LocationTrackingService itself vanishing from dumpsys with no crash trace. Location
      // updates just don't happen until the next onStartCommand (e.g. the worker re-granting
      // permission triggers connect-native-bridge.tsx's poll to call startBackgroundLocation()
      // again) — everything else in this service, especially the integrity-check loop, keeps
      // running regardless.
      Log.w(TAG, "Location permission missing when starting updates — GPS updates paused, service stays up.", e);
    }
  }

  private void uploadLocation(Location location) {
    String serverUrl = TrackingPrefs.serverUrl(this);
    String accountId = TrackingPrefs.accountId(this);
    String profileType = TrackingPrefs.profileType(this);
    if (serverUrl.isEmpty() || accountId.isEmpty() || profileType.isEmpty()) return;
    if (!TrackingPrefs.locationTrackingEnabled(this)) return;

    uploadExecutor.execute(() -> {
      postLivePosition(serverUrl, accountId, profileType, location);

      long now = System.currentTimeMillis();
      if (now - lastComplianceHeartbeatAt >= COMPLIANCE_INTERVAL_MS) {
        lastComplianceHeartbeatAt = now;
        postHeartbeat(serverUrl, accountId, profileType, location);
      }
    });
  }

  private void postLivePosition(String serverUrl, String accountId, String profileType, Location location) {
    HttpURLConnection connection = null;
    try {
      URL endpoint = new URL(serverUrl.replaceAll("/$", "") + "/api/connect/attendance/live-position");
      connection = (HttpURLConnection) endpoint.openConnection();
      connection.setRequestMethod("POST");
      connection.setConnectTimeout(15_000);
      connection.setReadTimeout(15_000);
      connection.setDoOutput(true);
      connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded; charset=utf-8");

      String cookie = CookieManager.getInstance().getCookie(serverUrl);
      if (cookie != null && !cookie.isEmpty()) {
        connection.setRequestProperty("Cookie", cookie);
      }

      SimpleDateFormat isoFormat = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
      isoFormat.setTimeZone(TimeZone.getTimeZone("UTC"));

      StringBuilder body = new StringBuilder();
      appendField(body, "accountId", accountId);
      appendField(body, "profileType", profileType);
      appendField(body, "lat", String.valueOf(location.getLatitude()));
      appendField(body, "lng", String.valueOf(location.getLongitude()));
      appendField(body, "accuracyM", location.hasAccuracy() ? String.valueOf(location.getAccuracy()) : "");
      appendField(body, "capturedAt", isoFormat.format(new Date(location.getTime())));

      try (OutputStream out = connection.getOutputStream()) {
        out.write(body.toString().getBytes(StandardCharsets.UTF_8));
      }

      int status = connection.getResponseCode();
      if (status >= 400) {
        Log.w(TAG, "Live position rejected, status=" + status);
      }
    } catch (Exception e) {
      Log.w(TAG, "Live position post failed, will retry on next fix.", e);
    } finally {
      if (connection != null) connection.disconnect();
    }
  }

  private void postHeartbeat(String serverUrl, String accountId, String profileType, Location location) {
    HttpURLConnection connection = null;
    try {
      URL endpoint = new URL(serverUrl.replaceAll("/$", "") + "/api/connect/attendance/location-heartbeat");
      connection = (HttpURLConnection) endpoint.openConnection();
      connection.setRequestMethod("POST");
      connection.setConnectTimeout(15_000);
      connection.setReadTimeout(15_000);
      connection.setDoOutput(true);
      connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded; charset=utf-8");

      String cookie = CookieManager.getInstance().getCookie(serverUrl);
      if (cookie != null && !cookie.isEmpty()) {
        connection.setRequestProperty("Cookie", cookie);
      }

      SimpleDateFormat isoFormat = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
      isoFormat.setTimeZone(TimeZone.getTimeZone("UTC"));
      // Same anti-fraud signals the web-page heartbeat already sends (see IntegritySignals
      // in attendance-gps.ts) — the server already scores/flags on these, this just wires
      // the native side up to detect them too instead of always reporting a clean signal.
      // vpnSuspected is one the web page always hardcodes to false (browsers have no API for
      // this); Android's ConnectivityManager can actually detect it, so the native app reports
      // a real value here even though the server-side field already existed unused.
      boolean developerModeOn = android.provider.Settings.Secure.getInt(
        getContentResolver(),
        android.provider.Settings.Secure.DEVELOPMENT_SETTINGS_ENABLED,
        0
      ) != 0;
      // A separate sub-toggle from Developer Options as a whole (ADB_ENABLED can in principle
      // differ from DEVELOPMENT_SETTINGS_ENABLED on some OEM builds/Android versions), and
      // worth checking on its own: sideloaded fake-GPS apps that don't register as an official
      // Android "mock location app" (so isFromMockProvider() below doesn't catch them) are
      // most commonly installed via adb install with USB debugging on, so this is a useful
      // independent signal even when mockLocation itself comes back false.
      boolean usbDebuggingOn = android.provider.Settings.Global.getInt(
        getContentResolver(),
        android.provider.Settings.Global.ADB_ENABLED,
        0
      ) != 0;
      boolean mockLocation = location.isFromMockProvider();
      boolean vpnSuspected = isVpnActive();
      String integritySignals = "{\"clientPlatform\":\"android-native\""
        + ",\"developerMode\":" + developerModeOn
        + ",\"usbDebugging\":" + usbDebuggingOn
        + ",\"mockLocation\":" + mockLocation
        + ",\"vpnSuspected\":" + vpnSuspected
        + "}";

      StringBuilder body = new StringBuilder();
      appendField(body, "accountId", accountId);
      appendField(body, "profileType", profileType);
      appendField(body, "lat", String.valueOf(location.getLatitude()));
      appendField(body, "lng", String.valueOf(location.getLongitude()));
      appendField(body, "accuracyM", location.hasAccuracy() ? String.valueOf(location.getAccuracy()) : "");
      appendField(body, "altitudeM", location.hasAltitude() ? String.valueOf(location.getAltitude()) : "");
      appendField(body, "clientCapturedAt", isoFormat.format(new Date(location.getTime())));
      appendField(body, "sessionId", sessionId);
      appendField(body, "integritySignals", integritySignals);

      try (OutputStream out = connection.getOutputStream()) {
        out.write(body.toString().getBytes(StandardCharsets.UTF_8));
      }

      int status = connection.getResponseCode();
      if (status >= 400) {
        Log.w(TAG, "Location heartbeat rejected, status=" + status);
      } else {
        Log.i(TAG, "Location heartbeat sent (" + location.getLatitude() + "," + location.getLongitude() + "), status=" + status);
        // The one and only place this is written — see TrackingPrefs.lastHeartbeatAt()'s doc
        // for why MainActivity relies on this to detect the service having died unexpectedly.
        TrackingPrefs.setLastHeartbeatAt(this, System.currentTimeMillis());
        String responseBody = readStream(connection.getInputStream());
        // The server (route.ts) opens an attendance_integrity_flags row — visible to HRMS —
        // whenever this heartbeat's mockLocation/developerMode/vpnSuspected signals are true,
        // and echoes that back as integrityRiskFlagId. Surface the same warning locally too,
        // rather than relying on the worker to notice it in HRMS after the fact: the mock/dev
        // signals above are self-reported by this device, so it can raise the alert the instant
        // it sends them instead of waiting on a round trip the worker never sees.
        if (responseBody != null && responseBody.contains("\"integrityRiskFlagId\":\"")) {
          showIntegrityRiskAlert(developerModeOn, mockLocation, vpnSuspected);
        } else {
          NotificationManagerCompat.from(this).cancel(INTEGRITY_RISK_NOTIFICATION_ID);
        }
      }
    } catch (Exception e) {
      Log.w(TAG, "Location heartbeat failed, will retry on next interval.", e);
    } finally {
      if (connection != null) connection.disconnect();
    }
  }

  /**
   * True if the active network path is (or includes) a VPN interface. Checked fresh on every
   * heartbeat rather than cached, since a worker can connect/disconnect a VPN mid-shift.
   * ACTIVE_NETWORK_STATE is already a normal, non-dangerous permission every app effectively
   * has access to, so this needs no extra permission grant beyond what's already declared.
   */
  private boolean isVpnActive() {
    ConnectivityManager connectivityManager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
    if (connectivityManager == null) return false;
    Network activeNetwork = connectivityManager.getActiveNetwork();
    if (activeNetwork == null) return false;
    NetworkCapabilities capabilities = connectivityManager.getNetworkCapabilities(activeNetwork);
    return capabilities != null && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN);
  }

  private static void appendField(StringBuilder body, String key, String value) {
    try {
      if (body.length() > 0) body.append('&');
      body.append(key).append('=').append(URLEncoder.encode(value == null ? "" : value, "UTF-8"));
    } catch (Exception ignored) {
      // UTF-8 is always supported; unreachable.
    }
  }

  private Notification buildNotification() {
    // Android requires a foreground service using location to show a notification the whole
    // time it runs — that can't be turned off, and it shouldn't be: hiding the fact that
    // something is running at all would cross from "attendance tracking" into covert
    // surveillance. What's kept neutral here is just the WORDING — channel/notification text
    // says the app is active, not specifically that location is being read.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      NotificationManager manager = getSystemService(NotificationManager.class);
      NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "DropX One", NotificationManager.IMPORTANCE_LOW);
      channel.setDescription("Shown while DropX One is active in the background.");
      manager.createNotificationChannel(channel);
    }

    Intent openApp = new Intent(this, com.dropxlogistics.one.MainActivity.class);
    PendingIntent contentIntent = PendingIntent.getActivity(
      this,
      0,
      openApp,
      PendingIntent.FLAG_IMMUTABLE
    );

    return new NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("DropX One")
      .setContentText("Active")
      .setSmallIcon(getApplicationInfo().icon)
      .setOngoing(true)
      .setContentIntent(contentIntent)
      .build();
  }

  @Override
  public void onDestroy() {
    super.onDestroy();
    if (locationCallback != null) {
      fusedLocationClient.removeLocationUpdates(locationCallback);
      locationCallback = null;
    }
    if (locationModeReceiver != null) {
      unregisterReceiver(locationModeReceiver);
      locationModeReceiver = null;
    }
    if (integrityCheckRunnable != null) {
      integrityCheckHandler.removeCallbacks(integrityCheckRunnable);
      integrityCheckRunnable = null;
    }
    // These alerts are specifically about tracking being unable to run right now — once the
    // service itself has stopped (tracking turned off from the app, not from Location/internet
    // settings), the warnings no longer apply either.
    NotificationManagerCompat.from(this).cancel(LOCATION_OFF_NOTIFICATION_ID);
    NotificationManagerCompat.from(this).cancel(INTERNET_OFF_NOTIFICATION_ID);
    uploadExecutor.shutdown();
  }

  @Nullable
  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }
}
