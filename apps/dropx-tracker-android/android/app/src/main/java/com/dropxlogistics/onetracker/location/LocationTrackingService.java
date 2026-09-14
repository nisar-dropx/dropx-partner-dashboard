package com.dropxlogistics.onetracker.location;

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
import android.os.Build;
import android.os.IBinder;
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
  private static final int NOTIFICATION_ID = 4471;
  private static final int LOCATION_OFF_NOTIFICATION_ID = 4472;
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
    refreshLocationEnabledAlert();
    // START_STICKY: if the OS kills this process under memory pressure, restart it with
    // a null intent — onStartCommand re-reads TrackingPrefs itself, so tracking resumes.
    return START_STICKY;
  }

  private void refreshLocationEnabledAlert() {
    LocationManager locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
    boolean enabled = locationManager != null && LocationManagerCompat.isLocationEnabled(locationManager);
    NotificationManagerCompat notifications = NotificationManagerCompat.from(this);
    if (enabled) {
      notifications.cancel(LOCATION_OFF_NOTIFICATION_ID);
    } else {
      notifications.notify(LOCATION_OFF_NOTIFICATION_ID, buildLocationOffAlert());
    }
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
      .setSmallIcon(getApplicationInfo().icon)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      // Not swipe-dismissible on purpose — this only goes away once Location is back on
      // (refreshLocationEnabledAlert cancels it from the MODE_CHANGED_ACTION receiver above),
      // not because the worker dismissed the warning without fixing it.
      .setOngoing(true)
      .setContentIntent(openLocationSettings)
      .build();
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
      Log.w(TAG, "Location permission missing when starting updates.", e);
      stopSelf();
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
      boolean developerModeOn = android.provider.Settings.Secure.getInt(
        getContentResolver(),
        android.provider.Settings.Secure.DEVELOPMENT_SETTINGS_ENABLED,
        0
      ) != 0;
      boolean mockLocation = location.isFromMockProvider();
      String integritySignals = "{\"clientPlatform\":\"android-native\""
        + ",\"developerMode\":" + developerModeOn
        + ",\"mockLocation\":" + mockLocation
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
      }
    } catch (Exception e) {
      Log.w(TAG, "Location heartbeat failed, will retry on next interval.", e);
    } finally {
      if (connection != null) connection.disconnect();
    }
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

    Intent openApp = new Intent(this, com.dropxlogistics.onetracker.MainActivity.class);
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
    // The alert is specifically about tracking being unable to run right now — once the
    // service itself has stopped (tracking turned off from the app, not from Location
    // settings), the warning no longer applies either.
    NotificationManagerCompat.from(this).cancel(LOCATION_OFF_NOTIFICATION_ID);
    uploadExecutor.shutdown();
  }

  @Nullable
  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }
}
