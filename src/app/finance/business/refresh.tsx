"use client";
import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import {createRefreshGate} from "@/lib/finance/refresh-gate";
export function LiveRefresh({ paused = false }: { paused?: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const gate = useRef(createRefreshGate());
  useEffect(() => { if (!pending) gate.current.finish(); }, [pending]);
  useEffect(() => {
    const refresh = () => {
      if (
        !paused &&
        document.visibilityState === "visible" &&
        !document.querySelector('.live-pnl details[open], .live-pnl [aria-expanded="true"], .live-pnl [data-exporting="true"]') &&
        !document.activeElement?.matches(".live-pnl input, .live-pnl select, .live-pnl textarea") &&
        gate.current.start()
      )
        startTransition(() => router.refresh());
    };
    const timer = setInterval(refresh, 60000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router, paused]);
  return (
    <button
      className="button secondary"
      disabled={pending}
      onClick={() => { if(gate.current.start(true)) startTransition(() => router.refresh()); }}
    >
      {pending ? "Refreshing…" : "Refresh now"}
    </button>
  );
}
