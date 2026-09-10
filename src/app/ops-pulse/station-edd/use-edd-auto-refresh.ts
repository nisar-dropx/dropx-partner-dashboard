"use client";
import { useEffect, useRef } from "react";

/** Read the shared ledger, not the upstream history API. Pause hidden tabs and
 * deduplicate timer/focus events so one open view cannot flood requests. */
export function useEddAutoRefresh(refresh: () => Promise<unknown>, enabled = true) {
  const latest = useRef(refresh);
  useEffect(() => { latest.current = refresh; }, [refresh]);
  useEffect(() => {
    if (!enabled) return;
    let pending = false;
    let disposed = false;
    const run = async () => {
      if (disposed || pending || document.visibilityState !== "visible") return;
      pending = true;
      try { await latest.current(); } finally { pending = false; }
    };
    const timer = window.setInterval(() => { void run(); }, 60000);
    const visible = () => { void run(); };
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => { disposed = true; window.clearInterval(timer); window.removeEventListener("focus", visible); document.removeEventListener("visibilitychange", visible); };
  }, [enabled]);
}
