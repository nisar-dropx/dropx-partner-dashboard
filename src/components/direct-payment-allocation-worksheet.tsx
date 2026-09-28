"use client";

import { useMemo, useState } from "react";
import { saveDirectPaymentAllocation } from "@/app/provider-mapping/direct-pay/actions";
import type { DirectPaymentMethod } from "@/lib/workforce-payment-allocation";

export type DirectPaymentAllocationRow = {
  workforceId: string;
  dropxId: string;
  fullName: string;
  stationLabel: string;
  designationLabel: string;
  dateOfJoin: string;
  allocationId: string;
  paymentMethodId: string;
  currentMethodName: string;
  paymentValues: Record<string, number>;
  effectiveFrom: string;
  effectiveTo: string;
  historyCount: number;
};

function scheduleLabel(value: "per_hour" | "per_day" | "per_month" | null | undefined) {
  if (value === "per_hour") return "per hour";
  if (value === "per_day") return "per workday";
  if (value === "per_month") return "per month";
  return "configured amount";
}

function AllocationCells({
  canEdit,
  formId,
  methods,
  row
}: {
  canEdit: boolean;
  formId: string;
  methods: DirectPaymentMethod[];
  row: DirectPaymentAllocationRow;
}) {
  const currentMethodAvailable = methods.some((method) => method.id === row.paymentMethodId);
  const [methodId, setMethodId] = useState(currentMethodAvailable ? row.paymentMethodId : "");
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(
    Object.entries(row.paymentValues).map(([code, value]) => [code, String(value)])
  ));
  const method = methods.find((option) => option.id === methodId) ?? null;
  const methodValues = method
    ? Object.fromEntries(method.components.map((component) => [component.code, values[component.code] ?? ""]))
    : {};

  return (
    <>
      <td style={{ minWidth: 210 }}>
        <input form={formId} name="workforce_id" type="hidden" value={row.workforceId} />
        <input form={formId} name="payment_values_json" type="hidden" value={JSON.stringify(methodValues)} />
        <select
          className="select"
          disabled={!canEdit}
          form={formId}
          name="payment_method_id"
          onChange={(event) => {
            const nextMethodId = event.target.value;
            setMethodId(nextMethodId);
            setValues(nextMethodId === row.paymentMethodId
              ? Object.fromEntries(Object.entries(row.paymentValues).map(([code, value]) => [code, String(value)]))
              : {});
          }}
          required
          value={methodId}
        >
          <option value="">Select method</option>
          {methods.map((option) => <option key={option.id} value={option.id}>{option.code} - {option.name}</option>)}
        </select>
        {row.paymentMethodId && !currentMethodAvailable
          ? <small className="subtle" style={{ display: "block", marginTop: 5 }}>Current method “{row.currentMethodName || row.paymentMethodId}” is no longer eligible for direct pay.</small>
          : null}
      </td>
      <td style={{ minWidth: 250 }}>
        {method ? method.components.map((component) => <label key={component.code} style={{ display: "grid", gap: 4, marginBottom: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 700 }}>{component.label} · {scheduleLabel(component.schedule)}</span>
          <input
            className="field"
            disabled={!canEdit}
            form={formId}
            inputMode="decimal"
            min="0"
            onChange={(event) => setValues((current) => ({ ...current, [component.code]: event.target.value }))}
            required
            step="0.01"
            type="number"
            value={values[component.code] ?? ""}
          />
        </label>) : <span className="subtle">Select an attendance, workday or fixed-amount method.</span>}
      </td>
      <td style={{ minWidth: 150 }}>
        <input className="field" defaultValue={row.effectiveFrom} disabled={!canEdit} form={formId} name="effective_from" required type="date" />
      </td>
      <td style={{ minWidth: 150 }}>
        <input className="field" defaultValue={row.effectiveTo} disabled={!canEdit} form={formId} name="effective_to" type="date" />
      </td>
      <td style={{ minWidth: 190 }}>
        <input className="field" disabled={!canEdit} form={formId} maxLength={500} name="change_reason" placeholder="Reason for change" />
      </td>
      <td style={{ minWidth: 105 }}>
        <button className="button compact" disabled={!methodId || !canEdit} form={formId} type="submit">Save</button>
        <small className="subtle" style={{ display: "block", marginTop: 6 }}>
          {row.allocationId ? `${row.historyCount} histor${row.historyCount === 1 ? "y" : "ies"}` : "Not allocated"}
        </small>
      </td>
    </>
  );
}

export function DirectPaymentAllocationWorksheet({
  canEdit,
  initialQuery = "",
  methods,
  productionMethodCount,
  rows
}: {
  canEdit: boolean;
  initialQuery?: string;
  methods: DirectPaymentMethod[];
  productionMethodCount: number;
  rows: DirectPaymentAllocationRow[];
}) {
  const [query, setQuery] = useState(initialQuery);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => [row.dropxId, row.fullName, row.stationLabel, row.designationLabel]
      .some((value) => value.toLocaleLowerCase().includes(needle)));
  }, [query, rows]);

  return (
    <section className="panel">
      <div className="panel-body" style={{ display: "grid", gap: 14 }}>
        <div hidden>
          {filtered.map((row) => <form action={saveDirectPaymentAllocation} id={`direct-allocation-${row.workforceId}`} key={row.workforceId} />)}
        </div>
        <div style={{ alignItems: "end", display: "flex", flexWrap: "wrap", gap: 12, justifyContent: "space-between" }}>
          <label style={{ display: "grid", gap: 5, minWidth: 280 }}>
            <span className="subtle">Search direct-pay workforce</span>
            <input className="field" onChange={(event) => setQuery(event.target.value)} placeholder="DropX ID, name, location or designation" type="search" value={query} />
          </label>
          <div className="subtle">
            {filtered.length} of {rows.length} people · {methods.length} eligible payment methods
          </div>
        </div>
        {productionMethodCount > 0 ? <div className="message-panel" style={{ margin: 0 }}>
          <strong>{productionMethodCount} production-based method{productionMethodCount === 1 ? " is" : "s are"} hidden</strong>
          <p className="subtle" style={{ margin: "4px 0 0" }}>Direct allocations accept attendance, workday and fixed-amount components only.</p>
        </div> : null}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>DropX ID</th>
              <th>Person</th>
              <th>Location</th>
              <th>Designation</th>
              <th>Payment method</th>
              <th>Configured values</th>
              <th>Effective from</th>
              <th>Effective to</th>
              <th>Change reason</th>
              <th>Save</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length ? filtered.map((row) => <tr key={row.workforceId}>
              <td><strong>{row.dropxId}</strong></td>
              <td>{row.fullName}</td>
              <td>{row.stationLabel}</td>
              <td>{row.designationLabel}</td>
              <AllocationCells canEdit={canEdit} formId={`direct-allocation-${row.workforceId}`} methods={methods} row={row} />
            </tr>) : <tr><td className="empty-cell" colSpan={10}>No direct-pay workforce records match this search.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
