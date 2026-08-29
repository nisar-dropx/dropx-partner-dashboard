import "server-only";

import type { ConnectAccount } from "./connect-auth";
import { connectApproverIdentity } from "./connect-expense-data";
import { connectReporteeMatches, loadConnectReporteeAccess, type ConnectReporteeAccess, type ConnectReporteeScope } from "./connect-reportee-scope";
import { supabaseAdmin } from "./supabase-admin";

export type ConnectLocationSupportPackage = {
  id: string;
  punchDate: string;
  status: string;
  remarks: string | null;
  lat: number;
  lng: number;
  accuracyM: number | null;
  receivedAt: string | null;
  selfieUrl: string | null;
  workerName: string;
  workerCode: string | null;
  profileType: "employee" | "contractor";
};

function db() {
  if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
  return supabaseAdmin;
}

const SUPPORT_SELFIE_BUCKET = "employee-profile-documents";

async function signedSelfieUrl(path: string) {
  const trimmed = String(path ?? "").trim();
  if (!trimmed || trimmed.startsWith("[")) return null;
  const signed = await db().storage.from(SUPPORT_SELFIE_BUCKET).createSignedUrl(trimmed, 15 * 60);
  return signed.data?.signedUrl ?? null;
}

async function purgeSupportSelfieForReviewId(companyId: string, reviewId: string) {
  const result = await db().from("attendance_location_reviews")
    .select("selfie_path")
    .eq("company_id", companyId)
    .eq("id", reviewId)
    .maybeSingle();
  if (result.error || !result.data?.selfie_path) return;
  const path = String(result.data.selfie_path).trim();
  if (!path || path.startsWith("[")) return;
  await db().storage.from(SUPPORT_SELFIE_BUCKET).remove([path]).catch((error) => {
    console.error("Unable to remove support selfie from storage", error instanceof Error ? error.message : error);
  });
  await db().from("attendance_location_reviews")
    .update({ selfie_path: "[removed]", updated_at: new Date().toISOString() })
    .eq("company_id", companyId)
    .eq("id", reviewId);
}

async function activateHeldPunchMinimal(punchId: string) {
  let punch = await db().from("attendance_punches")
    .select("id, company_id, enrolment_id, punch_date, punch_time, client_captured_at")
    .eq("id", punchId)
    .maybeSingle();
  if (punch.error && /client_captured_at|does not exist|schema cache/i.test(punch.error.message)) {
    punch = await db().from("attendance_punches")
      .select("id, company_id, enrolment_id, punch_date, punch_time")
      .eq("id", punchId)
      .maybeSingle();
  }
  if (punch.error) throw new Error(punch.error.message);
  if (!punch.data?.enrolment_id || !punch.data.punch_date) return;

  const punchTime = (punch.data as { client_captured_at?: string | null }).client_captured_at ?? punch.data.punch_time;
  if (!punchTime) throw new Error("Held punch is missing the original punch time.");

  const punchUpdate = await db().from("attendance_punches")
    .update({ calculated: true, is_flagged: false, punch_time: punchTime })
    .eq("id", punchId);
  if (punchUpdate.error) throw new Error(punchUpdate.error.message);

  const punchesResult = await db().from("attendance_punches")
    .select("punch_time")
    .eq("company_id", punch.data.company_id)
    .eq("enrolment_id", punch.data.enrolment_id)
    .eq("punch_date", punch.data.punch_date)
    .eq("calculated", true)
    .order("punch_time", { ascending: true });
  if (punchesResult.error) throw new Error(punchesResult.error.message);

  const times = (punchesResult.data ?? []).map((row) => row.punch_time).filter(Boolean) as string[];
  const first = times[0] ?? null;
  const last = times.length > 1 ? times[times.length - 1] : null;
  const dailyUpdate = await db().from("attendance_daily").upsert({
    company_id: punch.data.company_id,
    enrolment_id: punch.data.enrolment_id,
    punch_date: punch.data.punch_date,
    in_time: first,
    out_time: last && last !== first ? last : null,
    punch_count: times.length,
    status: times.length ? "P" : "A",
    updated_at: new Date().toISOString()
  }, { onConflict: "company_id,enrolment_id,punch_date" });
  if (dailyUpdate.error && !/does not exist|schema cache/i.test(dailyUpdate.error.message)) {
    throw new Error(dailyUpdate.error.message);
  }
}

async function resolveIntegrityFlagMinimal(flagId: string, resolvedBy: string | null) {
  const now = new Date().toISOString();
  const existing = await db().from("attendance_integrity_flags")
    .select("id, punch_id")
    .eq("id", flagId)
    .maybeSingle();
  if (existing.error) throw new Error(existing.error.message);

  const flagUpdate = await db().from("attendance_integrity_flags")
    .update({ status: "resolved", resolved_at: now, resolved_by: resolvedBy, updated_at: now })
    .eq("id", flagId);
  if (flagUpdate.error) throw new Error(flagUpdate.error.message);

  const reviews = await db().from("attendance_location_reviews")
    .update({ status: "approved", reviewed_at: now, updated_at: now })
    .eq("flag_id", flagId)
    .in("status", ["pending", "returned"])
    .select("punch_id");
  if (reviews.error && !/does not exist|schema cache/i.test(reviews.error.message)) {
    throw new Error(reviews.error.message);
  }

  const punchIds = new Set<string>();
  if (existing.data?.punch_id) punchIds.add(String(existing.data.punch_id));
  for (const row of reviews.data ?? []) {
    if (row.punch_id) punchIds.add(String(row.punch_id));
  }
  for (const punchId of punchIds) {
    await activateHeldPunchMinimal(punchId);
  }
}

type LocationReviewRow = {
  id: string;
  profile_type: string;
  profile_id: string;
  punch_date: string;
  selfie_path: string | null;
  lat: number | string;
  lng: number | string;
  accuracy_m: number | string | null;
  remarks: string | null;
  status: string;
  server_received_at: string | null;
  created_at: string;
};

function chunks<T>(values: T[], size = 100) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function locationReviewsForReportees(companyId: string, reportees: ConnectReporteeAccess) {
  const reviews: LocationReviewRow[] = [];
  const profileGroups: Array<["employee" | "contractor", string[]]> = [
    ["employee", [...reportees.employeeIds]],
    ["contractor", [...reportees.contractorIds]]
  ];
  for (const [profileType, profileIds] of profileGroups) {
    for (const profileIdChunk of chunks(profileIds)) {
      const result = await db().from("attendance_location_reviews")
        .select("id, profile_type, profile_id, punch_date, selfie_path, lat, lng, accuracy_m, remarks, status, server_received_at, created_at")
        .eq("company_id", companyId)
        .eq("status", "pending")
        .eq("profile_type", profileType)
        .in("profile_id", profileIdChunk)
        .order("created_at", { ascending: false })
        .limit(100);
      if (result.error) {
        if (/does not exist|schema cache/i.test(result.error.message)) return [];
        throw new Error(result.error.message);
      }
      reviews.push(...((result.data ?? []) as LocationReviewRow[]));
    }
  }
  return reviews
    .filter((row) => connectReporteeMatches(reportees, row.profile_type, row.profile_id))
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
    .slice(0, 100);
}

export async function listConnectLocationSupportPackages(
  account: ConnectAccount,
  reportees: ConnectReporteeAccess
): Promise<ConnectLocationSupportPackage[]> {
  if (!reportees.employeeIds.size && !reportees.contractorIds.size) return [];
  const reviews = await locationReviewsForReportees(account.companyId, reportees);
  if (!reviews.length) return [];

  const employeeIds = reviews.filter((row) => row.profile_type === "employee").map((row) => row.profile_id);
  const contractorIds = reviews.filter((row) => row.profile_type === "contractor").map((row) => row.profile_id);
  const [employeesResult, contractorsResult] = await Promise.all([
    employeeIds.length
      ? db().from("employees").select("id,full_name,employee_code").eq("company_id", account.companyId).in("id", employeeIds)
      : Promise.resolve({ data: [], error: null }),
    contractorIds.length
      ? db().from("contractors").select("id,full_name,dropx_id").eq("company_id", account.companyId).in("id", contractorIds)
      : Promise.resolve({ data: [], error: null })
  ]);
  if (employeesResult.error || contractorsResult.error) {
    throw new Error(employeesResult.error?.message ?? contractorsResult.error?.message ?? "Unable to load support package workers.");
  }

  const employees = new Map((employeesResult.data ?? []).map((row) => [row.id, row]));
  const contractors = new Map((contractorsResult.data ?? []).map((row) => [row.id, row]));

  return Promise.all(reviews.map(async (row) => {
    const employee = row.profile_type === "employee" ? employees.get(row.profile_id) : null;
    const contractor = row.profile_type === "contractor" ? contractors.get(row.profile_id) : null;
    return {
      id: row.id,
      punchDate: row.punch_date,
      status: row.status,
      remarks: row.remarks,
      lat: Number(row.lat),
      lng: Number(row.lng),
      accuracyM: row.accuracy_m == null ? null : Number(row.accuracy_m),
      receivedAt: row.server_received_at,
      selfieUrl: row.selfie_path ? await signedSelfieUrl(row.selfie_path) : null,
      workerName: employee?.full_name ?? contractor?.full_name ?? "Team member",
      workerCode: employee?.employee_code ?? contractor?.dropx_id ?? null,
      profileType: row.profile_type === "contractor" ? "contractor" as const : "employee" as const
    };
  }));
}

export async function reviewConnectLocationSupportPackage(
  account: ConnectAccount,
  reviewId: string,
  decision: string,
  note: string,
  reporteeScope: ConnectReporteeScope = "immediate"
) {
  const action =
    decision === "approved" || decision === "approve"
      ? "approve"
      : decision === "returned" || decision === "return"
        ? "return"
        : decision === "rejected" || decision === "reject"
          ? "reject"
          : "";
  if (!/^[0-9a-f-]{36}$/i.test(reviewId)) throw new Error("Support package is invalid.");
  if (!["approve", "return", "reject"].includes(action)) throw new Error("Choose Approve, Return, or Reject.");

  const identity = await connectApproverIdentity(account);
  if (!identity.userId) throw new Error("A linked People login is required to review support packages.");

  const existing = await db().from("attendance_location_reviews")
    .select("id, status, flag_id, profile_type, profile_id")
    .eq("id", reviewId)
    .eq("company_id", account.companyId)
    .maybeSingle();
  if (existing.error || !existing.data) throw new Error(existing.error?.message ?? "Support package not found.");
  if (!["pending", "returned"].includes(String(existing.data.status))) throw new Error("This support package has already been decided.");

  const reportees = await loadConnectReporteeAccess(account, reporteeScope);
  if (!connectReporteeMatches(reportees, existing.data.profile_type, existing.data.profile_id)) {
    throw new Error(reporteeScope === "team"
      ? "You can only review support packages within your active reporting tree."
      : "You can only review support packages for your immediate reportees.");
  }

  const now = new Date().toISOString();
  const status = action === "approve" ? "approved" : action === "return" ? "returned" : "rejected";
  const update = await db().from("attendance_location_reviews")
    .update({
      status,
      review_remarks: note || (action === "reject" ? "Rejected" : action === "return" ? "Returned for another support package" : null),
      reviewed_by: identity.userId,
      reviewed_at: now,
      updated_at: now
    })
    .eq("id", reviewId)
    .eq("company_id", account.companyId);
  if (update.error) throw new Error(update.error.message);

  if (action === "approve" && existing.data.flag_id) {
    await resolveIntegrityFlagMinimal(String(existing.data.flag_id), identity.userId);
    void purgeSupportSelfieForReviewId(account.companyId, reviewId).catch((error) => {
      console.error("approve package selfie purge failed", error instanceof Error ? error.message : error);
    });
  }

  if (action === "return") {
    await purgeSupportSelfieForReviewId(account.companyId, reviewId);
  }

  if (action === "reject") {
    if (existing.data.flag_id) {
      await db().from("attendance_integrity_flags")
        .update({ status: "dismissed", resolved_at: now, resolved_by: identity.userId, updated_at: now })
        .eq("company_id", account.companyId)
        .eq("id", existing.data.flag_id)
        .eq("status", "open");
    }
    await purgeSupportSelfieForReviewId(account.companyId, reviewId);
  }

  return action === "approve"
    ? "Support package approved."
    : action === "return"
      ? "Support package returned."
      : "Support package rejected.";
}
