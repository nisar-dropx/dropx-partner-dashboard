"use client";

import { useEffect, useState } from "react";

/** Keep the greeting/date current across long visits and a sleeping browser. */
export function useDashboardClock(active = true) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (!active) return;
    const refresh = () => setNow(new Date());
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [active]);

  return now;
}
