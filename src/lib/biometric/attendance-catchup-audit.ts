import { readAllRows } from "@/lib/supabase-pagination";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  buildHistoricalBiometricOwnershipWindows,
  type HistoricalBiometricMapping,
  type HistoricalBiometricOwnershipWindow
} from "@/lib/biometric/attendance-reconciliation-policy";
import {
  biometricCandidateOwnerKey,
  normalizeBiometricEnrolmentId
} from "@/lib/biometric/enrolment-resolution";

export const ATTENDANCE_CATCHUP_AUDIT_FROM = "2026-09-01";
export const ATTENDANCE_CATCHUP_AUDIT_TO = "2026-10-11";
export const ATTENDANCE_CATCHUP_AUDIT_COMPANY_CODE = "DROPX_LOGISTICS";
export const ATTENDANCE_CATCHUP_AUDIT_DROPX_IDS = [
  "KGQC1201",
  "PEUA8096",
  "DROPX1143",
  "DF1088"
] as const;

type WorkforceAuditRow = {
  biometric_id: string | null;
  company_id: string;
  dropx_id: string | null;
  id: string;
  is_active: boolean | null;
  lifecycle_status: string | null;
  onboarding_status: string | null;
  source_profile_id: string | null;
  source_profile_type: string | null;
};

type RawAuditRow = {
  company_id: string;
  device_serial: string | null;
  enrolment_id: string | null;
  id: string;
  punch_time: string;
};

type PunchAuditRow = {
  account_id: string | null;
  calculated: boolean | null;
  company_id: string;
  device_serial: string | null;
  employee_id: string | null;
  enrolment_id: string | null;
  field_executive_id: string | null;
  id?: string;
  location_id: string | null;
  profile_type: string | null;
  punch_date: string;
  punch_time: string;
  raw_event_id: string | null;
  worker_type: string | null;
};

type DailyAuditRow = {
  company_id: string;
  enrolment_id: string | null;
  id?: string;
  punch_date: string;
};

export type AttendanceCatchupAuditInput = {
  companyId: string;
  dailyRows: DailyAuditRow[];
  mappings: HistoricalBiometricMapping[];
  punchRows: PunchAuditRow[];
  rawRows: RawAuditRow[];
  workforceRows: WorkforceAuditRow[];
};

function addIsoDateDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function istDate(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Kolkata",
    year: "numeric"
  }).formatToParts(parsed);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function normalizedDropxId(value: string | null | undefined) {
  return String(value ?? "").trim().toUpperCase();
}

function normalizedBiometricId(value: string | null | undefined) {
  return normalizeBiometricEnrolmentId(value);
}

function biometricKey(companyId: string, enrolmentId: string | null | undefined) {
  const normalized = normalizedBiometricId(enrolmentId);
  return normalized ? `${companyId}\u0000${normalized}` : "";
}

function normalizedTimestamp(value: string | null | undefined) {
  const parsed = new Date(String(value ?? ""));
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function capturedRawEvidenceKey({
  companyId,
  deviceSerial,
  enrolmentId,
  locationId,
  ownerKey,
  punchTime,
  rawEventId
}: {
  companyId: string;
  deviceSerial: string | null | undefined;
  enrolmentId: string | null | undefined;
  locationId: string | null | undefined;
  ownerKey: string;
  punchTime: string | null | undefined;
  rawEventId: string | null | undefined;
}) {
  const biometric = biometricKey(companyId, enrolmentId);
  const stamp = normalizedTimestamp(punchTime);
  if (!biometric || !stamp || !rawEventId || !ownerKey) return "";
  return [
    biometric,
    rawEventId,
    String(deviceSerial ?? ""),
    stamp,
    ownerKey,
    String(locationId ?? "")
  ].join("\u0000");
}

function mappingPersonIds(mapping: HistoricalBiometricMapping) {
  return new Set([
    mapping.account_id,
    mapping.employee_id,
    mapping.field_executive_id
  ].filter((value): value is string => Boolean(value)));
}

function profilePersonIds(profile: WorkforceAuditRow) {
  return new Set([profile.id, profile.source_profile_id].filter((value): value is string => Boolean(value)));
}

function mappingBelongsToProfile(mapping: HistoricalBiometricMapping, profile: WorkforceAuditRow) {
  if (mapping.company_id !== profile.company_id) return false;
  const profileIds = profilePersonIds(profile);
  return Array.from(mappingPersonIds(mapping)).some((personId) => profileIds.has(personId));
}

function profileStatus(profile: WorkforceAuditRow) {
  return profile.lifecycle_status
    || profile.onboarding_status
    || (profile.is_active ? "Active" : "Inactive");
}

function profileType(profile: WorkforceAuditRow) {
  return profile.source_profile_type || "workforce";
}

function validResolvedOwner(window: HistoricalBiometricOwnershipWindow) {
  if (window.kind !== "resolved" || !window.owner) return false;
  const owner = window.owner;
  return Boolean(
    owner.company_id
    && owner.location_id
    && owner.profile_type
    && owner.worker_type
    && mappingPersonIds(owner).size
  );
}

/**
 * Aggregate-only audit. It deliberately exposes no profile names, UUIDs,
 * locations, or raw timestamps. The four requested DropX IDs are the only
 * business identifiers in the result.
 */
export function buildAttendanceCatchupAudit(input: AttendanceCatchupAuditInput) {
  const companyId = String(input.companyId ?? "").trim();
  if (!companyId) throw new Error("Attendance catch-up audit company is required.");
  const mappings = input.mappings.filter((mapping) => mapping.company_id === companyId);
  const rawRows = input.rawRows.filter((raw) => raw.company_id === companyId);
  const punchRows = input.punchRows.filter((punch) => punch.company_id === companyId);
  const dailyRows = input.dailyRows.filter((daily) => daily.company_id === companyId);
  const workforceRows = input.workforceRows.filter((profile) => profile.company_id === companyId);
  const ownershipWindows = buildHistoricalBiometricOwnershipWindows({
    fromDate: ATTENDANCE_CATCHUP_AUDIT_FROM,
    mappings,
    toDate: ATTENDANCE_CATCHUP_AUDIT_TO
  });
  const windowsByBiometric = new Map<string, HistoricalBiometricOwnershipWindow[]>();
  for (const window of ownershipWindows) {
    const key = biometricKey(window.companyId, window.enrolmentId);
    const rows = windowsByBiometric.get(key) ?? [];
    rows.push(window);
    windowsByBiometric.set(key, rows);
  }

  const calculatedEvidence = new Set<string>();
  for (const punch of punchRows) {
    if (!punch.calculated) continue;
    const key = capturedRawEvidenceKey({
      companyId: punch.company_id,
      deviceSerial: punch.device_serial,
      enrolmentId: punch.enrolment_id,
      locationId: punch.location_id,
      ownerKey: biometricCandidateOwnerKey(punch),
      punchTime: punch.punch_time,
      rawEventId: punch.raw_event_id
    });
    if (key) calculatedEvidence.add(key);
  }

  const ownershipWindowForRaw = (raw: RawAuditRow) => {
    const date = istDate(raw.punch_time);
    const windows = windowsByBiometric.get(biometricKey(raw.company_id, raw.enrolment_id)) ?? [];
    return windows.find((candidate) => candidate.fromDate <= date && candidate.toDate >= date) ?? null;
  };

  const rawCaptured = (raw: RawAuditRow) => {
    const window = ownershipWindowForRaw(raw);
    if (!window || !validResolvedOwner(window) || !window.owner) return false;
    const key = capturedRawEvidenceKey({
      companyId: raw.company_id,
      deviceSerial: raw.device_serial,
      enrolmentId: raw.enrolment_id,
      locationId: window.owner.location_id,
      ownerKey: biometricCandidateOwnerKey(window.owner),
      punchTime: raw.punch_time,
      rawEventId: raw.id
    });
    return Boolean(key && calculatedEvidence.has(key));
  };

  const global = {
    ambiguousUnresolvedCount: 0,
    capturedRawCount: 0,
    incompleteMappingUnresolvedCount: 0,
    rawTimelogCount: rawRows.length,
    safeMappedUnresolvedCount: 0,
    unmappedUnresolvedCount: 0,
    unresolvedRawCount: 0
  };
  for (const raw of rawRows) {
    if (rawCaptured(raw)) {
      global.capturedRawCount += 1;
      continue;
    }
    global.unresolvedRawCount += 1;
    const window = ownershipWindowForRaw(raw);
    if (!window) global.unmappedUnresolvedCount += 1;
    else if (window.kind === "ambiguous") global.ambiguousUnresolvedCount += 1;
    else if (validResolvedOwner(window)) global.safeMappedUnresolvedCount += 1;
    else global.incompleteMappingUnresolvedCount += 1;
  }

  const requestedIds = new Set<string>(ATTENDANCE_CATCHUP_AUDIT_DROPX_IDS);
  const samples = ATTENDANCE_CATCHUP_AUDIT_DROPX_IDS.map((dropxId) => {
    const profiles = workforceRows.filter((profile) =>
      normalizedDropxId(profile.dropx_id) === dropxId && requestedIds.has(dropxId)
    );
    const biometricKeys = new Set<string>();
    const normalizedBiometricIds = new Set<string>();
    for (const profile of profiles) {
      const profileBiometricId = normalizedBiometricId(profile.biometric_id);
      if (profileBiometricId) {
        normalizedBiometricIds.add(profileBiometricId);
        biometricKeys.add(biometricKey(profile.company_id, profileBiometricId));
      }
      for (const mapping of mappings.filter((candidate) => mappingBelongsToProfile(candidate, profile))) {
        const mappingBiometricId = normalizedBiometricId(mapping.enrolment_id);
        if (!mappingBiometricId) continue;
        normalizedBiometricIds.add(mappingBiometricId);
        biometricKeys.add(biometricKey(mapping.company_id, mappingBiometricId));
      }
    }
    const sampleRawRows = rawRows.filter((raw) => biometricKeys.has(biometricKey(raw.company_id, raw.enrolment_id)));
    const samplePunchRows = punchRows.filter((punch) =>
      punch.calculated && biometricKeys.has(biometricKey(punch.company_id, punch.enrolment_id))
    );
    const dailyDays = new Set(dailyRows.filter((daily) =>
      biometricKeys.has(biometricKey(daily.company_id, daily.enrolment_id))
    ).map((daily) => `${daily.company_id}\u0000${daily.punch_date}`));
    return {
      calculatedAttendancePunchCount: samplePunchRows.length,
      distinctAttendanceDailyDays: dailyDays.size,
      dropxId,
      normalizedBiometricIds: Array.from(normalizedBiometricIds).sort(),
      profileFound: profiles.length > 0,
      profileStatuses: Array.from(new Set(profiles.map(profileStatus))).sort(),
      profileTypes: Array.from(new Set(profiles.map(profileType))).sort(),
      rawTimelogCount: sampleRawRows.length,
      uncapturedRawCount: sampleRawRows.filter((raw) => !rawCaptured(raw)).length
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    global,
    samples,
    window: {
      from: ATTENDANCE_CATCHUP_AUDIT_FROM,
      timeZone: "Asia/Kolkata",
      to: ATTENDANCE_CATCHUP_AUDIT_TO
    }
  };
}

export function scopeAttendanceCatchupAuditWorkforceRows(
  workforceRows: WorkforceAuditRow[],
  companyId: string
) {
  const requestedIds = new Set<string>(ATTENDANCE_CATCHUP_AUDIT_DROPX_IDS);
  return workforceRows.filter((row) =>
    row.company_id === companyId && requestedIds.has(normalizedDropxId(row.dropx_id))
  );
}

export async function loadAttendanceCatchupAudit() {
  const admin = supabaseAdmin;
  if (!admin) throw new Error("Supabase service role key is not configured.");

  const startAt = `${ATTENDANCE_CATCHUP_AUDIT_FROM}T00:00:00+05:30`;
  const endBefore = `${addIsoDateDays(ATTENDANCE_CATCHUP_AUDIT_TO, 1)}T00:00:00+05:30`;
  const company = await admin.from("companies")
    .select("id")
    .eq("code", ATTENDANCE_CATCHUP_AUDIT_COMPANY_CODE)
    .eq("is_active", true)
    .maybeSingle();
  if (company.error) throw new Error(`Unable to resolve the attendance catch-up audit company: ${company.error.message}`);
  const companyId = String(company.data?.id ?? "").trim();
  if (!companyId) throw new Error("Attendance catch-up audit company is not configured.");

  const workforceLookups = await Promise.all(ATTENDANCE_CATCHUP_AUDIT_DROPX_IDS.map((dropxId) =>
    readAllRows(admin.from("workforce")
      .select("id,company_id,dropx_id,biometric_id,is_active,lifecycle_status,onboarding_status,source_profile_type,source_profile_id")
      // The wildcard admits legacy surrounding whitespace; the resolver below
      // applies exact trim/case normalization inside this tenant.
      .eq("company_id", companyId)
      .ilike("dropx_id", `%${dropxId}%`)
      .order("id", { ascending: true }))
  ));
  for (const result of workforceLookups) {
    if (result.error) throw new Error(`Unable to audit workforce: ${result.error.message}`);
  }
  const workforceCandidates = Array.from(new Map(workforceLookups
    .flatMap((result) => (result.data ?? []) as WorkforceAuditRow[])
    .map((row) => [`${row.company_id}\u0000${row.id}`, row])).values());
  const workforceRows = scopeAttendanceCatchupAuditWorkforceRows(workforceCandidates, companyId);

  const [mappings, raw, punches, daily] = await Promise.all([
    readAllRows(admin.from("biometric_enrolments")
      .select("id,company_id,enrolment_id,worker_type,profile_type,account_id,employee_id,field_executive_id,location_id,status,effective_from,effective_to")
      .eq("company_id", companyId)
      .lte("effective_from", ATTENDANCE_CATCHUP_AUDIT_TO)
      .or(`effective_to.is.null,effective_to.gte.${ATTENDANCE_CATCHUP_AUDIT_FROM}`)
      .order("id", { ascending: true })),
    readAllRows(admin.from("biometric_raw_events")
      .select("id,company_id,device_serial,enrolment_id,punch_time")
      .eq("company_id", companyId)
      .ilike("event_type", "timelog")
      .not("punch_time", "is", null)
      .gte("punch_time", startAt)
      .lt("punch_time", endBefore)
      .order("punch_time", { ascending: true })
      .order("id", { ascending: true })),
    readAllRows(admin.from("attendance_punches")
      .select("id,company_id,raw_event_id,device_serial,enrolment_id,punch_time,punch_date,worker_type,profile_type,account_id,employee_id,field_executive_id,location_id,calculated")
      .eq("company_id", companyId)
      // Audit the same instant range as the raw TimeLogs. Night-shift punches
      // near the first boundary can correctly resolve to the preceding work
      // date, so filtering evidence by punch_date would report a false gap.
      .gte("punch_time", startAt)
      .lt("punch_time", endBefore)
      .order("punch_time", { ascending: true })
      .order("id", { ascending: true })),
    readAllRows(admin.from("attendance_daily")
      .select("id,company_id,enrolment_id,punch_date")
      .eq("company_id", companyId)
      // Daily rows are sample telemetry only. Include the possible prior
      // night-shift work date represented by the raw-event audit window.
      .gte("punch_date", addIsoDateDays(ATTENDANCE_CATCHUP_AUDIT_FROM, -1))
      .lte("punch_date", ATTENDANCE_CATCHUP_AUDIT_TO)
      .order("punch_date", { ascending: true })
      .order("enrolment_id", { ascending: true })
      .order("id", { ascending: true }))
  ]);

  for (const [label, result] of [
    ["biometric mappings", mappings],
    ["raw biometric events", raw],
    ["attendance punches", punches],
    ["attendance daily", daily]
  ] as const) {
    if (result.error) throw new Error(`Unable to audit ${label}: ${result.error.message}`);
  }

  return buildAttendanceCatchupAudit({
    companyId,
    dailyRows: (daily.data ?? []) as DailyAuditRow[],
    mappings: (mappings.data ?? []) as HistoricalBiometricMapping[],
    punchRows: (punches.data ?? []) as PunchAuditRow[],
    rawRows: (raw.data ?? []) as RawAuditRow[],
    workforceRows
  });
}
