package com.dropxlogistics.onetracker.location;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/**
 * Without this, a reboot silently stops tracking until the worker reopens the app —
 * defeating "always running in the background". Only restarts if the worker had
 * tracking actually running (and enabled) before the reboot, per TrackingPrefs.
 */
public class BootReceiver extends BroadcastReceiver {
  @Override
  public void onReceive(Context context, Intent intent) {
    if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
    if (!TrackingPrefs.wasRunning(context) || !TrackingPrefs.locationTrackingEnabled(context)) return;

    Intent serviceIntent = new Intent(context, LocationTrackingService.class);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      context.startForegroundService(serviceIntent);
    } else {
      context.startService(serviceIntent);
    }
  }
}
