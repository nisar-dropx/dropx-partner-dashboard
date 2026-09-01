import "server-only";

import { supabaseAdmin } from "@/lib/supabase-admin";

export type AttendanceApprovalStep = {
  step_name: string;
  approver_user_id: string;
  approver_person_id: string;
};

const TEAM_LEAD_DESIGNATION_CODES = new Set(["TL", "ATL", "TEAM_LEAD", "ASST_TEAM_LEAD"]);

export function isTeamLeadManagerAssignment(
  designationCode: string | null | undefined,
  positionTitle: string | null | undefined
): boolean {
  const code = String(designationCode ?? "").trim().toUpperCase();
  if (code && TEAM_LEAD_DESIGNATION_CODES.has(code)) return true;
  const title = String(positionTitle ?? "").trim().toUpperCase();
  if (!title) return false;
  return /\b(TL|ATL|TEAM LEAD|ASST\.?\s*TEAM LEAD|ASSISTANT TEAM LEAD)\b/.test(title);
}

type PermissionUser = {
  userId: string;
  scopeType: string;
  scopeId: string | null;
};

function db() {
  if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
  return supabaseAdmin;
}

function indiaToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

async function usersWithApprovalPermission(companyId: string): Promise<PermissionUser[]> {
  const pageResult = await db().from("hr_permission_pages")
    .select("id").eq("company_id", companyId).eq("code", "approvals").eq("is_active", true).maybeSingle();
  if (pageResult.error) throw new Error(pageResult.error.message);
  if (!pageResult.data) return [];

  const permissionResult = await db().from("hr_role_page_permissions")
    .select("role_id").eq("company_id", companyId).eq("page_id", pageResult.data.id).eq("can_approve", true);
  if (permissionResult.error) throw new Error(permissionResult.error.message);
  const roleIds = [...new Set((permissionResult.data ?? []).map((row) => row.role_id))];
  if (!roleIds.length) return [];

  const today = indiaToday();
  const [grantResult, legacyResult] = await Promise.all([
    db().from("hr_access_grants").select("user_id,role_id,scope_type,scope_id")
      .eq("company_id", companyId).eq("is_active", true).in("role_id", roleIds)
      .lte("effective_from", today).or(`effective_to.is.null,effective_to.gte.${today}`),
    db().from("hr_user_access").select("user_id,role_id,all_locations,location_ids")
      .eq("company_id", companyId).eq("is_active", true).in("role_id", roleIds)
  ]);
  const missingGrantTable = /does not exist|schema cache/i.test(grantResult.error?.message ?? "");
  if (grantResult.error && !missingGrantTable) throw new Error(grantResult.error.message);
  if (legacyResult.error && missingGrantTable) throw new Error(legacyResult.error.message);
  const rows = missingGrantTable
    ? (legacyResult.data ?? []).flatMap((access) => access.all_locations
      ? [{ user_id: access.user_id, scope_type: "company", scope_id: null }]
      : (access.location_ids ?? []).map((locationId: string) => ({ user_id: access.user_id, scope_type: "location", scope_id: locationId })))
    : grantResult.data ?? [];
  const userIds = [...new Set(rows.map((row) => row.user_id))];
  if (!userIds.length) return [];
  const profiles = await db().from("profiles").select("id")
    .eq("company_id", companyId).eq("is_active", true).in("id", userIds);
  if (profiles.error) throw new Error(profiles.error.message);
  const activeUsers = new Set((profiles.data ?? []).map((profile) => profile.id));
  return rows.flatMap((row) => activeUsers.has(row.user_id)
    ? [{ userId: row.user_id, scopeType: row.scope_type, scopeId: row.scope_id ?? null }]
    : []);
}

export async function resolveAttendanceApprovalSteps({
  companyId,
  workerId,
  workerType
}: {
  companyId: string;
  workerId: string;
  workerType: "employee" | "contractor";
}): Promise<AttendanceApprovalStep[]> {
  const today = indiaToday();
  const workerColumn = workerType === "employee" ? "employee_id" : "contractor_id";
  const engagementResult = await db().from("hr_engagements").select("id,person_id,status")
    .eq("company_id", companyId).eq("worker_type", workerType).eq(workerColumn, workerId)
    .eq("status", "active").order("start_date", { ascending: false }).limit(1).maybeSingle();
  if (engagementResult.error || !engagementResult.data) {
    throw new Error(engagementResult.error?.message ?? "Your active People engagement is not configured.");
  }
  const assignmentResult = await db().from("hr_work_assignments")
    .select("id,location_id,is_top_level,effective_from,effective_to")
    .eq("company_id", companyId).eq("engagement_id", engagementResult.data.id).eq("is_primary", true)
    .lte("effective_from", today).or(`effective_to.is.null,effective_to.gte.${today}`)
    .order("effective_from", { ascending: false }).limit(1).maybeSingle();
  if (assignmentResult.error || !assignmentResult.data) {
    throw new Error(assignmentResult.error?.message ?? "Your active People assignment is not configured.");
  }
  const workerAssignment = assignmentResult.data;
  if (workerAssignment.is_top_level) {
    throw new Error("Top-level attendance regularization must be finalized directly by People.");
  }

  const [locationPolicy, companySettings, permittedApprovers] = await Promise.all([
    workerAssignment.location_id
      ? db().from("hr_attendance_location_policies").select("regularization_manager_levels")
          .eq("company_id", companyId).eq("location_id", workerAssignment.location_id)
          .eq("is_active", true).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    db().from("hr_company_settings").select("regularization_manager_levels")
      .eq("company_id", companyId).maybeSingle(),
    usersWithApprovalPermission(companyId)
  ]);
  if (locationPolicy.error) throw new Error(locationPolicy.error.message);
  if (companySettings.error) throw new Error(companySettings.error.message);
  const managerLevels = Number(locationPolicy.data?.regularization_manager_levels
    ?? companySettings.data?.regularization_manager_levels
    ?? 2);
  const steps: AttendanceApprovalStep[] = [];
  const seenPeople = new Set<string>([engagementResult.data.person_id]);
  let subjectAssignmentId = workerAssignment.id;
  const maxChainHops = managerLevels + 6;

  for (let hop = 0; hop < maxChainHops && steps.length < managerLevels; hop += 1) {
    const relationshipResult = await db().from("hr_reporting_relationships").select("manager_assignment_id")
      .eq("company_id", companyId).eq("subject_assignment_id", subjectAssignmentId)
      .eq("relationship_type", "solid_line").eq("is_primary", true)
      .lte("effective_from", today).or(`effective_to.is.null,effective_to.gte.${today}`)
      .order("effective_from", { ascending: false }).limit(1).maybeSingle();
    if (relationshipResult.error) throw new Error(relationshipResult.error.message);
    if (!relationshipResult.data) {
      if (steps.length) break;
      throw new Error("No reporting manager above team-lead level is configured for your profile.");
    }

    const managerAssignment = await db().from("hr_work_assignments")
      .select("id,engagement_id,position_title,designation_id,effective_from,effective_to")
      .eq("company_id", companyId).eq("id", relationshipResult.data.manager_assignment_id).maybeSingle();
    if (managerAssignment.error || !managerAssignment.data
      || managerAssignment.data.effective_from > today
      || (managerAssignment.data.effective_to && managerAssignment.data.effective_to < today)) {
      throw new Error("A reporting manager in your chain does not have an active assignment.");
    }
    subjectAssignmentId = managerAssignment.data.id;

    let designationCode: string | null = null;
    if (managerAssignment.data.designation_id) {
      const designationResult = await db().from("designations").select("code")
        .eq("company_id", companyId).eq("id", managerAssignment.data.designation_id).maybeSingle();
      if (designationResult.error) throw new Error(designationResult.error.message);
      designationCode = designationResult.data?.code ?? null;
    }
    if (isTeamLeadManagerAssignment(designationCode, managerAssignment.data.position_title)) {
      continue;
    }

    const managerEngagement = await db().from("hr_engagements").select("person_id,status")
      .eq("company_id", companyId).eq("id", managerAssignment.data.engagement_id).maybeSingle();
    if (managerEngagement.error || !managerEngagement.data || managerEngagement.data.status !== "active") {
      throw new Error("A reporting manager above team-lead level is not active.");
    }
    if (seenPeople.has(managerEngagement.data.person_id)) throw new Error("The reporting chain contains a cycle.");
    seenPeople.add(managerEngagement.data.person_id);
    const [personResult, linkResult] = await Promise.all([
      db().from("hr_people").select("display_name").eq("company_id", companyId).eq("id", managerEngagement.data.person_id).maybeSingle(),
      db().from("hr_user_person_links").select("user_id,status")
        .eq("company_id", companyId).eq("person_id", managerEngagement.data.person_id).maybeSingle()
    ]);
    if (personResult.error || linkResult.error) {
      throw new Error(personResult.error?.message ?? linkResult.error?.message ?? "Manager account could not be resolved.");
    }
    if (!linkResult.data || linkResult.data.status !== "active") {
      throw new Error(`${personResult.data?.display_name ?? "Reporting manager"} does not have an active People login.`);
    }
    const grants = permittedApprovers.filter((item) => item.userId === linkResult.data?.user_id);
    const mayApprove = grants.some((grant) => grant.scopeType === "company"
      || (grant.scopeType === "location" && grant.scopeId === workerAssignment.location_id)
      || grant.scopeType === "direct_reports" || grant.scopeType === "reporting_subtree");
    if (!mayApprove) {
      throw new Error(`${personResult.data?.display_name ?? "Reporting manager"} is not enabled for Approval Inbox approval.`);
    }
    steps.push({
      step_name: `${managerAssignment.data.position_title} approval`,
      approver_user_id: linkResult.data.user_id,
      approver_person_id: managerEngagement.data.person_id
    });
  }
  if (!steps.length) {
    throw new Error("No reporting manager above team-lead level is configured for attendance regularization.");
  }
  return steps;
}
