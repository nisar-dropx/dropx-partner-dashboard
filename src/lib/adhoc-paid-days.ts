import { adhocPaidDayKey } from "./adhoc-da-identity.ts";
export type AdhocPaidDay = { location_id: string; adhoc_client: string; adhoc_provider_employee_id: string; adhoc_work_date: string; status: string; adhoc_payout_policy: string; request_no: string };
export function paidAdhocDays(records: AdhocPaidDay[]) {
  const days = new Map<string, string>();
  for (const row of records) {
    if (row.adhoc_payout_policy !== "work_day" || !["processed", "paid"].includes(row.status.toLowerCase()) || !row.adhoc_provider_employee_id || !row.adhoc_work_date) continue;
    days.set(adhocPaidDayKey(row.location_id, row.adhoc_client, row.adhoc_provider_employee_id, row.adhoc_work_date), row.request_no);
  }
  return days;
}
export function paidAdhocDayBreakdown(date: string, requestNo: string) {
  return { date, baseAmount: 0, workDayUnits: 0, attendanceSource: `Paid ad hoc · ${requestNo}`, lines: [{ code: "ADHOC_PAID_DAY", label: `Excluded · paid ad hoc ${requestNo}`, componentType: "amount" as const, count: 0, rate: 0, amount: 0 }], methodAmounts: [] };
}
