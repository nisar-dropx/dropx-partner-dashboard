package com.dropxlogistics.one.notifications;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.AsyncTask;
import android.webkit.CookieManager;
import androidx.core.app.NotificationManagerCompat;
import com.dropxlogistics.one.location.TrackingPrefs;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * Handles a tap on the "Mark as read" action DropxMessagingService adds to a backgrounded push
 * notification — calls the exact same PATCH /api/connect/notifications the in-app bell's own
 * readNotification() uses (see connect-login-flow.tsx), so both paths converge on one source of
 * truth. Runs entirely in the background: no Activity is opened, matching what a notification
 * action button is supposed to do (dismiss the specific thing without pulling the worker into
 * the app). Reuses the same session cookie / account identity TrackingPrefs and
 * LocationTrackingService's own HTTP calls already rely on — this device only ever has one
 * logged-in worker's session at a time, so there's no ambiguity about whose notification this is.
 */
public class MarkNotificationReadReceiver extends BroadcastReceiver {
  public static final String EXTRA_NOTIFICATION_ID = "notificationId";
  public static final String EXTRA_SHOWN_NOTIFICATION_ID = "shownNotificationId";
  // Set by DropxNotificationListenerService instead of EXTRA_NOTIFICATION_ID — see its own
  // comment on why it can't recover the specific mob_app_notifications row id.
  public static final String EXTRA_MARK_ALL = "markAll";

  @Override
  public void onReceive(Context context, Intent intent) {
    String notificationId = intent.getStringExtra(EXTRA_NOTIFICATION_ID);
    boolean markAll = intent.getBooleanExtra(EXTRA_MARK_ALL, false);
    int shownNotificationId = intent.getIntExtra(EXTRA_SHOWN_NOTIFICATION_ID, -1);
    if (!markAll && (notificationId == null || notificationId.isEmpty())) return;

    String serverUrl = TrackingPrefs.serverUrl(context);
    String accountId = TrackingPrefs.accountId(context);
    String profileType = TrackingPrefs.profileType(context);
    if (serverUrl.isEmpty() || accountId.isEmpty() || profileType.isEmpty()) return;

    if (shownNotificationId != -1) {
      NotificationManagerCompat.from(context).cancel(shownNotificationId);
    }

    // PendingIntent-triggered BroadcastReceivers must return from onReceive() quickly (the OS
    // can kill the process shortly after) — goAsync() extends that window long enough for the
    // network call below to finish instead of being killed mid-request.
    PendingResult pendingResult = goAsync();
    new AsyncTask<Void, Void, Void>() {
      @Override
      protected Void doInBackground(Void... voids) {
        HttpURLConnection connection = null;
        try {
          URL endpoint = new URL(serverUrl.replaceAll("/$", "") + "/api/connect/notifications");
          connection = (HttpURLConnection) endpoint.openConnection();
          connection.setRequestMethod("PATCH");
          connection.setConnectTimeout(10_000);
          connection.setReadTimeout(10_000);
          connection.setDoOutput(true);
          connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");

          String cookie = CookieManager.getInstance().getCookie(serverUrl);
          if (cookie != null && !cookie.isEmpty()) {
            connection.setRequestProperty("Cookie", cookie);
          }

          JSONObject body = new JSONObject();
          body.put("accountId", accountId);
          body.put("profileType", profileType);
          if (markAll) {
            body.put("markAll", true);
          } else {
            body.put("notificationId", notificationId);
          }
          try (OutputStream out = connection.getOutputStream()) {
            out.write(body.toString().getBytes(StandardCharsets.UTF_8));
          }
          connection.getResponseCode();
        } catch (Exception ignored) {
          // Best-effort: the notification is already dismissed from the shade either way: a
          // failed mark-as-read just means it still shows as unread in the app's own bell,
          // which the worker can still clear from there.
        } finally {
          if (connection != null) connection.disconnect();
          pendingResult.finish();
        }
        return null;
      }
    }.execute();
  }
}
