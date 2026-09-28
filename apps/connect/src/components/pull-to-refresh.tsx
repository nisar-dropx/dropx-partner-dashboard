"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const TRIGGER_PX = 72;
const MAX_PULL_PX = 110;

function startsInInnerScroller(target: EventTarget | null) {
  let node = target instanceof Element ? target : null;
  while (node && node !== document.body && node !== document.documentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return true;
    node = node.parentElement;
  }
  return false;
}

// Mobile browsers have their own pull-to-refresh; the Android WebView inside DropX One doesn't.
export function PullToRefresh() {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef<number | null>(null);
  const pullRef = useRef(0);

  useEffect(() => {
    const capacitor = (window as Window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
    const inApp = Boolean(capacitor?.isNativePlatform?.()) || /DropXOneNative|Capacitor/.test(navigator.userAgent);
    if (!inApp) return;

    const onStart = (event: TouchEvent) => {
      if (window.scrollY > 0 || event.touches.length !== 1 || startsInInnerScroller(event.target)) {
        startY.current = null;
        return;
      }
      startY.current = event.touches[0].clientY;
    };
    const onMove = (event: TouchEvent) => {
      if (startY.current === null) return;
      const distance = event.touches[0].clientY - startY.current;
      if (distance <= 0 || window.scrollY > 0) {
        pullRef.current = 0;
        setPull(0);
        return;
      }
      pullRef.current = Math.min(MAX_PULL_PX, distance * 0.5);
      setPull(pullRef.current);
    };
    const onEnd = () => {
      if (startY.current === null) return;
      startY.current = null;
      if (pullRef.current >= TRIGGER_PX) {
        setRefreshing(true);
        window.location.reload();
        return;
      }
      pullRef.current = 0;
      setPull(0);
    };

    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: true });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("touchcancel", onEnd);
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onEnd);
    };
  }, []);

  if (!pull && !refreshing) return null;
  const offset = refreshing ? TRIGGER_PX : pull;
  return (
    <div
      aria-hidden="true"
      className={`dx-ptr${refreshing ? " is-refreshing" : ""}${pull >= TRIGGER_PX ? " is-ready" : ""}`}
      style={{ transform: `translateY(${offset}px)`, opacity: Math.min(1, offset / TRIGGER_PX) }}
    >
      <RefreshCw size={18} style={refreshing ? undefined : { transform: `rotate(${offset * 3}deg)` }} />
    </div>
  );
}
