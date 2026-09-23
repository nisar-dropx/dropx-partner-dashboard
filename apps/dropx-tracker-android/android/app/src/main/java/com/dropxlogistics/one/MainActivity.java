package com.dropxlogistics.one;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ValueCallback;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.dropxlogistics.one.location.DropxOnePlugin;
import com.dropxlogistics.one.location.TrackingPrefs;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  /** Covers the site's own "checking session" spinner on cold start; never blocks real content this long. */
  private static final long OVERLAY_MAX_MS = 4000;
  private static final long OVERLAY_POLL_MS = 150;

  private ImageView startupOverlay;
  private final Handler overlayHandler = new Handler(Looper.getMainLooper());
  private long overlayStartedAt;

  /**
   * Full-screen, non-dismissible overlay shown whenever DropxOnePlugin.hasMandatoryLocationAccess()
   * is false — i.e. the worker hasn't granted "Allow all the time" location access. Unlike
   * startupOverlay (a brief loading cover), this can stay up indefinitely; it's removed only
   * once onResume's re-check finds access has actually been granted. Built as plain Android
   * views layered over the WebView, not a Dialog — a Dialog can be dismissed by the back
   * button or a tap outside it, which would defeat the whole point of blocking app usage.
   */
  private LinearLayout locationAccessRequiredOverlay;

  @Override
  public void onCreate(Bundle savedInstanceState) {
    // Must run before super.onCreate() — Capacitor builds its plugin list there.
    registerPlugin(DropxOnePlugin.class);
    super.onCreate(savedInstanceState);

    createPushNotificationChannel();

    // The status bar icons (clock/battery/signal) default to light (white-ish), meant for a
    // dark backdrop. This app's header is light (#fff/#fbf8f3), so light icons render at
    // near-zero contrast — not literally invisible, just unreadable — which read as "that
    // space is empty" even though it's exactly where the icons are. Telling the system the
    // content behind the status bar is light makes it switch to dark icons instead.
    new WindowInsetsControllerCompat(getWindow(), getWindow().getDecorView()).setAppearanceLightStatusBars(true);

    // Non-edge-to-edge (the pre-Capacitor-6 default): Android reserves the real status-bar
    // AND navigation-bar space itself and draws the WebView strictly between them — the same
    // layout the website already gets in a plain mobile browser. globals.css's --dx-safe-top
    // and --dx-safe-bottom are both 0px for html.native-app for exactly this reason: with the
    // OS already reserving the correct space on both edges (always accurate on every device,
    // no measuring/injecting needed here), neither the header nor the bottom nav should add
    // any padding of their own on top of that.
    WindowCompat.setDecorFitsSystemWindows(getWindow(), true);

    showStartupOverlay();
  }

  /**
   * Must exist before the FIRST push notification arrives, or Android silently falls back to a
   * generic system channel (no custom icon/color/name — this was reproduced live: the fallback
   * channel is literally named "fcm_fallback_notification_channel"). AndroidManifest.xml's
   * com.google.firebase.messaging.default_notification_channel_id meta-data tells
   * FirebaseMessagingService to route pushes here, but creating the channel itself is still
   * this app's job — Firebase doesn't do it automatically.
   */
  private void createPushNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
    NotificationChannel channel = new NotificationChannel(
      "dropx_one_notifications",
      "DropX One notifications",
      NotificationManager.IMPORTANCE_HIGH
    );
    channel.setDescription("Punch confirmations, approvals, and other DropX One alerts.");
    NotificationManager manager = getSystemService(NotificationManager.class);
    if (manager != null) manager.createNotificationChannel(channel);
  }

  /**
   * Notification access isn't a normal runtime permission — there's no in-app dialog Android
   * offers for it, only a system Settings screen the worker has to navigate to manually and
   * toggle DropX One on. DropxNotificationListenerService needs it to add the "Mark as read"
   * action to a push notification Google Play Services posts directly on this device (see that
   * service's own comment on why DropxMessagingService alone isn't reliably enough). Asked at
   * most once per install, on first resume — not on every launch, since there's no way to tell
   * "denied" from "hasn't gotten to it yet" and re-nagging on every open would be worse than an
   * occasionally-missing action button.
   */
  private void maybeRequestNotificationListenerAccess() {
    if (TrackingPrefs.hasRequestedNotificationListenerAccess(this)) return;
    if (NotificationManagerCompat.getEnabledListenerPackages(this).contains(getPackageName())) return;
    TrackingPrefs.setRequestedNotificationListenerAccess(this, true);
    try {
      startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS));
    } catch (Exception e) {
      // Some OEM builds don't support this intent — the mark-as-read action just won't render
      // reliably on those, same as before this existed.
    }
  }

  @Override
  public void onResume() {
    super.onResume();
    // Re-checked on every resume, not just after login: covers the worker later revoking the
    // permission from system Settings, or never completing the initial grant flow at all and
    // instead just backgrounding/reopening the app to get past it.
    refreshLocationAccessGate();
    com.dropxlogistics.one.location.TrackingInterruptionReporter.checkAndReport(this);
    maybeRequestNotificationListenerAccess();
  }

  private void refreshLocationAccessGate() {
    if (DropxOnePlugin.hasMandatoryLocationAccess(this)) {
      hideLocationAccessRequiredOverlay();
    } else {
      showLocationAccessRequiredOverlay();
    }
  }

  /**
   * Blocks the rest of the app until "Allow all the time" location access is granted — see
   * the field doc on locationAccessRequiredOverlay for why this is a plain View layer instead
   * of a Dialog. Safe to call repeatedly; rebuilds nothing if already showing.
   */
  private void showLocationAccessRequiredOverlay() {
    if (locationAccessRequiredOverlay != null) return;

    LinearLayout container = new LinearLayout(this);
    container.setOrientation(LinearLayout.VERTICAL);
    container.setGravity(Gravity.CENTER);
    container.setBackgroundColor(Color.WHITE);
    int paddingPx = (int) (32 * getResources().getDisplayMetrics().density);
    container.setPadding(paddingPx, paddingPx, paddingPx, paddingPx);

    TextView title = new TextView(this);
    title.setText("Full-time location & notifications required");
    title.setTextSize(20);
    title.setTypeface(title.getTypeface(), android.graphics.Typeface.BOLD);
    title.setGravity(Gravity.CENTER);
    container.addView(title);

    TextView body = new TextView(this);
    body.setText(
      "DropX One needs \"Allow all the time\" location access, plus notification permission, " +
      "to track attendance and dispatch while you're on duty — including when the app is " +
      "closed, and to warn you if Location gets turned off mid-shift. Grant both below to " +
      "continue — the app can't be used without them."
    );
    body.setTextSize(15);
    body.setGravity(Gravity.CENTER);
    int bodyMarginPx = (int) (16 * getResources().getDisplayMetrics().density);
    LinearLayout.LayoutParams bodyParams = new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
    );
    bodyParams.topMargin = bodyMarginPx;
    bodyParams.bottomMargin = bodyMarginPx * 2;
    container.addView(body, bodyParams);

    Button grantButton = new Button(this);
    grantButton.setText("Grant access");
    grantButton.setOnClickListener(v -> DropxOnePlugin.requestMandatoryLocationAccess(this));
    container.addView(grantButton);

    Button settingsButton = new Button(this);
    settingsButton.setText("Open app settings");
    LinearLayout.LayoutParams settingsParams = new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
    );
    settingsParams.topMargin = (int) (8 * getResources().getDisplayMetrics().density);
    settingsButton.setOnClickListener(v -> {
      Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
      intent.setData(Uri.parse("package:" + getPackageName()));
      startActivity(intent);
    });
    container.addView(settingsButton, settingsParams);

    locationAccessRequiredOverlay = container;
    addContentView(
      container,
      new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    );
  }

  private void hideLocationAccessRequiredOverlay() {
    if (locationAccessRequiredOverlay == null) return;
    View overlay = locationAccessRequiredOverlay;
    locationAccessRequiredOverlay = null;
    ViewGroup parent = (ViewGroup) overlay.getParent();
    if (parent != null) parent.removeView(overlay);
  }

  /**
   * The OS splash theme (@drawable/splash) only covers the single frame before this Activity
   * draws anything — after that, the WebView shows a blank page while it loads the remote
   * site, then the site's own "checking session" spinner while it calls
   * /api/connect/auth/session, and only then real content. This overlay (same look as the
   * splash) covers that whole gap instead of a jarring blank-then-spinner sequence — polls
   * for the site's own loader element to disappear, with a hard timeout so a slow network or
   * a markup change on the site's side can never leave this stuck up permanently.
   */
  private void showStartupOverlay() {
    startupOverlay = new ImageView(this);
    startupOverlay.setImageResource(R.drawable.splash);
    startupOverlay.setScaleType(ImageView.ScaleType.CENTER_CROP);
    startupOverlay.setBackgroundColor(Color.WHITE);
    addContentView(
      startupOverlay,
      new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    );
    overlayStartedAt = System.currentTimeMillis();
    overlayHandler.postDelayed(this::pollForContentReady, OVERLAY_POLL_MS);
  }

  private void pollForContentReady() {
    if (startupOverlay == null) return;

    if (System.currentTimeMillis() - overlayStartedAt >= OVERLAY_MAX_MS) {
      hideStartupOverlay();
      return;
    }

    WebView webView = bridge != null ? bridge.getWebView() : null;
    if (webView == null) {
      overlayHandler.postDelayed(this::pollForContentReady, OVERLAY_POLL_MS);
      return;
    }

    ValueCallback<String> onResult = (value) -> {
      if ("true".equals(value)) {
        hideStartupOverlay();
      } else {
        overlayHandler.postDelayed(this::pollForContentReady, OVERLAY_POLL_MS);
      }
    };
    webView.evaluateJavascript("!document.querySelector('.dx-loader')", onResult);
  }

  private void hideStartupOverlay() {
    if (startupOverlay == null) return;
    ImageView overlay = startupOverlay;
    startupOverlay = null;
    overlay.animate().alpha(0f).setDuration(150).withEndAction(() -> {
      ViewGroup parent = (ViewGroup) overlay.getParent();
      if (parent != null) parent.removeView(overlay);
    }).start();
  }
}
