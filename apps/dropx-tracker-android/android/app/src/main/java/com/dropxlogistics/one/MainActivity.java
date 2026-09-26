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
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
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

    // Previously called setDecorFitsSystemWindows(true), on the assumption that Android would
    // reserve real status-bar/nav-bar space itself, and applyInsetsToWebView() below would only
    // need to fill in the gap on API 35+ (where edge-to-edge is enforced and that call becomes a
    // no-op). That assumption was wrong: whether/how much space setDecorFitsSystemWindows(true)
    // actually reserves is inconsistent across OS versions and OEM skins — branching on
    // Build.VERSION.SDK_INT to guess when it applies caused a real, reproduced bug (the WebView's
    // margin AND the OS's own reservation both being applied, doubling the top gap) on multiple
    // real devices across different Android versions, not just one. The fix is to remove the
    // guessing entirely: always request edge-to-edge (false), so the OS NEVER reserves system-bar
    // space on ANY device, and applyInsetsToWebView()'s margin is the ONLY mechanism doing that
    // job, unconditionally, everywhere. One code path, no version branching, cannot double up.
    WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
    applySystemBarInsetsToWebView();
    appendDeviceIdToUserAgent();

    showStartupOverlay();
  }

  /**
   * Reads the real status-bar/navigation-bar heights from the window insets and pushes them
   * into --dx-safe-top/--dx-safe-bottom — the same CSS variables globals.css's
   * html.native-app rules already read, previously hardcoded to 0px under the (now false on
   * Android 15+) assumption that the OS reserves that space so the WebView never draws under
   * either bar. Re-applied on every inset change (not just once at startup) since the values
   * can change — rotation, a device with a notch/cutout, gesture-nav vs. 3-button-nav toggled
   * in system settings, etc.
   */
  /**
   * Android 15+ (targetSdk 35+) enforces edge-to-edge unconditionally and silently ignores
   * setDecorFitsSystemWindows(true) — the WebView started drawing under the status/nav bars
   * with no reserved space. globals.css's own env(safe-area-inset-top) / --dx-safe-top CSS
   * plumbing was tried first and confirmed NOT to visually offset content despite injecting the
   * correct values (a real WebView quirk: its Chromium compositor doesn't reliably honor a
   * child element's padding/CSS insets driven from injected JS the way normal page CSS does).
   * Margins on the WebView's own LayoutParams — which physically move/resize the Android View
   * within its parent, independent of anything inside the page — is what Google's edge-to-edge
   * migration guidance recommends and what actually worked here.
   */
  /**
   * Lets the server bind an account to one phone (apps/connect's connect-device-binding.ts reads
   * "DropXDevice/<id>" from the user agent at login). ANDROID_ID is used instead of IMEI because
   * Play policy doesn't allow reading hardware identifiers for this; it's sent hashed so the raw
   * value never leaves the device.
   */
  private void appendDeviceIdToUserAgent() {
    if (getBridge() == null || getBridge().getWebView() == null) return;
    String androidId = Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID);
    if (androidId == null || androidId.isEmpty()) return;
    try {
      byte[] digest = java.security.MessageDigest.getInstance("SHA-256")
        .digest(androidId.getBytes(java.nio.charset.StandardCharsets.UTF_8));
      StringBuilder hex = new StringBuilder();
      for (byte b : digest) hex.append(String.format("%02x", b));
      android.webkit.WebSettings settings = getBridge().getWebView().getSettings();
      settings.setUserAgentString(settings.getUserAgentString() + " DropXDevice/" + hex);
    } catch (java.security.NoSuchAlgorithmException ignored) {
      // SHA-256 is always available on Android.
    }
  }

  private void applySystemBarInsetsToWebView() {
    View root = getWindow().getDecorView();
    ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
      applyInsetsToWebView(insets);
      return insets;
    });
  }

  /**
   * onCreate() requests edge-to-edge unconditionally (setDecorFitsSystemWindows(false)) on
   * every device and API level, so the OS never reserves system-bar space on its own, for
   * EITHER bar — this margin is the ONLY thing reserving that space, always, everywhere. One
   * unconditional code path, top and bottom alike, can't double up with anything and doesn't
   * need to special-case any OS version, OEM skin, or navigation mode.
   *
   * An earlier version of this method skipped the bottom margin specifically for 3-button
   * navigation (via a tappableElement() check), on the theory that the OS was "already"
   * reserving that space so an added margin would double it up — that was true back when
   * setDecorFitsSystemWindows(true) was still being called (which it no longer is, for exactly
   * the same doubling problem on the status-bar side). Once edge-to-edge became unconditional,
   * that theory stopped being true for the nav bar too: reproduced live on a real 3-button-nav
   * device, the app's own bottom navigation row was rendering flush with, and at the same
   * height as, the phone's OS back/home/recents buttons — an overlap, not a gap — because
   * nothing was reserving space for the OS bar any more. Margining by navigationBars() always,
   * regardless of navigation mode, is what actually keeps content clear of it now.
   */
  private void applyInsetsToWebView(WindowInsetsCompat insets) {
    if (getBridge() == null || getBridge().getWebView() == null) return;
    View webView = getBridge().getWebView();
    ViewGroup.MarginLayoutParams params = (ViewGroup.MarginLayoutParams) webView.getLayoutParams();
    if (params == null) return;

    Insets statusBars = insets.getInsets(WindowInsetsCompat.Type.statusBars());
    Insets navigationBars = insets.getInsets(WindowInsetsCompat.Type.navigationBars());

    params.topMargin = statusBars.top;
    params.bottomMargin = navigationBars.bottom;
    webView.setLayoutParams(params);
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
    // Re-applied on every resume, not just relying on the onCreate()-time listener firing once:
    // ViewCompat.getRootWindowInsets() reads the most recently dispatched insets rather than
    // forcing a fresh layout pass, so this is cheap, and covers a device where the inset
    // listener's own callback timing raced the WebView's LayoutParams not existing yet.
    WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(getWindow().getDecorView());
    if (insets != null) {
      applyInsetsToWebView(insets);
    }
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
    // This container's background is hardcoded to white, but a plain TextView's default text
    // color comes from the ACTIVE SYSTEM THEME — on a device in dark mode (or certain OEM theme
    // overlays), that default resolves to a light/white color, rendering as invisible text on
    // this white background. Reproduced live: buttons (which carry their own styled background)
    // were visible, title/body text was not. Setting an explicit dark color makes this readable
    // regardless of the device's system theme.
    title.setTextColor(Color.BLACK);
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
    body.setTextColor(Color.DKGRAY);
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
