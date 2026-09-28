export type ReportImportMappingIdentity = {
  workforce_id?: string | null;
  employee_id?: string | null;
  contractor_id?: string | null;
  field_executive_id?: string | null;
};

export type ReportImportWorkforceIdentity = {
  id: string;
  source_profile_type?: string | null;
  source_profile_id?: string | null;
};

export type ReportImportAttendanceRow = {
  id?: string | null;
  workforce_id?: string | null;
  employee_id?: string | null;
  contractor_id?: string | null;
  field_executive_id?: string | null;
  punch_date: string;
  status?: string | null;
  in_time?: string | null;
  out_time?: string | null;
  work_minutes?: number | string | null;
};

export type ReportImportWorkforceIndex = {
  byId: Map<string, ReportImportWorkforceIdentity>;
  bySource: Map<string, ReportImportWorkforceIdentity>;
};

const sourceTypes = ["employee", "contractor", "field_executive"] as const;

function sourceKey(type: string, id: string) {
  return `${type.trim().toLowerCase()}:${id}`;
}

function attendanceUnit(row?: ReportImportAttendanceRow | null) {
  if (!row) return 0;
  const status = String(row.status ?? "").trim().toUpperCase();
  if (["A", "ABSENT", "L", "LEAVE", "U", "UNPAID"].includes(status)) return 0;
  if (["HD", "HLF", "HALF_DAY", "HALF DAY"].includes(status)) return 0.5;
  if (["P", "PRESENT"].includes(status)) return 1;
  return row.in_time ? 1 : 0;
}

function preferredAttendance(
  current: ReportImportAttendanceRow | undefined,
  candidate: ReportImportAttendanceRow
) {
  if (!current) return candidate;
  const currentMinutes = Number(current.work_minutes ?? 0);
  const candidateMinutes = Number(candidate.work_minutes ?? 0);
  if (candidateMinutes !== currentMinutes) return candidateMinutes > currentMinutes ? candidate : current;
  const currentUnit = attendanceUnit(current);
  const candidateUnit = attendanceUnit(candidate);
  if (candidateUnit !== currentUnit) return candidateUnit > currentUnit ? candidate : current;
  return candidate.in_time && !current.in_time ? candidate : current;
}

export function createReportImportWorkforceIndex(rows: ReportImportWorkforceIdentity[]): ReportImportWorkforceIndex {
  const byId = new Map<string, ReportImportWorkforceIdentity>();
  const bySource = new Map<string, ReportImportWorkforceIdentity>();
  for (const row of rows) {
    if (!row.id) continue;
    byId.set(row.id, row);
    const type = String(row.source_profile_type ?? "").trim().toLowerCase();
    const id = String(row.source_profile_id ?? "").trim();
    if (type && id) bySource.set(sourceKey(type, id), row);
  }
  return { byId, bySource };
}

export function canonicalWorkforceForMapping(
  mapping: ReportImportMappingIdentity,
  index: ReportImportWorkforceIndex
) {
  if (mapping.workforce_id) {
    const direct = index.byId.get(mapping.workforce_id);
    if (direct) return direct;
  }
  for (const type of sourceTypes) {
    const id = mapping[`${type}_id` as keyof ReportImportMappingIdentity];
    if (!id) continue;
    const worker = index.bySource.get(sourceKey(type, id)) ?? index.byId.get(id);
    if (worker) return worker;
  }
  return undefined;
}

export function canonicalWorkforceForAttendance(
  row: ReportImportAttendanceRow,
  index: ReportImportWorkforceIndex
) {
  if (row.workforce_id) {
    const direct = index.byId.get(row.workforce_id);
    if (direct) return direct;
  }
  for (const type of sourceTypes) {
    const id = row[`${type}_id` as keyof ReportImportAttendanceRow];
    if (!id || typeof id !== "string") continue;
    const worker = index.bySource.get(sourceKey(type, id)) ?? index.byId.get(id);
    if (worker) return worker;
  }
  return undefined;
}

export function buildReportImportAttendanceByWorkforceDate(
  rows: ReportImportAttendanceRow[],
  index: ReportImportWorkforceIndex
) {
  const attendance = new Map<string, ReportImportAttendanceRow>();
  for (const row of rows) {
    const worker = canonicalWorkforceForAttendance(row, index);
    if (!worker || !row.punch_date) continue;
    const key = `${worker.id}|${row.punch_date}`;
    attendance.set(key, preferredAttendance(attendance.get(key), row));
  }
  return attendance;
}
