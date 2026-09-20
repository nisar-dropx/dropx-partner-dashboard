package com.dropxlogistics.onetracker.location;

import android.Manifest;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
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

    // First login on this device: ask for full location access right away, rather than
    // waiting for a punch-in to trigger startBackgroundLocation()'s own permission prompt.
    // Only asked once per install regardless of grant/deny — Android itself refuses to
    // re-prompt after a real denial anyway, and re-asking every login would be a nag.
    if (!TrackingPrefs.hasRequestedInitialLocationPermission(getContext())) {
      showConsentThenRequestInitialPermission(call);
      return;
    }

    call.resolve();
  }

  /**
   * A plain OS permission dialog with no context beforehand isn't enough for something
   * tracking a worker's location for their employer — shown once, before the very first
   * permission prompt this device ever sees, and gated by the SAME "already asked" flag as
   * the permission request itself (so it can never show more than once regardless of what
   * the worker chooses).
   */
  private void showConsentThenRequestInitialPermission(PluginCall call) {
    Context activity = getActivity();
    if (activity == null) {
      // No foreground activity to attach a dialog to (e.g. a background relaunch) — fall
      // back to requesting permission directly rather than silently doing nothing forever.
      requestInitialLocationPermission(call);
      return;
    }

    new AlertDialog.Builder(activity)
      .setTitle("Location while you're on duty")
      .setMessage(
        "DropX One shares your location with your employer while you're clocked in, for " +
        "attendance and dispatch purposes. It keeps running in the background during your " +
        "shift, even if you close the app, and stops when you're off the clock."
      )
      .setCancelable(false)
      .setPositiveButton("I Understand, Continue", (dialog, which) -> requestInitialLocationPermission(call))
      .show();
  }

  private void requestInitialLocationPermission(PluginCall call) {
    TrackingPrefs.setRequestedInitialLocationPermission(getContext(), true);
    if (getPermissionState("location") != PermissionState.GRANTED) {
      requestPermissionForAlias("location", call, "initialLocationPermissionCallback");
      return;
    }
    requestInitialBackgroundPermissionIfNeeded(call);
  }

  @PermissionCallback
  private void initialLocationPermissionCallback(PluginCall call) {
    requestInitialBackgroundPermissionIfNeeded(call);
  }

  private void requestInitialBackgroundPermissionIfNeeded(PluginCall call) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && getPermissionState("backgroundLocation") != PermissionState.GRANTED) {
      requestPermissionForAlias("backgroundLocation", call, "initialBackgroundLocationPermissionCallback");
      return;
    }
    call.resolve();
  }

  @PermissionCallback
  private void initialBackgroundLocationPermissionCallback(PluginCall call) {
    call.resolve();
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
    // Only required on API 29+, and only matters once the app is fully backgrounded —
    // still start the foreground service either way so tracking works while the app is
    // merely minimized, rather than blocking on this optional grant.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && getPermissionState("backgroundLocation") != PermissionState.GRANTED) {
      requestPermissionForAlias("backgroundLocation", call, "backgroundLocationPermissionCallback");
      return;
    }
    startServiceAndResolve(call);
  }

  @PermissionCallback
  private void backgroundLocationPermissionCallback(PluginCall call) {
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
