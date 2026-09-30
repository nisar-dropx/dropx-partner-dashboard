export type ReportImportMappingIdentity = {
  workforce_id?: string | null;
  employee_id?: string | null;
  contractor_id?: string | null;
  field_executive_id?: string | null;
};

export type ReportImportProviderMappingIdentity = ReportImportMappingIdentity & {
  id?: string | null;
  provider_id?: string | null;
  provider_member_id?: string | null;
  station_id?: string | null;
  effective_from?: string | null;
  effective_to?: string | null;
};

export type ReportImportShipmentIdentity = {
  provider_employee_id?: string | null;
  station_code?: string | null;
  client?: string | null;
  work_date: string;
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

function normalizedIdentity(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

function normalizedScope(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function reportImportMappingMatchesShipment(
  mapping: ReportImportProviderMappingIdentity,
  shipment: ReportImportShipmentIdentity,
  scope: {
    providerLabelsById: Map<string, string[]>;
    stationCodeById: Map<string, string>;
  }
) {
  if (
    !mapping.effective_from
    || mapping.effective_from > shipment.work_date
    || (mapping.effective_to && mapping.effective_to < shipment.work_date)
    || normalizedIdentity(mapping.provider_member_id) !== normalizedIdentity(shipment.provider_employee_id)
  ) {
    return false;
  }

  if (mapping.station_id) {
    const stationCode = scope.stationCodeById.get(mapping.station_id);
    if (!stationCode || normalizedScope(stationCode) !== normalizedScope(shipment.station_code)) return false;
  }

  if (mapping.provider_id) {
    const client = normalizedScope(shipment.client);
    const providerLabels = scope.providerLabelsById.get(mapping.provider_id) ?? [];
    if (!client || !providerLabels.some((label) => {
      const provider = normalizedScope(label);
      return provider === client || provider.includes(client) || client.includes(provider);
    })) return false;
  }

  return true;
}

export function reportImportMappingIdentityGroups(mappings: ReportImportMappingIdentity[]) {
  return ([
    { column: "workforce_id", ids: [...new Set(mappings.map((mapping) => mapping.workforce_id).filter((id): id is string => Boolean(id)))] },
    { column: "employee_id", ids: [...new Set(mappings.map((mapping) => mapping.employee_id).filter((id): id is string => Boolean(id)))] },
    { column: "contractor_id", ids: [...new Set(mappings.map((mapping) => mapping.contractor_id).filter((id): id is string => Boolean(id)))] },
    { column: "field_executive_id", ids: [...new Set(mappings.map((mapping) => mapping.field_executive_id).filter((id): id is string => Boolean(id)))] }
  ] as const).filter((group) => group.ids.length);
}

export function reportImportMappingIdentitySeedsForWorkforce(rows: ReportImportWorkforceIdentity[]) {
  return rows.flatMap((row) => {
    const canonicalSeed: ReportImportMappingIdentity = {
      workforce_id: row.id,
      employee_id: row.id,
      contractor_id: row.id,
      field_executive_id: row.id
    };
    const sourceId = String(row.source_profile_id ?? "").trim();
    const sourceType = String(row.source_profile_type ?? "").trim().toLowerCase();
    if (!sourceId || !sourceTypes.includes(sourceType as (typeof sourceTypes)[number])) return [canonicalSeed];
    return [canonicalSeed, { [`${sourceType}_id`]: sourceId } as ReportImportMappingIdentity];
  });
}

export function resolveReportImportShipmentMapping<T extends ReportImportProviderMappingIdentity>(
  mappings: T[],
  shipment: ReportImportShipmentIdentity,
  scope: {
    providerLabelsById: Map<string, string[]>;
    stationCodeById: Map<string, string>;
  },
  workforceIndex: ReportImportWorkforceIndex
) {
  const candidates = mappings.filter((mapping) => reportImportMappingMatchesShipment(mapping, shipment, scope));
  if (!candidates.length) return { mapping: null, status: "Unmapped" as const };
  const workers = candidates.map((mapping) => canonicalWorkforceForMapping(mapping, workforceIndex));
  if (workers.some((worker) => !worker) || new Set(workers.map((worker) => worker?.id)).size !== 1) {
    return { mapping: null, status: "Conflicting or missing DropX identity" as const };
  }
  const mapping = [...candidates].sort((left, right) => (
    String(right.effective_from ?? "").localeCompare(String(left.effective_from ?? ""))
    || String(right.id ?? "").localeCompare(String(left.id ?? ""))
  ))[0];
  return { mapping, status: null };
}

export function reportImportMappingStatus(configured: boolean, attendanceConfigurationMissing: boolean) {
  return attendanceConfigurationMissing
    ? "Attendance calculation unavailable"
    : configured
      ? "Mapped"
      : "Payment setup missing";
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

export function selectReportImportMapping<T extends ReportImportProviderMappingIdentity>(
  mappings: T[],
  shipment: ReportImportShipmentIdentity,
  scope: {
    providerLabelsById: Map<string, string[]>;
    stationCodeById: Map<string, string>;
  },
  workforceIndex?: ReportImportWorkforceIndex
): { mapping: T | null; status: "matched" | "unmapped" | "identity_conflict" } {
  const candidates = mappings
    .filter((mapping) => reportImportMappingMatchesShipment(mapping, shipment, scope))
    .sort((left, right) => String(right.effective_from ?? "").localeCompare(String(left.effective_from ?? ""))
      || String(right.id ?? "").localeCompare(String(left.id ?? "")));
  if (!candidates.length) return { mapping: null, status: "unmapped" };

  if (workforceIndex) {
    const workers = candidates.map((mapping) => canonicalWorkforceForMapping(mapping, workforceIndex));
    const workforceIds = new Set(workers.map((worker) => worker?.id).filter(Boolean));
    if (workers.some((worker) => !worker) || workforceIds.size !== 1) {
      return { mapping: null, status: "identity_conflict" };
    }
  }

  return { mapping: candidates[0], status: "matched" };
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
