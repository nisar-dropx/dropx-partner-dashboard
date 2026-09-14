package com.dropxlogistics.onetracker;

import android.os.Bundle;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.dropxlogistics.onetracker.location.DropxOnePlugin;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
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
  }
}
