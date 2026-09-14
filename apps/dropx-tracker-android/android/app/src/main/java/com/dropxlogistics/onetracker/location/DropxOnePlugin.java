package com.dropxlogistics.onetracker.location;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
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
      TrackingPrefs.setRequestedInitialLocationPermission(getContext(), true);
      if (getPermissionState("location") != PermissionState.GRANTED) {
        requestPermissionForAlias("location", call, "initialLocationPermissionCallback");
        return;
      }
      requestInitialBackgroundPermissionIfNeeded(call);
      return;
    }

    call.resolve();
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
    call.resolve();
  }

  @PluginMethod
  public void stopBackgroundLocation(PluginCall call) {
    getContext().stopService(new Intent(getContext(), LocationTrackingService.class));
    TrackingPrefs.setRunning(getContext(), false);
    call.resolve();
  }
}
