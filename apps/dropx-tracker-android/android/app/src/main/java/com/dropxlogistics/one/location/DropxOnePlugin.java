package com.dropxlogistics.one.location;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Native counterpart to connect-native-bridge.tsx's `window.Capacitor.registerPlugin("DropxOne")`
 * — that JS bridge already calls configureAttendance()/startBackgroundLocation()/
 * stopBackgroundLocation() on every account change; this plugin makes those calls do
 * something instead of silently no-op'ing (which is what happens today outside a
 * Capacitor shell). Location capture itself, and the actual HTTP posting to
 * /api/connect/attendance/location-heartbeat, lives in LocationTrackingService — this
 * class only handles permissions and starting/stopping that service.
 *
 * Background location ("Allow all the time") is MANDATORY, not optional — see
 * {@link #hasMandatoryLocationAccess}, which MainActivity's onResume calls on every foreground
 * to decide whether to show a full-screen, non-dismissible "access required" overlay blocking
 * the rest of the app. A worker who has only granted "While using the app" or "Only this time"
 * (or nothing) is blocked, because anything less cannot deliver this app's core promise:
 * attendance/dispatch location tracked through a whole shift, including whenever the app is
 * closed or the screen is off. The overlay itself, not this class, is the real enforcement —
 * this class only handles the initial explanatory prompt and the actual tracking service.
 */
@CapacitorPlugin(
  name = "DropxOne",
  permissions = {
    @Permission(
      strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION },
      alias = "location"
    ),
    @Permission(strings = { Manifest.permission.ACCESS_BACKGROUND_LOCATION }, alias = "backgroundLocation")
  }
)
public class DropxOnePlugin extends Plugin {

  @PluginMethod
  public void configureAttendance(PluginCall call) {
    String accountId = call.getString("accountId", "");
    String profileType = call.getString("profileType", "");
    String serverUrl = call.getString("serverUrl", "");
    boolean locationTrackingEnabled = Boolean.TRUE.equals(call.getBoolean("locationTrackingEnabled", false));

    if (accountId.isEmpty() || profileType.isEmpty() || serverUrl.isEmpty()) {
      call.reject("accountId, profileType and serverUrl are required.");
      return;
    }

    TrackingPrefs.save(getContext(), accountId, profileType, serverUrl, locationTrackingEnabled);

    // Resolve immediately rather than keeping this PluginCall alive across the modal consent
    // dialog below. connect-native-bridge.tsx awaits configureAttendance() and then immediately
    // calls startBackgroundLocation() — and its polling effect can call configureAttendance()
    // again (a fresh PluginCall) before the worker has tapped through a still-open dialog from
    // the previous call. Capacitor's permission machinery (getPermissionState()/
    // requestPermissionForAlias()) is tied to whichever PluginCall is currently "in flight" for
    // a given permission request; holding one call open indefinitely while a second one starts
    // a new permission request against the same alias previously crashed getPermissionStates()
    // with a NullPointerException. The dialog below now runs fully detached from any
    // PluginCall — MainActivity's onResume gate (hasMandatoryLocationAccess) is the actual
    // source of truth for whether the app can be used, independent of this call entirely.
    if (!TrackingPrefs.hasShownInitialConsent(getContext())) {
      showInitialConsentDialog();
    }

    call.resolve();
  }

  /**
   * True only when the worker has granted BOTH foreground location AND background location
   * ("Allow all the time"). Checked directly against the OS via ContextCompat — deliberately
   * NOT via Capacitor's getPermissionState(), which requires a live PluginCall context this
   * check doesn't have (MainActivity calls this from onResume, with no call in flight at all).
   */
  public static boolean hasMandatoryLocationAccess(Context context) {
    boolean foregroundGranted =
      ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
      || ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    if (!foregroundGranted) return false;

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      boolean backgroundGranted = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        == PackageManager.PERMISSION_GRANTED;
      if (!backgroundGranted) return false;
    }

    // Without POST_NOTIFICATIONS (required at runtime since Android 13), every
    // NotificationManagerCompat.notify() call — including LocationTrackingService's own
    // ongoing "Active" notification AND its "Location is turned off" alert — silently does
    // nothing. A worker could then have tracking genuinely running with zero visible warning
    // if Location gets turned off mid-shift, which defeats the whole point of that alert.
    // Required on this same gate for exactly that reason, not just location permissions.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      boolean notificationsGranted = ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS)
        == PackageManager.PERMISSION_GRANTED;
      if (!notificationsGranted) return false;
    }

    return true;
  }

  /**
   * Called by MainActivity's "Grant access" button on the blocking overlay. Plain
   * ActivityCompat request, not Capacitor's PluginCall-based flow — there's no JS-originated
   * call to tie this to (the overlay is native UI, shown when the WebView content underneath
   * isn't usable yet), and nothing here needs to report a structured result back to JS.
   * MainActivity re-checks hasMandatoryLocationAccess() itself after the OS dialog closes.
   *
   * Foreground and background location are requested as SEPARATE calls on purpose: Android
   * only offers "Allow all the time" as an option when background is requested on its own,
   * AFTER foreground is already granted. Asking for both together is exactly what surfaces
   * Android's "Only this time" quick-grant shortcut instead of the full three-way choice,
   * which is a real, not-fully-granted state this app must not treat as sufficient.
   */
  public static void requestMandatoryLocationAccess(Activity activity) {
    boolean foregroundGranted =
      ContextCompat.checkSelfPermission(activity, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
      || ContextCompat.checkSelfPermission(activity, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;

    if (!foregroundGranted) {
      ActivityCompat.requestPermissions(
        activity,
        new String[] { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION },
        FOREGROUND_LOCATION_REQUEST_CODE
      );
      return;
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
        && ContextCompat.checkSelfPermission(activity, Manifest.permission.ACCESS_BACKGROUND_LOCATION) != PackageManager.PERMISSION_GRANTED) {
      ActivityCompat.requestPermissions(
        activity,
        new String[] { Manifest.permission.ACCESS_BACKGROUND_LOCATION },
        BACKGROUND_LOCATION_REQUEST_CODE
      );
      return;
    }

    // Requested last, after both location grants are in place — see hasMandatoryLocationAccess()
    // for why this is part of the same mandatory gate: without it, the GPS-off alert and even
    // the ongoing tracking notification are silently no-ops.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
        && ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      ActivityCompat.requestPermissions(
        activity,
        new String[] { Manifest.permission.POST_NOTIFICATIONS },
        NOTIFICATIONS_REQUEST_CODE
      );
    }
  }

  private static final int FOREGROUND_LOCATION_REQUEST_CODE = 9001;
  private static final int BACKGROUND_LOCATION_REQUEST_CODE = 9002;
  private static final int NOTIFICATIONS_REQUEST_CODE = 9003;

  /**
   * A plain OS permission dialog with no context beforehand isn't enough for something
   * tracking a worker's location for their employer — shown once, before the very first
   * permission prompt this device ever sees. This dialog only controls that one-time
   * explanatory framing; MainActivity's blocking overlay (shown whenever
   * hasMandatoryLocationAccess() is false) is what actually re-prompts on every subsequent
   * app open via its own "Grant access" button, so a worker who dismissed/denied here isn't
   * permanently stuck — only blocked from the rest of the app until they grant it.
   */
  private void showInitialConsentDialog() {
    TrackingPrefs.setShownInitialConsent(getContext(), true);
    Activity activity = getActivity();
    if (activity == null) return; // MainActivity's onResume gate covers this the next time the app is foregrounded.

    new AlertDialog.Builder(activity)
      .setTitle("Location while you're on duty")
      .setMessage(
        "DropX One requires \"Allow all the time\" location access to work. This lets your " +
        "employer see your position for attendance and dispatch purposes while you're clocked " +
        "in — it keeps running even if you close the app or turn off the screen, and stops " +
        "the moment you're off the clock. Choosing anything less than \"Allow all the time\" " +
        "will block you from using the rest of the app until it's granted."
      )
      .setCancelable(false)
      // AlertDialog's button callback runs on the AlertController's own HandlerThread, not
      // the UI thread — touching Activity APIs from there is unsafe. Hop back to the main
      // thread before requesting the permission.
      .setPositiveButton(
        "I Understand, Continue",
        (dialog, which) -> {
          Activity currentActivity = getActivity();
          if (currentActivity != null) {
            currentActivity.runOnUiThread(() -> requestMandatoryLocationAccess(currentActivity));
          }
        }
      )
      .show();
  }

  @PluginMethod
  public void startBackgroundLocation(PluginCall call) {
    if (getPermissionState("location") != PermissionState.GRANTED) {
      requestPermissionForAlias("location", call, "locationPermissionCallback");
      return;
    }
    proceedToBackgroundPermission(call);
  }

  @PermissionCallback
  private void locationPermissionCallback(PluginCall call) {
    if (getPermissionState("location") != PermissionState.GRANTED) {
      call.reject("Location permission was denied.");
      return;
    }
    proceedToBackgroundPermission(call);
  }

  private void proceedToBackgroundPermission(PluginCall call) {
    // Background location is mandatory (see class doc) — MainActivity's blocking overlay is
    // the actual enforcement, but this method still refuses to start tracking without it
    // rather than silently starting a foreground-only version of the service.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && getPermissionState("backgroundLocation") != PermissionState.GRANTED) {
      requestPermissionForAlias("backgroundLocation", call, "backgroundLocationPermissionCallback");
      return;
    }
    startServiceAndResolve(call);
  }

  @PermissionCallback
  private void backgroundLocationPermissionCallback(PluginCall call) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && getPermissionState("backgroundLocation") != PermissionState.GRANTED) {
      call.reject("Background location permission was denied.");
      return;
    }
    startServiceAndResolve(call);
  }

  private void startServiceAndResolve(PluginCall call) {
    Intent intent = new Intent(getContext(), LocationTrackingService.class);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      getContext().startForegroundService(intent);
    } else {
      getContext().startService(intent);
    }
    TrackingPrefs.setRunning(getContext(), true);
    maybeRequestBatteryOptimizationExemption();
    call.resolve();
  }

  /**
   * OEM battery managers (Samsung/Xiaomi especially) can kill a foreground service that's
   * otherwise perfectly correct, regardless of the notification/START_STICKY/etc. Asked once
   * per install, right after tracking first actually starts — not on every launch, and not
   * before there's a real reason to ask.
   */
  private void maybeRequestBatteryOptimizationExemption() {
    if (TrackingPrefs.hasRequestedBatteryExemption(getContext())) return;
    TrackingPrefs.setRequestedBatteryExemption(getContext(), true);

    PowerManager powerManager = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
    if (powerManager == null || powerManager.isIgnoringBatteryOptimizations(getContext().getPackageName())) {
      return;
    }

    Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
    intent.setData(Uri.parse("package:" + getContext().getPackageName()));
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    try {
      getContext().startActivity(intent);
    } catch (Exception e) {
      // Some OEM builds don't support this intent at all — tracking still works, it's just
      // more exposed to that OEM's own battery management killing it.
    }
  }

  @PluginMethod
  public void stopBackgroundLocation(PluginCall call) {
    getContext().stopService(new Intent(getContext(), LocationTrackingService.class));
    TrackingPrefs.setRunning(getContext(), false);
    call.resolve();
  }
}
