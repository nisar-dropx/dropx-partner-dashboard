"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";

export function StationLiveRefresh({ seconds = 60 }: { seconds?: number }) {
  const router = useRouter();
  const [remaining, setRemaining] = useState(seconds);
  const remainingRef = useRef(seconds);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    remainingRef.current = seconds;
    setRemaining(seconds);
    const interval = window.setInterval(() => {
      remainingRef.current -= 1;
      if (remainingRef.current <= 0) {
        remainingRef.current = seconds;
        setRemaining(seconds);
        startTransition(() => router.refresh());
        return;
      }
      setRemaining(remainingRef.current);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [router, seconds]);

  return <button className="station-live-refresh" type="button" disabled={pending} onClick={() => startTransition(() => {
    remainingRef.current = seconds;
    setRemaining(seconds);
    router.refresh();
  })}>
    <RefreshCw size={14} className={pending ? "spinning" : ""} />
    {pending ? "Refreshing…" : `Live · refresh in ${remaining}s`}
  </button>;
}
