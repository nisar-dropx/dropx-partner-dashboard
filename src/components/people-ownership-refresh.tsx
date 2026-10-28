"use client";

import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";

/** Re-read current People ownership without resetting filters or refreshing edit forms. */
export function PeopleOwnershipRefresh({paused = false}: {paused?: boolean}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const busy = useRef(false);
  const lastRefresh = useRef(Date.now());
  useEffect(() => { busy.current = pending; }, [pending]);
  useEffect(() => {
    if (paused) return;
    const refresh = () => {
      if (document.visibilityState !== "visible" || busy.current || Date.now() - lastRefresh.current < 5000) return;
      busy.current = true;
      lastRefresh.current = Date.now();
      startTransition(() => router.refresh());
    };
    const timer = window.setInterval(refresh, 30000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [paused, router]);
  return <div className="subtle" style={{display:"flex",alignItems:"center",gap:10,fontSize:11,margin:"8px 0"}}>
    <span>Managers from People · {paused ? "refresh paused while editing" : "updates every 30 seconds"}</span>
    <button type="button" className="button secondary compact" disabled={paused || pending} onClick={() => {
      lastRefresh.current = Date.now();
      startTransition(() => router.refresh());
    }}>{pending ? "Refreshing…" : "Refresh"}</button>
  </div>;
}
