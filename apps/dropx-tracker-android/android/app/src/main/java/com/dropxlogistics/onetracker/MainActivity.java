package com.dropxlogistics.onetracker;

import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.ViewGroup;
import android.webkit.ValueCallback;
import android.webkit.WebView;
import android.widget.ImageView;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.dropxlogistics.onetracker.location.DropxOnePlugin;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  /** Covers the site's own "checking session" spinner on cold start; never blocks real content this long. */
  private static final long OVERLAY_MAX_MS = 4000;
  private static final long OVERLAY_POLL_MS = 150;

  private ImageView startupOverlay;
  private final Handler overlayHandler = new Handler(Looper.getMainLooper());
  private long overlayStartedAt;

  @Override
  public void onCreate(Bundle savedInstanceState) {
    // Must run before super.onCreate() — Capacitor builds its plugin list there.
    registerPlugin(DropxOnePlugin.class);
    super.onCreate(savedInstanceState);

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
