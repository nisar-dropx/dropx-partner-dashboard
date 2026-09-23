export type AdhocPayment = {
  id: string; request_no: string; location_id: string; station_code: string | null; location_code: string | null;
  work_date: string; created_at: string; status: string; amount: number | string | null; amount_requested: number | string | null; amount_approved: number | string | null;
  processed_at: string | null; paid_at: string | null; utr_cin: string | null;
  adhoc_work_date: string | null; adhoc_da_name: string | null; adhoc_client: string | null; adhoc_provider_employee_id: string | null;
  adhoc_workforce_id: string | null; adhoc_adjustment_id: string | null;
};
export type AdhocShipment = { station_code: string; client: string; provider_employee_id: string; work_date: string; amazon_delivery: number | string; total_delivery: number | string };
export type AdhocAdjustment = { id: string; amount: number | string; effective_date: string; status: string; payroll_run_id: string | null };
const n = (value: unknown) => Number(value ?? 0) || 0;
const round = (value: number) => Math.round(value * 100) / 100;
export const isAdhocPaid = (status: string) => ["processed", "paid"].includes(status.toLowerCase());

export function adhocDaReport(payments: AdhocPayment[], shipments: AdhocShipment[], adjustments: AdhocAdjustment[]) {
  const adjustmentById = new Map(adjustments.map(row => [row.id, row]));
  const key = (station: string, client: string, id: string) => JSON.stringify([station, client, id]);
  const shipmentCounts = new Map<string, { amazon: number; delivered: number }>();
  for (const row of shipments) {
    const id = key(row.station_code, row.client, row.provider_employee_id);
    const count = shipmentCounts.get(id) ?? { amazon: 0, delivered: 0 };
    count.amazon += n(row.amazon_delivery); count.delivered += n(row.total_delivery); shipmentCounts.set(id, count);
  }
  const groups = new Map<string, { station: string; client: string; providerId: string; name: string; workforceId: string; requests: number; requested: number; paid: number; recovered: number; pending: number; tracked: boolean }>();
  const details = payments.map(row => {
    const station = row.station_code || row.location_code || "", tracked = Boolean(row.adhoc_workforce_id);
    const groupKey = key(station, row.adhoc_client || "", row.adhoc_provider_employee_id || `UNLINKED:${row.id}`);
    const group = groups.get(groupKey) ?? { station, client: row.adhoc_client || "", providerId: row.adhoc_provider_employee_id || "UNLINKED", name: row.adhoc_da_name || "Historical request — DA not captured", workforceId: row.adhoc_workforce_id || "", requests: 0, requested: 0, paid: 0, recovered: 0, pending: 0, tracked };
    const paid = isAdhocPaid(row.status) ? n(row.amount_approved ?? row.amount ?? row.amount_requested) : 0;
    const deduction = row.adhoc_adjustment_id ? adjustmentById.get(row.adhoc_adjustment_id) : undefined;
    group.requests++; group.requested += n(row.amount_requested ?? row.amount); group.paid += paid;
    group.recovered += deduction?.status === "posted" ? n(deduction.amount) : 0;
    group.pending += deduction?.status === "approved" ? n(deduction.amount) : 0;
    groups.set(groupKey, group);
    return {
      "Request ID": row.request_no, "Work date": row.adhoc_work_date || row.work_date, "Station": station,
      "Client": row.adhoc_client || "", "DA name": group.name, "Provider ID": group.providerId, "Workforce ID": row.adhoc_workforce_id || "",
      "Requested at": row.created_at, "Payment status": row.status, "Requested amount": n(row.amount_requested ?? row.amount),
      "Approved amount": row.amount_approved == null ? "" : n(row.amount_approved), "Paid amount": paid,
      "Paid / processed at": row.processed_at || row.paid_at || "", "Bank reference": row.utr_cin || "",
      "Deduction ID": row.adhoc_adjustment_id || "", "Deduction posting date": deduction?.effective_date || "",
      "Deduction status": deduction?.status || (tracked ? "Not paid" : "Historical — not linked; no automatic deduction"), "Payroll run ID": deduction?.payroll_run_id || ""
    };
  });
  const summary = [...groups.values()].map(group => {
    const counts = shipmentCounts.get(key(group.station, group.client, group.providerId));
    return { "Station": group.station, "Client": group.client, "DA name": group.name, "Provider ID": group.providerId, "Workforce ID": group.workforceId,
      "Amazon delivered (selected range)": group.tracked ? counts?.amazon ?? 0 : "", "Total delivered (selected range)": group.tracked ? counts?.delivered ?? 0 : "",
      "Payment requests": group.requests, "Requested amount": round(group.requested), "Paid amount": round(group.paid),
      "Recovery in payroll snapshot": round(group.recovered), "Recovery awaiting payroll": round(group.pending),
      "Tracking": group.tracked ? "Linked" : "Historical — needs manual reconciliation" };
  });
  return { summary, details };
}
