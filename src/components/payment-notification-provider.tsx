"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PaymentNotificationSnapshot } from "@/lib/payment-notification-counts";

const emptySnapshot: PaymentNotificationSnapshot = {
  total: 0,
  badges: {},
  items: []
};

type PaymentNotificationContextValue = {
  isRefreshing: boolean;
  refresh: () => Promise<void>;
  snapshot: PaymentNotificationSnapshot;
};

const PaymentNotificationContext = createContext<PaymentNotificationContextValue>({
  isRefreshing: false,
  refresh: async () => undefined,
  snapshot: emptySnapshot
});

export function PaymentNotificationProvider({
  children,
  initialData
}: {
  children: ReactNode;
  initialData: PaymentNotificationSnapshot;
}) {
  const [snapshot, setSnapshot] = useState<PaymentNotificationSnapshot>(initialData);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastAttemptRef = useRef(0);
  const suspendedRef = useRef(false);

  const runRefresh = useCallback((force = false) => {
    if (!force && (suspendedRef.current || !navigator.onLine || document.visibilityState !== "visible")) {
      return Promise.resolve();
    }
    if (inFlightRef.current) return inFlightRef.current;

    const request = (async () => {
      setIsRefreshing(true);
      lastAttemptRef.current = Date.now();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const response = await fetch("/api/payment-notifications", {
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal
        });
        if (response.status === 401 || response.status === 403) {
          suspendedRef.current = true;
          return;
        }
        if (response.ok) {
          setSnapshot(await response.json());
          suspendedRef.current = false;
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          console.warn("Payment notifications could not be refreshed.");
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        inFlightRef.current = null;
        setIsRefreshing(false);
      }
    })();
    inFlightRef.current = request;
    return request;
  }, []);

  const refresh = useCallback(() => runRefresh(true), [runRefresh]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void runRefresh(false);
    }, 60000);
    const refreshIfStale = () => {
      if (Date.now() - lastAttemptRef.current < 60000) return;
      suspendedRef.current = false;
      void runRefresh(false);
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") refreshIfStale();
    };
    window.addEventListener("focus", refreshIfStale);
    window.addEventListener("online", refreshIfStale);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshIfStale);
      window.removeEventListener("online", refreshIfStale);
      document.removeEventListener("visibilitychange", handleVisibility);
      abortRef.current?.abort();
    };
  }, [runRefresh]);

  const value = useMemo(() => ({ isRefreshing, refresh, snapshot }), [isRefreshing, refresh, snapshot]);

  return (
    <PaymentNotificationContext.Provider value={value}>
      {children}
    </PaymentNotificationContext.Provider>
  );
}

export function usePaymentNotifications() {
  return useContext(PaymentNotificationContext);
}

export function PaymentNavBadge({ code }: { code?: string }) {
  const { snapshot } = usePaymentNotifications();
  if (!code) return null;
  const count = snapshot.badges[code] ?? 0;
  if (count <= 0) return null;
  return <span className="nav-badge">{count > 99 ? "99+" : count}</span>;
}
