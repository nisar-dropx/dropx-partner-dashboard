package com.dropxlogistics.one.notifications;

import android.app.Notification;
import android.app.PendingIntent;
import android.content.Intent;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import com.dropxlogistics.one.MainActivity;
import com.dropxlogistics.one.R;
import java.util.Collections;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Last resort for the "Mark as read" action button: on this device, Google Play Services'
 * own FCM handling constructs and posts a Notification directly from the message data —
 * confirmed via RemoteMessage.getNotification() being non-null even though the server sends a
 * genuinely data-only message (no top-level "notification" field in the FCM v1 API request) —
 * bypassing DropxMessagingService.onMessageReceived() entirely for that delivery path. Nothing
 * in this app's own code or manifest controls that; it's Play Services' own internal decision.
 * A NotificationListenerService is the only remaining hook that still sees a notification AFTER
 * it's posted, regardless of who posted it, and can cancel + repost with the action added.
 * Requires the worker to separately grant "Notification access" in system Settings — this is
 * NOT a normal runtime permission dialog, so MainActivity prompts for it once via
 * requestNotificationListenerAccess() and this service only acts on our own package's
 * notifications, never reading anyone else's.
 */
public class DropxNotificationListenerService extends NotificationListenerService {
  private static final String TAG = "DropxNotifListener";
  private static final String CHANNEL_ID = "dropx_one_notifications";
  private static final AtomicInteger nextNotificationId = new AtomicInteger(6000);
  // notification.actions.length > 0 alone doesn't reliably stop re-entry: posting our rebuilt
  // notification can itself trigger a fresh onNotificationPosted callback (observed via the OS
  // auto-grouping this channel into an "Aggregate_AlertingSection" summary, whose own
  // post/remove churn re-delivers callbacks for the member notifications too), and by the time
  // that second callback reads extras, the "current" sbn can already be our own rebuilt one
  // with its text stripped by BigTextStyle — producing an empty-content notification that keeps
  // re-triggering itself. Tracking exactly which ids THIS service posted, and skipping those
  // unconditionally, is the only guard that actually breaks the loop.
  private static final Set<Integer> shownNotificationIds =
    Collections.newSetFromMap(new ConcurrentHashMap<>());

  @Override
  public void onNotificationPosted(StatusBarNotification sbn) {
    super.onNotificationPosted(sbn);
    if (!getPackageName().equals(sbn.getPackageName())) return;
    if (shownNotificationIds.contains(sbn.getId())) return;

    Notification notification = sbn.getNotification();
    if (notification == null || !CHANNEL_ID.equals(notification.getChannelId())) return;
    // Already has an action (DropxMessagingService built it correctly) — nothing to do.
    if (notification.actions != null && notification.actions.length > 0) return;
    // The OS auto-groups multiple notifications on this channel into a synthetic
    // "Aggregate_AlertingSection" summary (flags include GROUP_SUMMARY|AUTOGROUP_SUMMARY,
    // extras carry no real title/text of their own) — not a real message, skip it.
    if ((notification.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return;

    Bundle extras = notification.extras;
    CharSequence titleChars = extras != null ? extras.getCharSequence(Notification.EXTRA_TITLE) : null;
    CharSequence bodyChars = extras != null ? extras.getCharSequence(Notification.EXTRA_TEXT) : null;
    String title = titleChars != null ? titleChars.toString() : "DropX One";
    String body = bodyChars != null ? bodyChars.toString() : "";
    // Nothing real to show (can happen if this callback fires for a notification whose content
    // was never fully populated yet) — skip rather than reposting a blank "DropX One" bubble.
    if (body.trim().isEmpty()) return;
    // Play Services' own auto-posted notification doesn't carry the original FCM data payload
    // as extras (only the notification-block-equivalent title/text it itself derived) — so the
    // mob_app_notifications row id genuinely isn't recoverable from here the way
    // DropxMessagingService.onMessageReceived() has it directly from RemoteMessage.getData().
    // Falling back to the same PATCH markAll:true the in-app bell's "Clear all" button uses:
    // less precise (marks every unread notification read, not just this one), but still a real,
    // working action rather than none — the worker's actual complaint was "there's no button at
    // all", not "the button doesn't target precisely enough".
    cancelNotification(sbn.getKey());

    int shownNotificationId = nextNotificationId.incrementAndGet();
    shownNotificationIds.add(shownNotificationId);
    NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
      .setSmallIcon(R.mipmap.ic_notification)
      .setColor(0xFFF5A623)
      .setAutoCancel(true)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setGroupSummary(false)
      .setContentIntent(notification.contentIntent);

    Intent markReadIntent = new Intent(this, MarkNotificationReadReceiver.class);
    markReadIntent.putExtra(MarkNotificationReadReceiver.EXTRA_MARK_ALL, true);
    markReadIntent.putExtra(MarkNotificationReadReceiver.EXTRA_SHOWN_NOTIFICATION_ID, shownNotificationId);
    PendingIntent markReadPendingIntent = PendingIntent.getBroadcast(
      this,
      shownNotificationId,
      markReadIntent,
      PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
    );
    builder.addAction(R.mipmap.ic_notification, "Mark as read", markReadPendingIntent);

    NotificationManagerCompat.from(this).notify(shownNotificationId, builder.build());
    Log.i(TAG, "Rebuilt Play-Services-posted notification with mark-as-read action, title=" + title);
  }
}
