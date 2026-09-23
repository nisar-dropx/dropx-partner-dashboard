package com.dropxlogistics.one.notifications;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import com.dropxlogistics.one.MainActivity;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Replaces @capacitor/push-notifications' MessagingService (removed from AndroidManifest.xml —
 * see its own comment) so a "Mark as read" action button can be added to the notification when
 * the app is backgrounded/closed. Android's own FCM handling auto-displays a plain
 * system-rendered notification straight from the message's "notification" block with no way to
 * inject an action into it; building the notification ourselves here, from the message's "data"
 * fields, is the only way to add one. Capacitor's own foreground path (PushNotificationsPlugin
 * .fireNotification(), used when the WebView is actually visible) is untouched — this only
 * covers the backgrounded case that used to fall through to Android's default handling.
 */
public class DropxMessagingService extends FirebaseMessagingService {
  private static final String TAG = "DropxMessagingService";
  private static final String CHANNEL_ID = "dropx_one_notifications";
  private static final AtomicInteger nextNotificationId = new AtomicInteger(5000);

  @Override
  public void onMessageReceived(RemoteMessage remoteMessage) {
    super.onMessageReceived(remoteMessage);

    Map<String, String> data = remoteMessage.getData();
    Log.i(TAG, "onMessageReceived data=" + data
      + " hasNotificationBlock=" + (remoteMessage.getNotification() != null));
    String title;
    String body;
    if (remoteMessage.getNotification() != null) {
      title = remoteMessage.getNotification().getTitle();
      body = remoteMessage.getNotification().getBody();
    } else {
      title = data.get("dropxTitle");
      body = data.get("dropxBody");
    }
    if (title == null) title = "DropX One";
    if (body == null) body = "";
    String notificationId = data.get("notificationId");
    String route = data.get("route");

    ensureChannel();

    Intent openIntent = new Intent(this, MainActivity.class);
    openIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    if (route != null && !route.isEmpty()) openIntent.putExtra("dropxNotificationRoute", route);
    if (notificationId != null) openIntent.putExtra("dropxNotificationId", notificationId);
    int requestCode = notificationId != null ? notificationId.hashCode() : (int) System.currentTimeMillis();
    PendingIntent contentIntent = PendingIntent.getActivity(
      this,
      requestCode,
      openIntent,
      PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
    );

    int shownNotificationId = nextNotificationId.incrementAndGet();

    NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
      .setSmallIcon(getApplicationInfo().icon)
      .setColor(0xFFF5A623)
      .setAutoCancel(true)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setContentIntent(contentIntent);

    // Only a real mob_app_notifications row (not e.g. a plain informational push with no
    // backing DB record) can be marked read — the receiver needs this id to know what to PATCH.
    if (notificationId != null && !notificationId.isEmpty()) {
      Intent markReadIntent = new Intent(this, MarkNotificationReadReceiver.class);
      markReadIntent.putExtra(MarkNotificationReadReceiver.EXTRA_NOTIFICATION_ID, notificationId);
      markReadIntent.putExtra(MarkNotificationReadReceiver.EXTRA_SHOWN_NOTIFICATION_ID, shownNotificationId);
      PendingIntent markReadPendingIntent = PendingIntent.getBroadcast(
        this,
        shownNotificationId,
        markReadIntent,
        PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
      );
      builder.addAction(0, "Mark as read", markReadPendingIntent);
      Log.i(TAG, "Added mark-as-read action for notificationId=" + notificationId);
    } else {
      Log.w(TAG, "No notificationId in data payload; skipping mark-as-read action.");
    }

    NotificationManagerCompat.from(this).notify(shownNotificationId, builder.build());
  }

  private void ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
    NotificationChannel channel = new NotificationChannel(
      CHANNEL_ID,
      "DropX One notifications",
      NotificationManager.IMPORTANCE_HIGH
    );
    channel.setDescription("Punch confirmations, approvals, and other DropX One alerts.");
    NotificationManager manager = getSystemService(NotificationManager.class);
    if (manager != null) manager.createNotificationChannel(channel);
  }
}
