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
  return null;
}
