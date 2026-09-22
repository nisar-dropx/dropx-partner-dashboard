package com.dropxlogistics.one.location;

import android.content.Context;
import android.util.Log;
import android.webkit.CookieManager;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Scanner;
import java.util.concurrent.Executors;

/**
 * Detects LocationTrackingService having died without ever getting the chance to say so
 * itself — a force-stop, an OEM battery manager killing the process, or a crash all end the
 * process outright, so there is no "on destroy, report why" hook a dying foreground service
 * can reliably run. Instead, this runs from MainActivity.onResume() — the one place we know
 * for certain the app (and thus this code) is alive again — and compares "was tracking
 * supposed to be running" against "when did we last actually hear from it".
 *
 * Threshold is intentionally exactly the compliance heartbeat's own interval (not a looser
 * multiple of it): a wider margin would let more real interruptions go unreported before the
 * worker happens to reopen the app, and this is already a best-effort, client-reported signal
 * with no server-side way to independently confirm the gap — erring toward reporting more
 * gaps, not fewer, matches how it's meant to be used downstream (HRMS reviews and can dismiss
 * a report that turns out to be a false positive; it can't retroactively know about a real one
 * that was never reported at all).
 */
public final class TrackingInterruptionReporter {
  private static final String TAG = "DropxOneLocation";
  private static final long HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;

  private TrackingInterruptionReporter() {}

  public static void checkAndReport(Context context) {
    if (!TrackingPrefs.wasRunning(context)) return; // tracking was never supposed to be running

    long lastHeartbeatAt = TrackingPrefs.lastHeartbeatAt(context);
    if (lastHeartbeatAt == 0L) return; // tracking just started, hasn't had its first heartbeat yet — not an interruption

    long gapMs = System.currentTimeMillis() - lastHeartbeatAt;
    if (gapMs < HEARTBEAT_INTERVAL_MS) return; // still within the normal interval, nothing to report

    if (TrackingPrefs.hasReportedInterruptionFor(context, lastHeartbeatAt)) return; // already reported this exact gap

    String serverUrl = TrackingPrefs.serverUrl(context);
    String accountId = TrackingPrefs.accountId(context);
    String profileType = TrackingPrefs.profileType(context);
    if (serverUrl.isEmpty() || accountId.isEmpty() || profileType.isEmpty()) return;

    double gapMinutes = gapMs / 60000.0;
    TrackingPrefs.setReportedInterruptionFor(context, lastHeartbeatAt);

    Executors.newSingleThreadExecutor().execute(() -> post(serverUrl, accountId, profileType, gapMinutes));
  }

  private static void post(String serverUrl, String accountId, String profileType, double gapMinutes) {
    HttpURLConnection connection = null;
    try {
      URL endpoint = new URL(serverUrl.replaceAll("/$", "") + "/api/connect/attendance/tracking-interruption");
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

      String body = "accountId=" + URLEncoder.encode(accountId, "UTF-8")
        + "&profileType=" + URLEncoder.encode(profileType, "UTF-8")
        + "&gapMinutes=" + URLEncoder.encode(String.valueOf(gapMinutes), "UTF-8");
      try (OutputStream out = connection.getOutputStream()) {
        out.write(body.getBytes(StandardCharsets.UTF_8));
      }
      int status = connection.getResponseCode();
      InputStream responseStream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
      String responseBody = readStream(responseStream);
      if (status >= 400) {
        Log.w(TAG, "Tracking interruption report rejected, status=" + status + ", body=" + responseBody);
      } else {
        Log.i(TAG, "Tracking interruption reported (gap=" + gapMinutes + "min), status=" + status + ", body=" + responseBody);
      }
    } catch (Exception e) {
      // Best-effort — if this fails, the gap is simply never reported. Nothing meaningful to
      // retry against without risking duplicate flags once the worker reopens the app again.
      Log.w(TAG, "Tracking interruption report failed to send.", e);
    } finally {
      if (connection != null) connection.disconnect();
    }
  }

  private static String readStream(InputStream in) {
    if (in == null) return "";
    try (Scanner scanner = new Scanner(in, StandardCharsets.UTF_8).useDelimiter("\\A")) {
      return scanner.hasNext() ? scanner.next() : "";
    } catch (Exception e) {
      return "";
    }
  }
}
