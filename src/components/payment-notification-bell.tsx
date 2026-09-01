"use client";

import { Bell } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePaymentNotifications } from "@/components/payment-notification-provider";

export function PaymentNotificationBell() {
  const { isRefreshing, refresh, snapshot } = usePaymentNotifications();
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  const toggle = () => {
    setIsOpen((open) => !open);
    void refresh();
  };

  return (
    <div className="payment-notification-wrap" ref={rootRef}>
      <button
        aria-label="Payment notifications"
        className={`payment-notification-trigger ${isRefreshing ? "loading" : ""}`}
        onClick={toggle}
        type="button"
      >
        <Bell size={18} strokeWidth={2.4} />
        {snapshot.total > 0 ? <span className="payment-notification-badge">{snapshot.total > 99 ? "99+" : snapshot.total}</span> : null}
      </button>

      {isOpen ? (
        <div className="payment-notification-panel">
          <div className="payment-notification-head">
            <strong>Notifications</strong>
            <span>{snapshot.total > 0 ? `${snapshot.total} open` : "All clear"}</span>
          </div>
          {snapshot.items.length ? (
            <div className="payment-notification-list">
              {snapshot.items.map((item) => (
                <Link
                  className="payment-notification-item"
                  href={item.href}
                  key={item.key}
                  onClick={() => setIsOpen(false)}
                >
                  <span>
                    <strong>{item.label}</strong>
                    <small>{item.detail}</small>
                  </span>
                  <span className="payment-notification-count">{item.count > 99 ? "99+" : item.count}</span>
                </Link>
              ))}
            </div>
          ) : (
            <div className="payment-notification-empty">No payment notifications.</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
