"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { MouseEvent, ReactNode } from "react";
import { useEffect, useState } from "react";

type PendingLinkProps = {
  href: string;
  children: ReactNode;
  className?: string;
  disableWhenCurrent?: boolean;
  scroll?: boolean;
  title?: string;
  "aria-label"?: string;
  /**
   * Defaults to true to preserve the searchParams-only-navigation fix below.
   * Set to false for a plain full-page navigation back to a route whose
   * content genuinely hasn't changed (e.g. a "back to list" link) so the
   * destination can be served from the client Router Cache instead of
   * forcing a fresh server render every time.
   */
  refresh?: boolean;
};

export function PendingLink({
  "aria-label": ariaLabel,
  children,
  className,
  disableWhenCurrent = false,
  href,
  refresh = true,
  scroll,
  title
}: PendingLinkProps) {
  const [loading, setLoading] = useState(false);
  const iconOnly = className?.includes("icon-button") ?? false;
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentUrl = `${pathname}${searchParams.toString() ? `?${searchParams.toString()}` : ""}`;
  const isCurrent = disableWhenCurrent && (currentUrl === href || pathname === href);

  useEffect(() => {
    setLoading(false);
  }, [currentUrl]);

  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }

    if (isCurrent) {
      event.preventDefault();
      return;
    }

    event.preventDefault();
    setLoading(true);
    router.push(href, { scroll });
    // App Router's client-side segment cache can serve a stale prefetch for
    // a searchParams-only navigation (e.g. a row of "Manage" links that
    // differ only by ?editRole=<id> — every row gets auto-prefetched once
    // visible). That shows the URL updating with no modal until a manual
    // refresh. router.refresh() forces a fresh server render right after
    // the push so the new searchParams-derived content always appears.
    // Callers that know their destination's content can't have changed
    // (e.g. a "back to list" link) pass refresh={false} to skip this and
    // let the client Router Cache serve the previous render instantly.
    if (refresh) router.refresh();
  }

  return (
    <Link
      aria-label={ariaLabel}
      aria-current={isCurrent ? "page" : undefined}
      aria-disabled={isCurrent ? true : undefined}
      className={`${className ?? ""} ${loading ? "loading" : ""} ${isCurrent ? "current disabled-current" : ""}`.trim()}
      href={href}
      onClick={handleClick}
      onFocus={() => router.prefetch(href)}
      onMouseEnter={() => router.prefetch(href)}
      prefetch
      scroll={scroll}
      title={title}
    >
      {loading ? <span className="inline-spinner" aria-hidden="true" /> : null}
      {loading && iconOnly ? null : children}
    </Link>
  );
}
