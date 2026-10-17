"use client";

import { useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";

export type WorkforcePayoutPublicationSelfHealRow = {
  workforceId: string;
  stationId: string;
};

const MAX_ATTEMPTS = 8;

function retryDelay(attempt: number) {
  return Math.min(30_000, 1_000 * (2 ** Math.max(0, attempt - 1)));
}

export function WorkforcePayoutPublicationSelfHeal({
  periodStart,
  periodEnd,
  rows
}: {
  periodStart: string;
  periodEnd: string;
  rows: WorkforcePayoutPublicationSelfHealRow[];
}) {
  const router = useRouter();
  const completed = useRef(new Set<string>());
  const normalized = useMemo(() => [...new Map(rows.map((row) => {
    const workforceId = row.workforceId.trim().toLowerCase();
    const stationId = row.stationId.trim().toLowerCase();
    return [`${workforceId}|${stationId}`, { workforceId, stationId }] as const;
  })).values()].sort((left, right) => `${left.workforceId}|${left.stationId}`.localeCompare(`${right.workforceId}|${right.stationId}`)), [rows]);
  const signature = useMemo(
    () => normalized.length ? JSON.stringify([periodStart, periodEnd, normalized]) : "",
    [normalized, periodEnd, periodStart]
  );

  useEffect(() => {
    if (!signature || completed.current.has(signature)) return;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    let stopped = false;

    const run = async () => {
      attempt += 1;
      controller = new AbortController();
      try {
        const result = await fetch("/api/payments/workforce-payouts/publication-refresh", {
          method: "POST",
          cache: "no-store",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ periodStart, periodEnd, rows: normalized }),
          signal: controller.signal
        });
        const payload = await result.json().catch(() => ({})) as {
          ok?: unknown;
          progress?: unknown;
          retryable?: unknown;
        };
        if (stopped || controller.signal.aborted) return;
        if (result.ok && payload.ok === true) {
          completed.current.add(signature);
          router.refresh();
          return;
        }
        if (payload.progress === true) router.refresh();
        const retryable = payload.retryable === true || result.status === 429 || result.status >= 500;
        if (retryable && attempt < MAX_ATTEMPTS) {
          timer = setTimeout(() => void run(), retryDelay(attempt));
        }
      } catch {
        if (!stopped && attempt < MAX_ATTEMPTS) {
          timer = setTimeout(() => void run(), retryDelay(attempt));
        }
      }
    };

    void run();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
    };
  }, [normalized, periodEnd, periodStart, router, signature]);

  return null;
}
