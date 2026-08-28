"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { StatusPill } from "@/components/status-pill";
import {
  executiveDisplayName,
  formatAmount,
  type ExecutiveReconciliationViewRow
} from "@/lib/ops-pulse/cod";
import { deleteExecutiveReconciliation, saveExecutiveReconciliation } from "./cash-entry-actions";

type OptimisticSavedCashRow = ExecutiveReconciliationViewRow & {
  optimisticSync?: boolean;
};

const denominations = [
  ["cash_500_count", "500", 500],
  ["cash_200_count", "200", 200],
  ["cash_100_count", "100", 100],
  ["cash_50_count", "50", 50],
  ["cash_20_count", "20", 20],
  ["cash_10_count", "10", 10]
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

function numberValue(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Mirrors reconciliationStatus() in actions.ts — the status this row will be saved with. */
function liveReconciliationStatus(expectedAmount: number, collectedAmount: number) {
  if (expectedAmount === 0 && collectedAmount === 0) return "Pending";
  const difference = Number((collectedAmount - expectedAmount).toFixed(2));
  if (Math.abs(difference) < 0.01) return "Completed";
  return difference < 0 ? "Pending Amount" : "Mismatch";
}

/** Editable fields that drive the live Received/Returned/Net kept/Expected totals. */
type SavedRowEdits = {
  expectedAmount: string;
  denominationCounts: Record<DenominationField, string>;
  returnDenominationCounts: Record<DenominationField, string>;
  cashOtherAmount: string;
  returnCashOtherAmount: string;
};

function rowEditsFromRow(row: ExecutiveReconciliationViewRow): SavedRowEdits {
  const denominationCounts = {} as Record<DenominationField, string>;
  const returnDenominationCounts = {} as Record<DenominationField, string>;
  for (const [field] of denominations) {
    denominationCounts[field] = String(denominationValue(row, field));
    returnDenominationCounts[field] = String(returnDenominationValue(row, returnDenominationFieldMap[field]));
  }
  return {
    expectedAmount: String(row.expected_amount ?? 0),
    denominationCounts,
    returnDenominationCounts,
    cashOtherAmount: String(row.cash_other_amount ?? 0),
    returnCashOtherAmount: String(row.return_cash_other_amount ?? 0)
  };
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
  // Live edits for denomination/expected fields, keyed by row.key — a row with no entry
  // here just falls back to its server value (rowEditsFromRow), so a fresh row or one
  // reset after a successful update needs no extra sync logic.
  const [edits, setEdits] = useState<Record<string, SavedRowEdits>>({});

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
        const rowPending = activeKey === row.key;
        const rowError = errorByKey[row.key];
        const state = edits[row.key] ?? rowEditsFromRow(row);
        const patchEdits = (partial: Partial<SavedRowEdits>) => {
          setEdits((current) => ({ ...current, [row.key]: { ...(current[row.key] ?? rowEditsFromRow(row)), ...partial } }));
        };
        const collectedAmount = denominations.reduce(
          (total, [name, , amount]) => total + numberValue(state.denominationCounts[name]) * amount,
          numberValue(state.cashOtherAmount)
        );
        const returnAmount = denominations.reduce(
          (total, [name, , amount]) => total + numberValue(state.returnDenominationCounts[name]) * amount,
          numberValue(state.returnCashOtherAmount)
        );
        const netCollectedAmount = Number((collectedAmount - returnAmount).toFixed(2));
        const expectedAmount = numberValue(state.expectedAmount);
        const difference = Number((netCollectedAmount - expectedAmount).toFixed(2));
        const liveStatus = liveReconciliationStatus(expectedAmount, netCollectedAmount);
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
                      setEdits((current) => {
                        if (!(row.key in current)) return current;
                        const next = { ...current };
                        delete next[row.key];
                        return next;
                      });
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
                  <input
                    className="field"
                    name="expected_amount"
                    value={state.expectedAmount}
                    onChange={(event) => patchEdits({ expectedAmount: event.target.value })}
                    inputMode="decimal"
                  />
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
                            setEdits((current) => {
                              if (!(row.key in current)) return current;
                              const next = { ...current };
                              delete next[row.key];
                              return next;
                            });
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
                      <span className="cash-breakdown-subtotal">{formatAmount(collectedAmount)}</span>
                    </div>
                    <div className="denomination-grid">
                      {denominations.map(([name, label]) => (
                        <label className="denomination-chip" key={`${row.key}-${name}`}>
                          <span className="denomination-chip-label">₹{label}</span>
                          <input
                            className="field"
                            name={name}
                            value={state.denominationCounts[name]}
                            onChange={(event) => patchEdits({ denominationCounts: { ...state.denominationCounts, [name]: event.target.value } })}
                            inputMode="numeric"
                          />
                        </label>
                      ))}
                      <label className="denomination-chip other">
                        <span className="denomination-chip-label">Other</span>
                        <input
                          className="field"
                          name="cash_other_amount"
                          value={state.cashOtherAmount}
                          onChange={(event) => patchEdits({ cashOtherAmount: event.target.value })}
                          inputMode="decimal"
                        />
                      </label>
                    </div>
                  </div>
                  <div className="cash-breakdown-section returned">
                    <div className="cash-breakdown-section-head">
                      <strong>Returned to associate</strong>
                      <span className="cash-breakdown-subtotal">{formatAmount(returnAmount)}</span>
                    </div>
                    <div className="denomination-grid">
                      {denominations.map(([name, label]) => (
                        <label className="denomination-chip" key={`${row.key}-return-${name}`} aria-label={`₹${label} returned`}>
                          <span className="denomination-chip-label">₹{label}</span>
                          <input
                            className="field"
                            name={returnDenominationFieldMap[name]}
                            value={state.returnDenominationCounts[name]}
                            onChange={(event) => patchEdits({ returnDenominationCounts: { ...state.returnDenominationCounts, [name]: event.target.value } })}
                            inputMode="numeric"
                          />
                        </label>
                      ))}
                      <label className="denomination-chip other" aria-label="Coins or other returned">
                        <span className="denomination-chip-label">Other</span>
                        <input
                          className="field"
                          name="return_cash_other_amount"
                          value={state.returnCashOtherAmount}
                          onChange={(event) => patchEdits({ returnCashOtherAmount: event.target.value })}
                          inputMode="decimal"
                        />
                      </label>
                    </div>
                  </div>
                </div>
              </details>
              <div className={`cash-live-status ${difference < -0.005 ? "short" : difference > 0.005 ? "excess" : "matched"}`} aria-live="polite">
                <span>Collected <strong>{formatAmount(collectedAmount)}</strong></span>
                <span>Returned <strong>{formatAmount(returnAmount)}</strong></span>
                <span>Net kept <strong>{formatAmount(netCollectedAmount)}</strong></span>
                <span>Expected <strong>{formatAmount(expectedAmount)}</strong></span>
                <span className="cash-live-result">
                  <StatusPill status={liveStatus} />{" "}
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
