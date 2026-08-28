import "server-only";

import type { ConnectAccount } from "./connect-auth";
import { expenseIdentity } from "./connect-expense-data";
import { supabaseAdmin } from "./supabase-admin";
import { resolveIntegrityFlag } from "../../../../src/lib/biometric/attendance-gps";
import { purgeSupportSelfieForReviewId } from "../../../../src/lib/purge-support-selfies";

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

function indiaToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

async function signedSelfieUrl(path: string) {
  if (!path) return null;
  const signed = await db().storage.from("attendance-support-selfies").createSignedUrl(path, 15 * 60);
  return signed.data?.signedUrl ?? null;
}

async function managerTeamProfileIds(companyId: string, managerAssignmentId: string, today: string) {
  const relationships = await db().from("hr_reporting_relationships")
    .select("subject_assignment_id")
    .eq("company_id", companyId)
    .eq("manager_assignment_id", managerAssignmentId)
    .eq("relationship_type", "solid_line")
    .eq("is_primary", true)
    .lte("effective_from", today)
    .or(`effective_to.is.null,effective_to.gte.${today}`);
  if (relationships.error) throw new Error(relationships.error.message);
  const assignmentIds = [...new Set((relationships.data ?? []).map((row) => row.subject_assignment_id).filter(Boolean))];
  if (!assignmentIds.length) return [];

  const assignments = await db().from("hr_work_assignments")
    .select("engagement_id")
    .eq("company_id", companyId)
    .in("id", assignmentIds);
  if (assignments.error) throw new Error(assignments.error.message);
  const engagementIds = [...new Set((assignments.data ?? []).map((row) => row.engagement_id).filter(Boolean))];
  if (!engagementIds.length) return [];

  const engagements = await db().from("hr_engagements")
    .select("worker_type,employee_id,contractor_id,status")
    .eq("company_id", companyId)
    .in("id", engagementIds)
    .eq("status", "active");
  if (engagements.error) throw new Error(engagements.error.message);
  return (engagements.data ?? []).flatMap((row) => {
    if (row.worker_type === "employee" && row.employee_id) return [row.employee_id];
    if (row.worker_type === "contractor" && row.contractor_id) return [row.contractor_id];
    return [];
  });
}

export async function listConnectLocationSupportPackages(account: ConnectAccount): Promise<ConnectLocationSupportPackage[]> {
  let identity;
  try {
    identity = await expenseIdentity(account);
  } catch {
    return [];
  }
  if (!identity.userId) return [];

  const teamIds = await managerTeamProfileIds(account.companyId, identity.assignment.id, identity.today);
  if (!teamIds.length) return [];

  const reviewsResult = await db().from("attendance_location_reviews")
    .select("id, profile_type, profile_id, punch_date, selfie_path, lat, lng, accuracy_m, remarks, status, server_received_at")
    .eq("company_id", account.companyId)
    .in("status", ["pending", "returned"])
    .in("profile_id", teamIds)
    .order("created_at", { ascending: false })
    .limit(100);
  if (reviewsResult.error) {
    if (/does not exist|schema cache/i.test(reviewsResult.error.message)) return [];
    throw new Error(reviewsResult.error.message);
  }

  const reviews = reviewsResult.data ?? [];
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

export async function reviewConnectLocationSupportPackage(account: ConnectAccount, reviewId: string, decision: string, note: string) {
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

  const identity = await expenseIdentity(account);
  if (!identity.userId) throw new Error("A linked People login is required to review support packages.");

  const existing = await db().from("attendance_location_reviews")
    .select("id, status, flag_id, profile_id")
    .eq("id", reviewId)
    .eq("company_id", account.companyId)
    .maybeSingle();
  if (existing.error || !existing.data) throw new Error(existing.error?.message ?? "Support package not found.");
  if (!["pending", "returned"].includes(String(existing.data.status))) throw new Error("This support package has already been decided.");

  const teamIds = new Set(await managerTeamProfileIds(account.companyId, identity.assignment.id, indiaToday()));
  if (!teamIds.has(String(existing.data.profile_id))) {
    throw new Error("You can only review support packages for your direct reports.");
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
    await resolveIntegrityFlag(String(existing.data.flag_id), identity.userId);
    void purgeSupportSelfieForReviewId(account.companyId, reviewId).catch((error) => {
      console.error("approve package selfie purge failed", error instanceof Error ? error.message : error);
    });
  }

  if (action === "reject" && existing.data.flag_id) {
    await db().from("attendance_integrity_flags")
      .update({ status: "dismissed", resolved_at: now, resolved_by: identity.userId, updated_at: now })
      .eq("company_id", account.companyId)
      .eq("id", existing.data.flag_id)
      .eq("status", "open");
  }

  return action === "approve"
    ? "Support package approved."
    : action === "return"
      ? "Support package returned."
      : "Support package rejected.";
}
