import "server-only";

import { cleanEnrolmentId } from "@/lib/connect-attendance-worker";
import { supabaseAdmin } from "@/lib/supabase-admin";

export type ConnectAttendanceResponseRow = {
  date: string;
  status: string;
  inTime: string;
  outTime: string;
  punches: string[];
  workHours: string;
  punchCount: number;
  remark: string;
  regularization?: Record<string, unknown> | null;
  pendingReview?: boolean;
  statusLabel?: string | null;
  statusKind?: "attendance" | "leave";
};

function enrolmentVariants(biometricId: string) {
  const cleaned = cleanEnrolmentId(biometricId);
  return Array.from(new Set([
    String(biometricId ?? "").trim(),
    cleaned,
    cleaned.padStart(6, "0"),
    cleaned.padStart(8, "0")
  ].filter(Boolean)));
}

async function resolveStationIntegrityEnabled(locationId: string | null | undefined) {
  if (!supabaseAdmin || !locationId) return false;
  const result = await supabaseAdmin
    .from("stations")
    .select("attendance_integrity_flags_enabled")
    .eq("id", locationId)
    .maybeSingle();
  if (result.error) return false;
  return result.data?.attendance_integrity_flags_enabled === true;
}

/** Release held punches when location flags are off — they otherwise vanish from calendar and HRMS. */
export async function releaseOrphanedHeldPunches({
  companyId,
  enrolmentId,
  locationId
}: {
  companyId: string;
  enrolmentId: string;
  locationId: string | null;
}) {
  if (!supabaseAdmin) return;
  const variants = enrolmentVariants(enrolmentId);
  if (!variants.length) return;

  const integrityEnabled = await resolveStationIntegrityEnabled(locationId);
  const heldResult = await supabaseAdmin
    .from("attendance_punches")
    .select("id, punch_date, enrolment_id, punch_time")
    .eq("company_id", companyId)
    .in("enrolment_id", variants)
    .eq("calculated", false)
    .eq("is_flagged", true);
  if (heldResult.error || !heldResult.data?.length) return;

  const openFlagsResult = await supabaseAdmin
    .from("attendance_integrity_flags")
    .select("id, punch_id, punch_date, enrolment_id, status")
    .eq("company_id", companyId)
    .in("enrolment_id", variants)
    .eq("status", "open");
  if (openFlagsResult.error && !/does not exist|schema cache/i.test(openFlagsResult.error.message)) {
    throw new Error(openFlagsResult.error.message);
  }

  const openFlagPunchIds = new Set(
    (openFlagsResult.data ?? [])
      .map((row) => String(row.punch_id ?? ""))
      .filter(Boolean)
  );
  const openFlagDates = new Set(
    (openFlagsResult.data ?? []).map((row) => `${row.enrolment_id}:${row.punch_date}`)
  );

  const datesToRebuild = new Map<string, { enrolmentId: string; punchDate: string }>();
  for (const punch of heldResult.data) {
    const punchId = String(punch.id);
    const dateKey = `${punch.enrolment_id}:${punch.punch_date}`;
    const hasOpenFlag = openFlagPunchIds.has(punchId) || openFlagDates.has(dateKey);
    if (integrityEnabled && hasOpenFlag) continue;

    const punchTime = punch.punch_time ? String(punch.punch_time) : null;
    await supabaseAdmin
      .from("attendance_punches")
      .update({
        calculated: true,
        is_flagged: false,
        ...(punchTime ? { punch_time: punchTime } : {})
      })
      .eq("id", punchId);
    datesToRebuild.set(dateKey, {
      enrolmentId: String(punch.enrolment_id),
      punchDate: String(punch.punch_date)
    });
  }

  for (const { enrolmentId: heldEnrolmentId, punchDate } of datesToRebuild.values()) {
    const punchesResult = await supabaseAdmin
      .from("attendance_punches")
      .select("punch_time")
      .eq("company_id", companyId)
      .eq("enrolment_id", heldEnrolmentId)
      .eq("punch_date", punchDate)
      .eq("calculated", true)
      .order("punch_time", { ascending: true });
    if (punchesResult.error) continue;
    const times = (punchesResult.data ?? []).map((row) => row.punch_time).filter(Boolean) as string[];
    const first = times[0] ?? null;
    const last = times.length > 1 ? times[times.length - 1] : null;
    await supabaseAdmin.from("attendance_daily").upsert({
      company_id: companyId,
      enrolment_id: heldEnrolmentId,
      punch_date: punchDate,
      in_time: first,
      out_time: last && last !== first ? last : null,
      punch_count: times.length,
      status: times.length ? "P" : "A",
      updated_at: new Date().toISOString()
    }, { onConflict: "company_id,enrolment_id,punch_date" });
  }
}

function formatPunchTime(value: string | null | undefined) {
  if (!value) return "--:--";
  const trimmed = String(value).trim();
  if (/^\d{2}:\d{2}/.test(trimmed)) return trimmed.slice(0, 5);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata"
  }).format(date);
}

export function monthRangeFromParam(month: string | null) {
  const today = new Date();
  const match = month?.match(/^(\d{4})-(\d{2})$/);
  const year = match ? Number(match[1]) : today.getUTCFullYear();
  const monthIndex = match ? Number(match[2]) - 1 : today.getUTCMonth();
  if (!Number.isInteger(year) || !Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) {
    throw new Error("Month must be in YYYY-MM format.");
  }
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 0));
  return {
    label: `${year}-${String(monthIndex + 1).padStart(2, "0")}`,
    fromDate: start.toISOString().slice(0, 10),
    toDate: end.toISOString().slice(0, 10)
  };
}

export async function mergeHeldPunchesIntoAttendanceRows({
  companyId,
  enrolmentId,
  locationId,
  fromDate,
  toDate,
  rows
}: {
  companyId: string;
  enrolmentId: string;
  locationId: string | null;
  fromDate: string;
  toDate: string;
  rows: ConnectAttendanceResponseRow[];
}) {
  if (!supabaseAdmin || !enrolmentId) return rows;
  const integrityEnabled = await resolveStationIntegrityEnabled(locationId);
  if (!integrityEnabled) return rows;
  const variants = enrolmentVariants(enrolmentId);
  if (!variants.length) return rows;

  const heldPunchResult = await supabaseAdmin
    .from("attendance_punches")
    .select("punch_date, punch_time")
    .eq("company_id", companyId)
    .in("enrolment_id", variants)
    .gte("punch_date", fromDate)
    .lte("punch_date", toDate)
    .eq("calculated", false)
    .eq("is_flagged", true)
    .order("punch_time", { ascending: true });
  if (heldPunchResult.error) return rows;

  const heldPunchesByDate = new Map<string, string[]>();
  for (const punch of heldPunchResult.data ?? []) {
    const date = String(punch.punch_date ?? "");
    const time = formatPunchTime(punch.punch_time);
    if (!date || time === "--:--") continue;
    const times = heldPunchesByDate.get(date) ?? [];
    times.push(time);
    heldPunchesByDate.set(date, times);
  }
  if (!heldPunchesByDate.size) return rows;

  const responseRows = rows.map((row) => ({ ...row, punches: [...(row.punches ?? [])] }));
  for (const [date, heldTimes] of heldPunchesByDate) {
    const existing = responseRows.find((row) => row.date === date);
    const combinedPunches = Array.from(new Set([...(existing?.punches ?? []), ...heldTimes])).sort();
    if (existing) {
      existing.punches = combinedPunches;
      existing.punchCount = combinedPunches.length;
      existing.inTime = combinedPunches[0] ?? existing.inTime;
      existing.outTime = combinedPunches.length > 1 ? combinedPunches[combinedPunches.length - 1] : existing.outTime;
      existing.pendingReview = true;
      existing.statusLabel = "Verification pending";
      existing.remark = "Biometric punch captured · attendance integrity review pending";
    } else {
      responseRows.push({
        date,
        status: "",
        inTime: combinedPunches[0] ?? "",
        outTime: combinedPunches.length > 1 ? combinedPunches[combinedPunches.length - 1] : "",
        punches: combinedPunches,
        workHours: "00:00",
        punchCount: combinedPunches.length,
        remark: "Biometric punch captured · attendance integrity review pending",
        regularization: null,
        pendingReview: true,
        statusLabel: "Verification pending"
      });
    }
  }
  responseRows.sort((left, right) => left.date.localeCompare(right.date));
  return responseRows;
}
