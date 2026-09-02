"use client";

import { useEffect, useState, useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";

export function StationLiveRefresh({ seconds = 60 }: { seconds?: number }) {
  const router = useRouter();
  const [remaining, setRemaining] = useState(seconds);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const interval = window.setInterval(() => {
      setRemaining((current) => {
        if (current > 1) return current - 1;
        startTransition(() => router.refresh());
        return seconds;
      });
    }, 1000);
    return () => window.clearInterval(interval);
  }, [router, seconds]);

  return <button className="station-live-refresh" type="button" disabled={pending} onClick={() => startTransition(() => {
    setRemaining(seconds);
    router.refresh();
  })}>
    <RefreshCw size={14} className={pending ? "spinning" : ""} />
    {pending ? "Refreshing…" : `Live · refresh in ${remaining}s`}
  </button>;
}
