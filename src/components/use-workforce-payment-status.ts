"use client";

import { useEffect, useMemo, useState } from "react";
import type { WorkforcePayoutRow } from "@/components/workforce-payout-table";
import { chunkedValues, mapWithConcurrency } from "@/lib/bounded-concurrency";
import { mergeWorkforcePayoutPaymentState, type WorkforcePayoutPaymentSummary } from "@/lib/workforce-payout-payment-summary";

export function useWorkforcePaymentStatus(sourceRows: WorkforcePayoutRow[], audience: "workforce" | "helpers", periodStart: string, periodEnd: string) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    source: WorkforcePayoutRow[];
    summaries: Map<string, WorkforcePayoutPaymentSummary>;
    loading: boolean;
    error: boolean;
  }>({ source: sourceRows, summaries: new Map(), loading: false, error: false });

  useEffect(() => {
    const missing = [...new Map(sourceRows.flatMap((row) => !row.paymentSummary && row.reviewSubjectId && row.locationId
      ? [[`${row.reviewSubjectId.toLowerCase()}|${row.locationId.toLowerCase()}`, { workforceId: row.reviewSubjectId, stationId: row.locationId }] as const]
      : [])).values()];
    const end = new Date(`${periodStart}T00:00:00Z`);
    if (!Number.isNaN(end.getTime())) { end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0); }
    if (audience !== "workforce" || !periodStart.endsWith("-01") || Number.isNaN(end.getTime()) || end.toISOString().slice(0, 10) !== periodEnd || !missing.length) return;
    const controller = new AbortController();
    let cancelled = false;
    setState({ source: sourceRows, summaries: new Map(), loading: true, error: false });
    void (async () => {
      const summaries = new Map<string, WorkforcePayoutPaymentSummary>();
      let failed = false;
      await mapWithConcurrency(chunkedValues(missing, 50), 2, async (rows) => {
        if (cancelled) return;
        try {
          const response = await fetch("/api/payments/workforce-payouts/payment-preview", {
            method: "POST", cache: "no-store", signal: controller.signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ periodStart, periodEnd, rows })
          });
          if (!response.ok) throw new Error("Payment status unavailable");
          const result = await response.json();
          if (!Array.isArray(result.rows)) throw new Error("Payment status unavailable");
          for (const preview of result.rows) {
            const currentNetAmount = Number(preview.current_target_amount ?? 0);
            const paidAmount = Number(preview.paid_amount ?? 0);
            summaries.set(`${String(preview.workforce_id).toLowerCase()}|${String(preview.station_id).toLowerCase()}`, {
              currentNetAmount, paidAmount,
              processingAmount: Number(preview.processing_amount ?? 0),
              balancePayable: Number(preview.balance_payable ?? 0),
              availableToPay: Number(preview.available_to_pay ?? 0),
              overpaidAmount: Math.max(0, Math.round((paidAmount - currentNetAmount) * 100) / 100),
              historyCount: Number(preview.history_count ?? 0),
              status: preview.payment_status ?? null,
              eligible: preview.eligible === true,
              eligibilityCode: String(preview.eligibility_code ?? "").trim() || null,
              eligibilityMessage: String(preview.eligibility_message ?? "").trim() || null
            });
          }
        } catch { if (!cancelled) failed = true; }
      });
      if (!cancelled) setState({ source: sourceRows, summaries, loading: false, error: failed });
    })();
    return () => { cancelled = true; controller.abort(); };
  }, [sourceRows, audience, periodStart, periodEnd, attempt]);

  const rows = useMemo(() => state.source !== sourceRows ? sourceRows : sourceRows.map((row) => {
    const summary = row.reviewSubjectId && row.locationId
      ? state.summaries.get(`${row.reviewSubjectId.toLowerCase()}|${row.locationId.toLowerCase()}`) : undefined;
    return summary ? mergeWorkforcePayoutPaymentState(row, {
      ...row, paymentSummary: summary, publicationPaymentReady: summary.eligible === true
    }, audience) : row;
  }), [sourceRows, state.source, state.summaries, audience]);
  return { rows, loading: state.source === sourceRows && state.loading, error: state.source === sourceRows && state.error, retry: () => setAttempt((n) => n + 1) };
}
