export type AdhocDriverDetails = {
  reason_key: string; reason_label: string; work_date: string;
  workforce_id?: string; person_name?: string; dropx_id?: string;
  vehicle_id?: string; vehicle_no?: string;
};
export function adhocDriverDetails(value: unknown): AdhocDriverDetails | null {
  const d = (value && typeof value === 'object' ? (value as Record<string, unknown>).adhoc_driver : null) as AdhocDriverDetails | null;
  return d && typeof d.reason_key === 'string' && typeof d.work_date === 'string' ? d : null;
}
export function driverAbsentDayBreakdown(date: string, requestNo: string) {
  return { date, baseAmount: 0, workDayUnits: 0, attendanceSource: `Absent · replacement ${requestNo}`,
    lines: [{ code: 'ADHOC_DRIVER_ABSENT', label: `Absent · replacement ${requestNo}`, componentType: 'amount' as const, count: 0, rate: 0, amount: 0 }], methodAmounts: [] };
}
