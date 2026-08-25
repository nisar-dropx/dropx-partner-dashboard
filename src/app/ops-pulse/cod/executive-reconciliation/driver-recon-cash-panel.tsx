"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { StatusPill } from "@/components/status-pill";
import {
  associateCiaPendingAmount,
  moneyValue,
  type CashReconAssociate,
  type CashReconPendingBreakdown,
  type CashReconRow
} from "@/lib/ops-pulse/cash-recon-types";
import {
  driverReconCacheKey,
  readLatestDriverReconCache,
  writeDriverReconCache,
  type DriverReconClientPayload
} from "@/lib/ops-pulse/driver-recon-client-cache";
import { confirmDriverReconForDeposit } from "./cash-entry-actions";

function currency(value: number) {
  return value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatCollectionTime(epochMs: number | null) {
  if (!epochMs || !Number.isFinite(epochMs)) return "-";
  try {
    return new Intl.DateTimeFormat("en-IN", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Kolkata"
    }).format(new Date(epochMs));
  } catch {
    return "-";
  }
}

function associateBreakdown(row: CashReconAssociate): CashReconPendingBreakdown[] {
  return [...(row.sameDayBreakdown ?? []), ...(row.breakdown ?? [])];
}

function summarizePending(payload: {
  associates?: CashReconAssociate[];
  missingFromDer?: CashReconAssociate[];
  reconciliation?: CashReconRow[];
}) {
  const byId = new Map<string, {
    id: string;
    name: string;
    pending: number;
    breakdown: CashReconPendingBreakdown[];
  }>();

  const upsert = (
    idRaw: string,
    nameRaw: string,
    pendingRaw: number,
    breakdown: CashReconPendingBreakdown[] = []
  ) => {
    const id = String(idRaw ?? "").trim().toUpperCase();
    if (!id || id === "__OTHER__") return;
    const pending = Number(pendingRaw) || 0;
    const name = String(nameRaw ?? "").trim() || id;
    const existing = byId.get(id);
    if (!existing || pending > existing.pending || (!existing.breakdown.length && breakdown.length)) {
      byId.set(id, {
        id,
        name,
        pending: existing && pending < existing.pending ? existing.pending : pending,
        breakdown: breakdown.length ? breakdown : existing?.breakdown ?? []
      });
    }
  };

  for (const row of [...(payload.associates ?? []), ...(payload.missingFromDer ?? [])]) {
    upsert(
      row.providerEmployeeId,
      row.displayName || row.name,
      associateCiaPendingAmount(row),
      associateBreakdown(row)
    );
  }

  if (![...byId.values()].some((row) => row.pending > 0.01)) {
    for (const row of payload.reconciliation ?? []) {
      upsert(
        String(row.driverInfo?.id ?? ""),
        String(row.driverInfo?.name ?? ""),
        moneyValue(row.paymentInfo?.overallPendingRecon) + moneyValue(row.paymentInfo?.sameDayPendingRecon),
        [
          ...((row.paymentInfo?.sameDayPendingReconBreakdownList ?? []).map((item) => ({
            trackingId: String(item?.trackingId ?? "").trim() || "-",
            paymentMethod: String(item?.paymentMethod ?? "").trim() || "-",
            moneyCollectionTime: typeof item?.moneyCollectionTime === "number"
              ? item.moneyCollectionTime
              : typeof item?.transactionTime === "number" ? item.transactionTime : null,
            amount: moneyValue(item?.amount),
            stationTimeZone: String(item?.stationTimeZone ?? "").trim() || "IST"
          }))),
          ...((row.paymentInfo?.overallPendingReconBreakdownList ?? []).map((item) => ({
            trackingId: String(item?.trackingId ?? "").trim() || "-",
            paymentMethod: String(item?.paymentMethod ?? "").trim() || "-",
            moneyCollectionTime: typeof item?.moneyCollectionTime === "number"
              ? item.moneyCollectionTime
              : typeof item?.transactionTime === "number" ? item.transactionTime : null,
            amount: moneyValue(item?.amount),
            stationTimeZone: String(item?.stationTimeZone ?? "").trim() || "IST"
          })))
        ]
      );
    }
  }

  const rows = Array.from(byId.values()).sort((a, b) => b.pending - a.pending || a.name.localeCompare(b.name));
  const pendingRows = rows.filter((row) => row.pending > 0.01);
  const pendingAmount = Number(pendingRows.reduce((sum, row) => sum + row.pending, 0).toFixed(2));
  return {
    driverCount: rows.length,
    pendingCount: pendingRows.length,
    pendingAmount,
    pendingRows,
    cleared: pendingRows.length === 0
  };
}

export function DriverReconCashPanel({
  stationCode,
  businessDate,
  locationId,
  returnHref,
  canRefresh,
  cashSubmitted,
  canEdit,
  driverCheckStatus
}: {
  stationCode: string;
  businessDate: string;
  locationId: string;
  returnHref: string;
  canRefresh: boolean;
  cashSubmitted: boolean;
  canEdit: boolean;
  driverCheckStatus?: string | null;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const cacheKey = useMemo(
    () => driverReconCacheKey({ stationCode, businessDate, locationId, baselineKey: "step2" }),
    [stationCode, businessDate, locationId]
  );
  const [payload, setPayload] = useState<DriverReconClientPayload | null>(() =>
    readLatestDriverReconCache({ stationCode, businessDate, locationId })
  );
  const [loading, setLoading] = useState(!payload);
  const [error, setError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [remarks, setRemarks] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const load = useCallback(async (force = false) => {
    if (!stationCode || !businessDate || !locationId) return;
    if (!force) {
      const cached = readLatestDriverReconCache({ stationCode, businessDate, locationId });
      if (cached) {
        setPayload(cached);
        setLoading(false);
        setError(null);
        return;
      }
    }
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/ops-pulse/cod/cash-recon/driver-reconciliation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stationCode, date: businessDate, locationId, baselineAssociates: [] })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error || `Unable to load driver recon (${response.status})`);
      const next: DriverReconClientPayload = {
        drivers: Array.isArray(body.drivers) ? body.drivers : [],
        reconciliation: Array.isArray(body.reconciliation) ? body.reconciliation : [],
        associates: Array.isArray(body.associates) ? body.associates : [],
        missingFromDer: Array.isArray(body.missingFromDer) ? body.missingFromDer : [],
        requiredForCashEntry: Array.isArray(body.requiredForCashEntry) ? body.requiredForCashEntry : [],
        expectedCash: body.expectedCash && typeof body.expectedCash === "object" ? body.expectedCash : null,
        sessionSource: body.sessionSource == null ? null : String(body.sessionSource)
      };
      writeDriverReconCache(cacheKey, next);
      setPayload(next);
      setCheckedAt(new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load driver reconciliation.");
    } finally {
      setLoading(false);
    }
  }, [businessDate, cacheKey, locationId, stationCode]);

  useEffect(() => {
    void load(false);
  }, [load]);

  const summary = useMemo(
    () => (payload ? summarizePending(payload) : null),
    [payload]
  );

  const alreadyUnlocked = driverCheckStatus === "Passed" || driverCheckStatus === "Exception approved";
  const statusLabel = loading
    ? "Loading…"
    : error
      ? "Check failed"
      : !summary
        ? "Not checked"
        : alreadyUnlocked
          ? (summary.cleared ? "Driver recon cleared" : "Feedback recorded · deposit unlocked")
        : summary.cleared
          ? "Driver recon cleared"
          : `Today CIA pending · ${summary.pendingCount}`;

  const checkedLabel = checkedAt
    ? new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit" }).format(new Date(checkedAt))
    : payload
      ? "Cached"
      : "Not checked";

  async function handleConfirm() {
    if (!canEdit || !cashSubmitted || submitting || !summary) return;
    if (!summary.cleared && !remarks.trim()) {
      setSubmitError("Add feedback for remaining Cash In Associate, then continue to Deposit & summary.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    const formData = new FormData();
    formData.set("response_mode", "client");
    formData.set("return_href", returnHref);
    formData.set("business_date", businessDate);
    formData.set("location_id", locationId);
    formData.set("pending_cia_amount", String(summary.pendingAmount));
    formData.set("cia_pending_remarks", remarks.trim());
    try {
      const result = await confirmDriverReconForDeposit(formData);
      if (result?.ok) {
        const nextHref = result.nextHref || returnHref;
        startTransition(() => {
          router.push(nextHref);
          router.refresh();
        });
        return;
      }
      setSubmitError(result?.error ?? "Unable to confirm driver validation.");
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Unable to confirm driver validation.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="driver-recon-cash-panel">
      <div className="portal-check-progress">
        <div>
          <span>Cash recon · Driver validation</span>
          <strong>{statusLabel}</strong>
        </div>
        <div>
          <span>Pending drivers</span>
          <strong>{summary ? summary.pendingCount : "—"}</strong>
        </div>
        <div>
          <span>Today CIA pending</span>
          <strong>{summary ? `₹${currency(summary.pendingAmount)}` : "—"}</strong>
        </div>
        <div>
          <span>Last checked</span>
          <strong>{loading ? "Checking…" : checkedLabel}</strong>
        </div>
      </div>

      <p className="subtle" style={{ marginTop: 10 }}>
        Today&apos;s Cash In Associate belongs on this page — denomination on the cash sheet does not hide it.
        If it is still open after counting, record feedback here before Deposit & summary.
      </p>

      <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <StatusPill status={statusLabel} />
        <span className="subtle">
          {payload?.sessionSource ? `Source · ${payload.sessionSource}` : "Uses ageing Cash In Associate for this date"}
        </span>
        <button
          className="button secondary"
          type="button"
          disabled={!canRefresh || loading || !cashSubmitted}
          onClick={() => { void load(true); }}
        >
          {loading ? "Checking…" : cashSubmitted ? "Recheck pending recon" : "Submit cash first"}
        </button>
      </div>

      {error ? (
        <p className="field-error">{error}</p>
      ) : null}

      {summary && summary.pendingRows.length ? (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table>
            <thead>
              <tr>
                <th>Associate</th>
                <th>Driver ID</th>
                <th>Pending recon</th>
                <th>Tracking</th>
              </tr>
            </thead>
            <tbody>
              {summary.pendingRows.map((row) => (
                <tr key={row.id}>
                  <td><strong>{row.name}</strong></td>
                  <td>{row.id}</td>
                  <td>₹{currency(row.pending)}</td>
                  <td>
                    {row.breakdown.length
                      ? row.breakdown.map((item) => (
                        <div key={`${row.id}-${item.trackingId}`}>
                          {item.trackingId} · ₹{currency(item.amount)}
                          {item.moneyCollectionTime ? ` · ${formatCollectionTime(item.moneyCollectionTime)}` : ""}
                        </div>
                      ))
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : summary && !loading ? (
        <p className="subtle" style={{ marginTop: 10 }}>
          No Cash In Associate pending across {summary.driverCount} driver{summary.driverCount === 1 ? "" : "s"}.
        </p>
      ) : null}

      {cashSubmitted && !alreadyUnlocked && summary && !loading ? (
        <div className="cash-submission-card" style={{ marginTop: 16 }}>
          <div>
            <span>Continue to Deposit & summary</span>
            <strong>{summary.cleared ? "No CIA pending" : `₹${currency(summary.pendingAmount)} still pending`}</strong>
            <small>
              {summary.cleared
                ? "Confirm driver validation to unlock bank deposit."
                : "Denomination is done on the cash sheet. Remaining today CIA needs feedback before deposit."}
            </small>
          </div>
          {!summary.cleared ? (
            <label style={{ display: "block", marginTop: 12 }}>
              Feedback
              <textarea
                className="field"
                rows={2}
                value={remarks}
                onChange={(event) => setRemarks(event.target.value)}
                placeholder="Why deposit can continue while Cash In Associate is still pending"
                required
              />
            </label>
          ) : null}
          <div className="form-actions" style={{ marginTop: 12 }}>
            <button
              className="button"
              type="button"
              disabled={!canEdit || submitting || (!summary.cleared && !remarks.trim())}
              onClick={() => { void handleConfirm(); }}
            >
              {submitting
                ? "Saving…"
                : summary.cleared
                  ? "Continue to deposit"
                  : "Record feedback & continue"}
            </button>
          </div>
          {submitError ? <p className="field-error">{submitError}</p> : null}
        </div>
      ) : null}

      {alreadyUnlocked ? (
        <p className="subtle" style={{ marginTop: 12 }}>
          Driver validation is complete. Deposit & summary is unlocked.
        </p>
      ) : null}
    </div>
  );
}
