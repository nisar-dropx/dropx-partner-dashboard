import type { AttendanceReportRow } from "@/lib/biometric/attendance";

export function filterAttendanceReportRows(
  rows: AttendanceReportRow[],
  filters: { designation?: string; search?: string; workerType?: string }
) {
  const search = String(filters.search ?? "").trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.designation && row.designation !== filters.designation) return false;
    if (filters.workerType && row.workerType !== filters.workerType) return false;
    if (!search) return true;
    return [row.workerCode, row.workerName, row.enrolmentId, row.location, row.designation]
      .some((value) => value.toLowerCase().includes(search));
  });
}

export function attendanceReportFilterOptions(rows: AttendanceReportRow[]) {
  return {
    designations: Array.from(new Set(rows.map((row) => row.designation).filter((value) => value && value !== "-"))).sort(),
    workerTypes: Array.from(new Set(rows.map((row) => row.workerType).filter(Boolean))).sort()
  };
}
