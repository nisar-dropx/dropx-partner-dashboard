"use client";

import { Download, ShieldCheck, Smartphone, Zap } from "lucide-react";
import { useEffect, useState } from "react";

type AppRelease = {
  appName: string;
  apkSha256: string;
  apkUrl: string;
  version: string;
};

function isInstalledApp() {
  if (typeof window === "undefined") return true;
  const displayMode = window.matchMedia("(display-mode: standalone)").matches || window.matchMedia("(display-mode: fullscreen)").matches;
  return displayMode || document.referrer.startsWith("android-app://") || /Capacitor/i.test(navigator.userAgent) || new URLSearchParams(window.location.search).get("source") === "android-app";
}

export function ConnectAppInstallCard() {
  const [release, setRelease] = useState<AppRelease | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (isInstalledApp()) {
      setChecked(true);
      return;
    }

    fetch("/api/app-release", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((payload) => {
        if (!cancelled) setRelease(payload?.apkUrl ? payload : null);
      })
      .catch(() => {
        if (!cancelled) setRelease(null);
      })
      .finally(() => {
        if (!cancelled) setChecked(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!checked || !release) return null;

  return (
    <aside className="dx-app-install" aria-label="Download DropX One Android app">
      <i className="dx-app-install-icon"><Smartphone /></i>
      <span className="dx-app-install-copy">
        <small>Latest Android app · v{release.version}</small>
        <strong>Take DropX One with you</strong>
        <em><Zap />Always current with the web workspace</em>
      </span>
      <a className="dx-app-install-cta" download href={release.apkUrl}>
        <Download />Download APK
      </a>
      <span className="dx-app-install-trust"><ShieldCheck />Official DropX release</span>
    </aside>
  );
}
