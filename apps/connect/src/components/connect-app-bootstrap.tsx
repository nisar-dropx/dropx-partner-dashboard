"use client";

import { useEffect } from "react";

const APP_SOURCE = "android-app";

function isInstalledExperience() {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    document.referrer.startsWith("android-app://") ||
    new URLSearchParams(window.location.search).get("source") === APP_SOURCE
  );
}

export function ConnectAppBootstrap() {
  useEffect(() => {
    if (isInstalledExperience()) {
      document.documentElement.classList.add("native-app", "twa-app");
    }

    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;

    let cancelled = false;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).then((registration) => {
      if (cancelled) return;
      registration.update().catch(() => undefined);
    }).catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
