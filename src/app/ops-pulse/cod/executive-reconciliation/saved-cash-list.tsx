"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { StatusPill } from "@/components/status-pill";
import {
  amountValue,
  executiveDisplayName,
  formatAmount,
  type ExecutiveReconciliationViewRow
} from "@/lib/ops-pulse/cod";
import { deleteExecutiveReconciliation, saveExecutiveReconciliation } from "./cash-entry-actions";

type OptimisticSavedCashRow = ExecutiveReconciliationViewRow & {
  optimisticSync?: boolean;
};

const denominations = [
  ["cash_500_count", "500"],
  ["cash_200_count", "200"],
  ["cash_100_count", "100"],
  ["cash_50_count", "50"],
  ["cash_20_count", "20"],
  ["cash_10_count", "10"]
] as const;

type DenominationField = typeof denominations[number][0];
type ReturnDenominationField =
  | "return_cash_500_count"
  | "return_cash_200_count"
  | "return_cash_100_count"
  | "return_cash_50_count"
  | "return_cash_20_count"
  | "return_cash_10_count";

const returnDenominationFieldMap: Record<DenominationField, ReturnDenominationField> = {
  cash_500_count: "return_cash_500_count",
  cash_200_count: "return_cash_200_count",
  cash_100_count: "return_cash_100_count",
  cash_50_count: "return_cash_50_count",
  cash_20_count: "return_cash_20_count",
  cash_10_count: "return_cash_10_count"
};

function denominationValue(row: ExecutiveReconciliationViewRow, field: DenominationField) {
  return row[field] ?? 0;
}

function returnDenominationValue(row: ExecutiveReconciliationViewRow, field: ReturnDenominationField) {
  return row[field] ?? 0;
}

function differenceLabel(value: number) {
  if (value < 0) return `Short ${formatAmount(Math.abs(value))}`;
  if (value > 0) return `Excess ${formatAmount(value)}`;
  return "0.00";
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function amountValueFromUnknown(value: unknown): number | string | null | undefined {
  if (value == null) return value;
  if (typeof value === "number" || typeof value === "string") return value;
  return undefined;
}

type PendingDetail = ExecutiveReconciliationViewRow["scc_pending_details"] extends (infer Item)[] | null ? Item : never;

function detailTrackingId(detail: PendingDetail, index: number) {
  const raw = objectValue(detail.raw_row);
  return stringValue(raw.trackingId) || stringValue(raw.tracking_id) || `Pending item ${index + 1}`;
}

function detailAmount(detail: PendingDetail): number | string | null | undefined {
  const raw = objectValue(detail.raw_row);
  return detail.amount
    ?? amountValueFromUnknown(raw.amount)
    ?? amountValueFromUnknown(raw.pendingAmount);
}

function detailStatus(detail: PendingDetail) {
  const raw = objectValue(detail.raw_row);
  return stringValue(detail.status) || stringValue(raw.status) || stringValue(raw.state) || "Pending";
}

function detailDescription(detail: PendingDetail) {
  const direct = stringValue(detail.description);
  if (direct) return direct;
  const raw = objectValue(detail.raw_row);
  return stringValue(raw.description) || stringValue(raw.reason) || stringValue(raw.notes) || "Pending in SCC";
}

function PendingReconDetails({ row }: { row: ExecutiveReconciliationViewRow }) {
  const details = Array.isArray(row.scc_pending_details) ? row.scc_pending_details : [];
  return (
    <details className="scc-pending-details">
      <summary>
        <span className="associate-name-link">{executiveDisplayName(row)}</span>
        <span className="subtle">SCC pending {formatAmount(row.scc_pending_amount)}</span>
      </summary>
      <div className="scc-pending-panel">
        <p className="subtle">Open pending items from the latest SCC reconciliation snapshot.</p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tracking ID</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {details.length ? details.map((detail, index) => (
                <tr key={`${row.key}-pending-${index}`}>
                  <td>{detailTrackingId(detail, index)}</td>
                  <td>{formatAmount(detailAmount(detail))}</td>
                  <td>{detailStatus(detail)}</td>
                  <td>{detailDescription(detail)}</td>
                </tr>
              )) : (
                <tr><td className="empty-cell" colSpan={4}>No SCC pending details available.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  );
}

export function SavedCashList({
  rows,
  canEdit,
  isFinalSubmitted,
  returnHref
}: {
  rows: ExecutiveReconciliationViewRow[];
  canEdit: boolean;
  isFinalSubmitted: boolean;
  returnHref: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<"update" | "delete" | null>(null);
  const [errorByKey, setErrorByKey] = useState<Record<string, string>>({});
  const [localRows, setLocalRows] = useState(rows);
  const [optimisticRows, setOptimisticRows] = useState<OptimisticSavedCashRow[]>([]);

  useEffect(() => {
    setLocalRows(rows);
    setOptimisticRows((current) => current.filter((row) => !rows.some((serverRow) =>
      serverRow.business_date === row.business_date
      && serverRow.location_id === row.location_id
      && serverRow.provider_employee_id === row.provider_employee_id
    )));
  }, [rows]);

  useEffect(() => {
    function handleSaved(event: Event) {
      const detail = (event as CustomEvent<OptimisticSavedCashRow>).detail;
      if (!detail) return;
      setOptimisticRows((current) => {
        const filtered = current.filter((row) => !(
          row.business_date === detail.business_date
          && row.location_id === detail.location_id
          && row.provider_employee_id === detail.provider_employee_id
        ));
        return [detail, ...filtered];
      });
    }

    window.addEventListener("executive-reconciliation:saved", handleSaved as EventListener);
    return () => window.removeEventListener("executive-reconciliation:saved", handleSaved as EventListener);
  }, []);

  const displayRows: OptimisticSavedCashRow[] = [
    ...optimisticRows.filter((row) => !localRows.some((serverRow) =>
      serverRow.business_date === row.business_date
      && serverRow.location_id === row.location_id
      && serverRow.provider_employee_id === row.provider_employee_id
    )),
    ...localRows.map((serverRow) => {
      const overlay = optimisticRows.find((row) =>
        row.business_date === serverRow.business_date
        && row.location_id === serverRow.location_id
        && row.provider_employee_id === serverRow.provider_employee_id
      );
      if (!overlay) return serverRow;
      return {
        ...serverRow,
        expected_amount: overlay.expected_amount,
        cash_500_count: overlay.cash_500_count,
        cash_200_count: overlay.cash_200_count,
        cash_100_count: overlay.cash_100_count,
        cash_50_count: overlay.cash_50_count,
        cash_20_count: overlay.cash_20_count,
        cash_10_count: overlay.cash_10_count,
        cash_other_amount: overlay.cash_other_amount,
        return_cash_500_count: overlay.return_cash_500_count,
        return_cash_200_count: overlay.return_cash_200_count,
        return_cash_100_count: overlay.return_cash_100_count,
        return_cash_50_count: overlay.return_cash_50_count,
        return_cash_20_count: overlay.return_cash_20_count,
        return_cash_10_count: overlay.return_cash_10_count,
        return_cash_other_amount: overlay.return_cash_other_amount,
        collected_amount: overlay.collected_amount,
        pending_amount: overlay.pending_amount,
        difference_amount: overlay.difference_amount,
        reconciliation_status: overlay.reconciliation_status,
        optimisticSync: true
      };
    })
  ];

  return (
    <div className="reconciliation-entry-list reconciliation-saved-list" aria-label="Executive reconciliation sheet">
      {displayRows.length ? displayRows.map((row) => {
        const difference = amountValue(row.difference_amount);
        const returnedAmount =
          amountValue(row.return_cash_500_count) * 500
          + amountValue(row.return_cash_200_count) * 200
          + amountValue(row.return_cash_100_count) * 100
          + amountValue(row.return_cash_50_count) * 50
          + amountValue(row.return_cash_20_count) * 20
          + amountValue(row.return_cash_10_count) * 10
          + amountValue(row.return_cash_other_amount);
        const rowPending = activeKey === row.key;
        const rowError = errorByKey[row.key];
        return (
          <article className="reconciliation-entry-card" key={row.key}>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!canEdit || isFinalSubmitted || rowPending) return;
                const form = event.currentTarget;
                const formData = new FormData(form);
                formData.set("response_mode", "client");
                setErrorByKey((current) => ({ ...current, [row.key]: "" }));
                setActiveKey(row.key);
                setActiveAction("update");
                void (async () => {
                  try {
                    const result = await saveExecutiveReconciliation(formData);
                    if (result?.ok) {
                      setActiveKey(null);
                      setActiveAction(null);
                      startTransition(() => router.refresh());
                      return;
                    }
                    setErrorByKey((current) => ({ ...current, [row.key]: result?.error ?? "Unable to update cash entry." }));
                    setActiveKey(null);
                    setActiveAction(null);
                  } catch (error) {
                    setErrorByKey((current) => ({ ...current, [row.key]: error instanceof Error ? error.message : "Unable to update cash entry." }));
                    setActiveKey(null);
                    setActiveAction(null);
                  }
                })();
              }}
            >
              <div className="reconciliation-entry-grid reconciliation-saved-grid">
                <div>
                  <span className="reconciliation-field-label">Associate</span>
                  {row.source_associate_name ? (
                    <PendingReconDetails row={row} />
                  ) : (
                    <input className="field" name="manual_associate_name" defaultValue={row.manual_associate_name ?? ""} placeholder="Associate name" required />
                  )}
                  <span className="subtle">{row.provider_employee_id} · {row.shipment_type ?? "SCC Driver Reconciliation"}</span>
                </div>
                <label>Expected COD
                  <input className="field" name="expected_amount" defaultValue={String(row.expected_amount ?? 0)} inputMode="decimal" />
                </label>
                <label>Remarks
                  <input className="field" name="remarks" defaultValue={row.remarks ?? ""} placeholder="Optional note" />
                </label>
                <div className="reconciliation-row-actions">
                  <input type="hidden" name="return_href" value={returnHref} />
                  <input type="hidden" name="business_date" value={row.business_date} />
                  <input type="hidden" name="location_id" value={row.location_id ?? ""} />
                  <input type="hidden" name="station_code" value={row.station_code} />
                  <input type="hidden" name="provider_employee_id" value={row.provider_employee_id} />
                  <input type="hidden" name="source_associate_name" value={row.source_associate_name ?? ""} />
                  <input type="hidden" name="shipment_type" value={row.shipment_type ?? ""} />
                  <input type="hidden" name="total_delivery" value={String(row.total_delivery ?? 0)} />
                  <input type="hidden" name="total_activity" value={String(row.total_activity ?? 0)} />
                  <button className="button secondary" disabled={!canEdit || isFinalSubmitted || rowPending || Boolean(row.optimisticSync)} type="submit">
                    {rowPending && activeAction === "update" ? "Updating..." : "Update"}
                  </button>
                  <button
                    className="button ghost"
                    disabled={!canEdit || isFinalSubmitted || rowPending || Boolean(row.optimisticSync)}
                    onClick={(event) => {
                      event.preventDefault();
                      if (!window.confirm(`Delete saved cash entry for ${executiveDisplayName(row)}?`)) return;
                      const form = event.currentTarget.form;
                      if (!form) return;
                      const formData = new FormData(form);
                      formData.set("response_mode", "client");
                      setErrorByKey((current) => ({ ...current, [row.key]: "" }));
                      setActiveKey(row.key);
                      setActiveAction("delete");
                      void (async () => {
                        try {
                          const result = await deleteExecutiveReconciliation(formData);
                          if (result?.ok) {
                            window.dispatchEvent(new CustomEvent("executive-reconciliation:deleted", {
                              detail: {
                                provider_employee_id: row.provider_employee_id
                              }
                            }));
                            setLocalRows((current) => current.filter((item) => item.key !== row.key));
                            setOptimisticRows((current) => current.filter((item) => item.key !== row.key));
                            setActiveKey(null);
                            setActiveAction(null);
                            startTransition(() => router.refresh());
                            return;
                          }
                          setErrorByKey((current) => ({ ...current, [row.key]: result?.error ?? "Unable to delete cash entry." }));
                          setActiveKey(null);
                          setActiveAction(null);
                        } catch (error) {
                          setErrorByKey((current) => ({ ...current, [row.key]: error instanceof Error ? error.message : "Unable to delete cash entry." }));
                          setActiveKey(null);
                          setActiveAction(null);
                        }
                      })();
                    }}
                    type="button"
                  >
                    {rowPending && activeAction === "delete" ? "Deleting..." : "Delete"}
                  </button>
                </div>
              </div>
              <details className="cash-breakdown">
                <summary>Cash denomination count</summary>
                <div className="cash-breakdown-grid">
                  <div className="cash-breakdown-section received">
                    <div className="cash-breakdown-section-head">
                      <strong>Received from associate</strong>
                      <span className="cash-breakdown-subtotal">{formatAmount(row.collected_amount)}</span>
                    </div>
                    <div className="denomination-grid">
                      {denominations.map(([name, label]) => (
                        <label className="denomination-chip" key={`${row.key}-${name}`}>
                          <span className="denomination-chip-label">₹{label}</span>
                          <input className="field" name={name} defaultValue={String(denominationValue(row, name))} inputMode="numeric" />
                        </label>
                      ))}
                      <label className="denomination-chip other">
                        <span className="denomination-chip-label">Coins / other</span>
                        <input className="field" name="cash_other_amount" defaultValue={String(row.cash_other_amount ?? 0)} inputMode="decimal" />
                      </label>
                    </div>
                  </div>
                  <div className="cash-breakdown-section returned">
                    <div className="cash-breakdown-section-head">
                      <strong>Returned to associate</strong>
                      <span className="cash-breakdown-subtotal">{formatAmount(returnedAmount)}</span>
                    </div>
                    <div className="denomination-grid">
                      {denominations.map(([name, label]) => (
                        <label className="denomination-chip" key={`${row.key}-return-${name}`} aria-label={`₹${label} returned`}>
                          <span className="denomination-chip-label">₹{label}</span>
                          <input
                            className="field"
                            name={returnDenominationFieldMap[name]}
                            defaultValue={String(returnDenominationValue(row, returnDenominationFieldMap[name]))}
                            inputMode="numeric"
                          />
                        </label>
                      ))}
                      <label className="denomination-chip other" aria-label="Coins or other returned">
                        <span className="denomination-chip-label">Coins / other</span>
                        <input className="field" name="return_cash_other_amount" defaultValue={String(row.return_cash_other_amount ?? 0)} inputMode="decimal" />
                      </label>
                    </div>
                  </div>
                </div>
              </details>
              <div className={`cash-live-status ${difference < -0.005 ? "short" : difference > 0.005 ? "excess" : "matched"}`}>
                <span>Collected <strong>{formatAmount(row.collected_amount)}</strong></span>
                <span>Returned <strong>{formatAmount(returnedAmount)}</strong></span>
                <span>Expected <strong>{formatAmount(row.expected_amount)}</strong></span>
                <span className="cash-live-result">
                  <StatusPill status={row.reconciliation_status} />{" "}
                  <strong>{differenceLabel(difference)}</strong>
                </span>
              </div>
              {row.optimisticSync ? (
                <p className="subtle" style={{ marginTop: 8 }}>Syncing saved cash to the server...</p>
              ) : null}
              {rowError ? <p className="field-error">{rowError}</p> : null}
            </form>
          </article>
        );
      }) : (
        <div className="panel-body"><p className="subtle">No saved cash entries.</p></div>
      )}
    </div>
  );
}
