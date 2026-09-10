"use client";

import type { ComponentProps } from "react";

/** Collapse native details without unmounting forms or discarding unsaved input. */
export function closeReviewDetails(element: HTMLElement) {
  const details = element.closest("details");
  if (!details?.open) return;
  details.open = false;
  details.querySelector<HTMLElement>(":scope > summary")?.focus({ preventScroll: true });
}

export function ReviewDetails({ children, onKeyDown, ...props }: ComponentProps<"details">) {
  return <details {...props} onKeyDown={event => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    closeReviewDetails(event.target as HTMLElement);
  }}>{children}</details>;
}

export function ReviewDetailsClose({ label = "Close details" }: { label?: string }) {
  return <div className="review-details-close-row"><button type="button" className="review-details-close" aria-label={label} onClick={event => closeReviewDetails(event.currentTarget)}><span aria-hidden="true">×</span> Close</button></div>;
}
