"use client";
import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
export function LiveRefresh({ paused = false }: { paused?: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    const refresh = () => {
      if (!paused && document.visibilityState === "visible")
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
      onClick={() => startTransition(() => router.refresh())}
    >
      {pending ? "Refreshing…" : "Refresh now"}
    </button>
  );
}
