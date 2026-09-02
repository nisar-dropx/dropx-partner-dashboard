import "server-only";

import { supabaseAdmin } from "../supabase-admin";
import { rebuildAttendanceDay } from "./attendance";
import { resolveStationAttendanceSettings } from "./station-attendance-settings";

function enrolmentVariants(value: unknown) {
  const raw = String(value ?? "").trim();
  const digits = raw.replace(/\D/g, "");
  const cleaned = digits.replace(/^0+/, "") || "0";
  const primary = cleaned || raw;
  return Array.from(new Set([
    raw,
    cleaned,
    primary.padStart(6, "0"),
    primary.padStart(8, "0")
  ].filter(Boolean)));
}

function asIsoTime(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/** Prefer device capture time; never invent approval/server "now". */
function effectivePunchTime(punch: { punch_time?: string | null; client_captured_at?: string | null }) {
  return asIsoTime(punch.client_captured_at) ?? asIsoTime(punch.punch_time);
}

/** After manager approve: count the held punch toward attendance calendar/daily. */
export async function activateHeldAttendancePunch(punchId: string) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  let punch = await supabaseAdmin
    .from("attendance_punches")
    .select("id, company_id, enrolment_id, punch_date, punch_time, client_captured_at, calculated")
    .eq("id", punchId)
    .maybeSingle();
  if (punch.error && /client_captured_at|does not exist|schema cache/i.test(punch.error.message)) {
    punch = await supabaseAdmin
      .from("attendance_punches")
      .select("id, company_id, enrolment_id, punch_date, punch_time, calculated")
      .eq("id", punchId)
      .maybeSingle();
  }
  if (punch.error) throw new Error(punch.error.message);
  if (!punch.data) return false;

  const originalPunchTime = effectivePunchTime(punch.data);
  if (!originalPunchTime) {
    throw new Error("Held punch is missing the original punch time.");
  }

  const update = await supabaseAdmin
    .from("attendance_punches")
    .update({ calculated: true, is_flagged: false, punch_time: originalPunchTime })
    .eq("id", punchId);
  if (update.error) throw new Error(update.error.message);

  await rebuildAttendanceDay(
    String(punch.data.company_id),
    String(punch.data.enrolment_id),
    String(punch.data.punch_date)
  );
  return true;
}

/** Held punches with integrity OFF (or no open flag) never appear in calendar or HRMS — release them. */
export async function releaseOrphanedHeldPunches({
  companyId,
  enrolmentIds,
  locationId
}: {
  companyId: string;
  enrolmentIds: string[];
  locationId: string | null;
}) {
  if (!supabaseAdmin) return;
  const variants = Array.from(new Set(enrolmentIds.flatMap((value) => enrolmentVariants(value))));
  if (!variants.length) return;

  const stationSettings = await resolveStationAttendanceSettings(locationId);
  const heldResult = await supabaseAdmin
    .from("attendance_punches")
    .select("id, punch_date, enrolment_id")
    .eq("company_id", companyId)
    .in("enrolment_id", variants)
    .eq("calculated", false)
    .eq("is_flagged", true);
  if (heldResult.error || !heldResult.data?.length) return;

  const punchIds = heldResult.data.map((row) => String(row.id));
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

  const datesToRebuild = new Set<string>();
  for (const punch of heldResult.data) {
    const punchId = String(punch.id);
    const dateKey = `${punch.enrolment_id}:${punch.punch_date}`;
    const hasOpenFlag = openFlagPunchIds.has(punchId) || openFlagDates.has(dateKey);
    if (stationSettings.integrityFlagsEnabled && hasOpenFlag) continue;
    await activateHeldAttendancePunch(punchId);
    datesToRebuild.add(`${punch.enrolment_id}:${punch.punch_date}`);
  }

  for (const key of datesToRebuild) {
    const [enrolmentId, punchDate] = key.split(":");
    await rebuildAttendanceDay(companyId, enrolmentId, punchDate);
  }
}

export async function resolveIntegrityFlag(flagId: string, resolvedBy: string | null) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const now = new Date().toISOString();
  const existing = await supabaseAdmin
    .from("attendance_integrity_flags")
    .select("id, punch_id")
    .eq("id", flagId)
    .maybeSingle();
  if (existing.error) throw new Error(existing.error.message);

  const result = await supabaseAdmin
    .from("attendance_integrity_flags")
    .update({ status: "resolved", resolved_at: now, resolved_by: resolvedBy, updated_at: now })
    .eq("id", flagId)
    .select("id")
    .single();
  if (result.error) throw new Error(result.error.message);

  const reviews = await supabaseAdmin
    .from("attendance_location_reviews")
    .update({ status: "approved", review_remarks: null, reviewed_at: now, updated_at: now })
    .eq("flag_id", flagId)
    .in("status", ["pending", "returned"])
    .select("punch_id");
  if (reviews.error && !/does not exist|schema cache/i.test(reviews.error.message)) {
    console.error("Unable to auto-approve linked support packages", reviews.error.message);
  }

  const punchIds = new Set<string>();
  if (existing.data?.punch_id) punchIds.add(String(existing.data.punch_id));
  for (const row of reviews.data ?? []) {
    if (row.punch_id) punchIds.add(String(row.punch_id));
  }
  for (const punchId of punchIds) {
    await activateHeldAttendancePunch(punchId);
  }
}
