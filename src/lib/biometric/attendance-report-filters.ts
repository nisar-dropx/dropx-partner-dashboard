import type { AttendanceReportRow } from "@/lib/biometric/attendance";

export function filterAttendanceReportRows(
  rows: AttendanceReportRow[],
  filters: { designations?: string[]; search?: string; workerTypes?: string[] }
) {
  const search = String(filters.search ?? "").trim().toLowerCase();
  const designations = new Set(filters.designations ?? []);
  const workerTypes = new Set(filters.workerTypes ?? []);
  return rows.filter((row) => {
    if (designations.size && !designations.has(row.designation)) return false;
    if (workerTypes.size && !workerTypes.has(row.workerType)) return false;
    if (!search) return true;
    return [row.workerCode, row.workerName, row.enrolmentId, row.location, row.designation, row.workerType, row.shiftName]
      .some((value) => value.toLowerCase().includes(search));
  });
}

export function attendanceReportFilterOptions(rows: AttendanceReportRow[]) {
  return {
    designations: Array.from(new Set(rows.map((row) => row.designation).filter((value) => value && value !== "-"))).sort(),
    workerTypes: Array.from(new Set(rows.map((row) => row.workerType).filter(Boolean))).sort()
  };
}
