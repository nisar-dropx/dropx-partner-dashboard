package com.dropxlogistics.fleet;
import android.net.Uri;
/** Only Fleet links can be launched inside the verified Fleet application. */
public class LauncherActivity extends com.google.androidbrowserhelper.trusted.LauncherActivity {
    @Override protected Uri getLaunchingUrl() {
        Uri url = super.getLaunchingUrl();
        if ("https".equals(url.getScheme()) && "fleet.dropxlogistics.com".equals(url.getHost())) return url;
        return Uri.parse("https://fleet.dropxlogistics.com/fleet-control?source=android_app");
    }
}
