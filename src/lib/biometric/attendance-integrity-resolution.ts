import "server-only";

import { supabaseAdmin } from "../supabase-admin";
import { rebuildAttendanceDay, resolveAttendanceWorkDate } from "./attendance";

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
    .select("id, company_id, enrolment_id, punch_date, punch_time, client_captured_at, calculated, account_id, employee_id, field_executive_id, profile_type")
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

  const originalPunchDate = String(punch.data.punch_date);
  const resolvedPunchDate = await resolveAttendanceWorkDate({
    accountId: punch.data.account_id ?? null,
    companyId: String(punch.data.company_id),
    employeeId: punch.data.employee_id ?? null,
    enrolmentId: String(punch.data.enrolment_id),
    fieldExecutiveId: punch.data.field_executive_id ?? null,
    profileType: punch.data.profile_type ?? null,
    punchTime: new Date(originalPunchTime)
  });

  const update = await supabaseAdmin
    .from("attendance_punches")
    .update({
      calculated: true,
      is_flagged: false,
      punch_date: resolvedPunchDate,
      punch_time: originalPunchTime
    })
    .eq("id", punchId);
  if (update.error) throw new Error(update.error.message);

  const companyId = String(punch.data.company_id);
  const enrolmentId = String(punch.data.enrolment_id);
  await rebuildAttendanceDay(companyId, enrolmentId, resolvedPunchDate);
  if (originalPunchDate !== resolvedPunchDate) {
    await rebuildAttendanceDay(companyId, enrolmentId, originalPunchDate);
  }
  return true;
}

export async function resolveIntegrityFlag(flagId: string, resolvedBy: string | null) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const now = new Date().toISOString();
  const existing = await supabaseAdmin
    .from("attendance_integrity_flags")
    .select("id, punch_id, company_id, enrolment_id, punch_date, details")
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
  const details = existing.data?.details && typeof existing.data.details === "object" && !Array.isArray(existing.data.details)
    ? existing.data.details as Record<string, unknown>
    : {};
  if (Array.isArray(details.punchIds)) {
    details.punchIds.forEach((punchId) => punchIds.add(String(punchId)));
  }
  for (const row of reviews.data ?? []) {
    if (row.punch_id) punchIds.add(String(row.punch_id));
  }

  // Integrity flags are date-level by design. Older records kept only the
  // latest punch_id, which left earlier held punches permanently excluded.
  // Once every flag for that worker/date is cleared, release every remaining
  // held punch for the same attendance day.
  if (existing.data?.company_id && existing.data.enrolment_id && existing.data.punch_date) {
    const remainingFlags = await supabaseAdmin
      .from("attendance_integrity_flags")
      .select("id", { count: "exact", head: true })
      .eq("company_id", existing.data.company_id)
      .eq("enrolment_id", existing.data.enrolment_id)
      .eq("punch_date", existing.data.punch_date)
      .eq("status", "open");
    if (remainingFlags.error) throw new Error(remainingFlags.error.message);
    if ((remainingFlags.count ?? 0) === 0) {
      const heldPunches = await supabaseAdmin
        .from("attendance_punches")
        .select("id")
        .eq("company_id", existing.data.company_id)
        .eq("enrolment_id", existing.data.enrolment_id)
        .eq("punch_date", existing.data.punch_date)
        .eq("calculated", false)
        .eq("is_flagged", true);
      if (heldPunches.error) throw new Error(heldPunches.error.message);
      heldPunches.data?.forEach((punch) => punchIds.add(String(punch.id)));
    }
  }
  for (const punchId of punchIds) {
    await activateHeldAttendancePunch(punchId);
  }
}
