package com.dropxlogistics.finance;
import android.net.Uri;
public class LauncherActivity extends com.google.androidbrowserhelper.trusted.LauncherActivity {
 @Override protected Uri getLaunchingUrl() {
  Uri url = super.getLaunchingUrl();
  if (url != null && "https".equals(url.getScheme()) && "fin.dropxlogistics.com".equals(url.getHost())) return url;
  return Uri.parse("https://fin.dropxlogistics.com/finance?source=android-app");
 }
}
