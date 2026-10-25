"use client";
import type { ReactNode } from "react";
/** Keep supporting fields compact without hiding validation errors from the user. */
export function PaymentResubmissionFields({ children, title, description, open = false }: { children: ReactNode; title: string; description?: string; open?: boolean }) {
  return <details className="resubmit-disclosure resubmit-supporting" open={open || undefined} onInvalidCapture={event => { event.currentTarget.open = true; }}>
    <summary>{title}{description ? <span>{description}</span> : null}</summary>
    <div className="form-grid two">{children}</div>
  </details>;
}
