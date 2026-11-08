export type AdhocDriverDetails = {
  reason_key: string; reason_label: string; work_date: string;
  workforce_id?: string; person_name?: string; dropx_id?: string;
  vehicle_id?: string; vehicle_no?: string;
};
export type AdhocDriverReason = { reason_key: string; label: string; designation_codes: string[] };
export type AdhocDriverPerson = { id: string; full_name: string; dropx_id: string; designation_code: string };
export function adhocDriverDetails(value: unknown): AdhocDriverDetails | null {
  const d = (value && typeof value === 'object' ? (value as Record<string, unknown>).adhoc_driver : null) as AdhocDriverDetails | null;
  return d && typeof d.reason_key === 'string' && typeof d.work_date === 'string' ? d : null;
}
export function driverAbsentDayBreakdown(date: string, requestNo: string) {
  return { date, baseAmount: 0, workDayUnits: 0, attendanceSource: `Absent · replacement ${requestNo}`,
    lines: [{ code: 'ADHOC_DRIVER_ABSENT', label: `Absent · replacement ${requestNo}`, componentType: 'amount' as const, count: 0, rate: 0, amount: 0 }], methodAmounts: [] };
}
export function peopleForAdhocDriverReason(people: AdhocDriverPerson[] | null | undefined, reason: AdhocDriverReason | null | undefined) {
  if (!reason?.designation_codes?.length || !Array.isArray(people)) return [];
  const codes = new Set(reason.designation_codes);
  return people.filter(person => codes.has(person.designation_code));
}
export function alternateAdhocDriverLeaveReason(
  reasons: AdhocDriverReason[] | null | undefined,
  people: AdhocDriverPerson[] | null | undefined,
  reasonKey: string
) {
  if (!reasonKey || reasonKey === 'vehicle_service' || !Array.isArray(reasons)) return null;
  return reasons.find(reason =>
    reason.reason_key !== reasonKey
    && reason.reason_key !== 'vehicle_service'
    && peopleForAdhocDriverReason(people, reason).length > 0
  ) ?? null;
}
export function adhocDriverLeaveRoleLabel(reasonKey: string) {
  if (reasonKey === 'driver_leave') return 'Drivers (DR)';
  if (reasonKey === 'dcd_leave') return 'DCD / ODCD';
  return 'eligible people';
}
export function adhocDriverPersonFieldLabel(reasonKey: string) {
  if (reasonKey === 'driver_leave') return 'Driver (DR) on leave';
  if (reasonKey === 'dcd_leave') return 'DCD / ODCD on leave';
  return 'Person on leave';
}
export function adhocDriverEmptyLeaveMessage(reasonKey: string, day: string, alternate: AdhocDriverReason | null, alternateCount: number) {
  const role = adhocDriverLeaveRoleLabel(reasonKey);
  if (alternate && alternateCount > 0) {
    return `No ${role} are mapped to this station for ${day}. ${alternateCount} eligible ${alternateCount === 1 ? 'person is' : 'people are'} listed under ${alternate.label} — switch sub-reason to select them.`;
  }
  return `No ${role} are mapped to this station for ${day}. Check workforce home station or provider mapping, then retry.`;
}
