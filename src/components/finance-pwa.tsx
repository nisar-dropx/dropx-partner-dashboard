"use client";
import { useEffect, useState } from "react";
export function FinancePwa() {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update(); window.addEventListener("online", update); window.addEventListener("offline", update);
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/finance-sw.js", { scope: "/" }).catch(() => undefined);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  return offline ? <div className="finance-offline-banner" role="status">You’re offline. Reconnect to refresh live figures or save changes.</div> : null;
}
