"use client";
import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
export function LiveRefresh() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible")
        startTransition(() => router.refresh());
    };
    const timer = setInterval(refresh, 60000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router]);
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
