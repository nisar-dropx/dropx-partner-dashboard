import { adhocPaidDayKey } from "./adhoc-da-identity.ts";
export type AdhocPayoutEffect = "full_day" | "base_only";
export type AdhocPaidDayTreatment = { requestNo: string; effect: AdhocPayoutEffect; workforceId?: string | null };
export type AdhocPaidDay = {
  location_id: string;
  adhoc_client?: string | null;
  adhoc_provider_employee_id?: string | null;
  adhoc_work_date?: string | null;
  status: string;
  adhoc_payout_policy?: string | null;
  request_no: string;
  delivery_identity_confirmed?: boolean | null;
  delivery_provider_employee_id?: string | null;
  delivery_work_date?: string | null;
  delivery_performer_workforce_id?: string | null;
  adhoc_payout_effect?: string | null;
};
export function paidAdhocDays(records: AdhocPaidDay[]) {
  const days = new Map<string, AdhocPaidDayTreatment>();
  for (const row of records) {
    if (!["processed", "paid"].includes(row.status.toLowerCase())) continue;
    const deliveryLinked = row.delivery_identity_confirmed === true;
    const providerId = deliveryLinked ? row.delivery_provider_employee_id : row.adhoc_provider_employee_id;
    const workDate = deliveryLinked ? row.delivery_work_date : row.adhoc_work_date;
    const effect = deliveryLinked ? row.adhoc_payout_effect : row.adhoc_payout_policy === "work_day" ? "full_day" : "none";
    if (!providerId || !workDate || !row.adhoc_client || !["full_day", "base_only"].includes(String(effect))) continue;
    days.set(
      adhocPaidDayKey(row.location_id, row.adhoc_client, providerId, workDate),
      { requestNo: row.request_no, effect: effect as AdhocPayoutEffect, workforceId: row.delivery_performer_workforce_id }
    );
  }
  return days;
}
export function paidAdhocDayBreakdown(date: string, treatment: AdhocPaidDayTreatment) {
  return { date, baseAmount: 0, workDayUnits: 0, attendanceSource: `Paid ad hoc · ${treatment.requestNo}`, lines: [{ code: "ADHOC_PAID_DAY", label: `Excluded · paid ad hoc ${treatment.requestNo}`, componentType: "amount" as const, count: 0, rate: 0, amount: 0 }], methodAmounts: [] };
}
export function baseOnlyAdhocLine(treatment: AdhocPaidDayTreatment) {
  return {
    code: "ADHOC_BASE_EXCLUDED",
    label: `Van rent/base excluded · ${treatment.requestNo}`,
    componentType: "amount" as const,
    schedule: "per_day" as const,
    count: 0,
    rate: 0,
    amount: 0,
    sortOrder: Number.MAX_SAFE_INTEGER
  };
}
