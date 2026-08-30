import "server-only";

import { resolveConfiguredApprovalWorkflow } from "./configured-approval-routing";
import { supabaseAdmin } from "./supabase-admin";
import { canUseAvailableManagerChain } from "./leave-approval-chain";

export type LeaveWorkerType = "employee" | "contractor";
export type LeaveApprovalStep = {
  step_name: string;
  approver_user_id: string;
  approver_person_id: string;
};

export type WorkforceLeaveEntitlement = {
  leave_type_id: string;
  name: string;
  code: string;
  color: string;
  annual_allowance: number;
  is_paid: boolean;
  balance_mode: "annual_balance" | "unlimited_unpaid";
  attendance_code: string;
  attendance_label: string;
  rule_id: string;
  scope_type: "company" | "location" | "designation" | "location_designation";
};

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
  const profileResult = await db().from("profiles").select("id")
    .eq("company_id", companyId).eq("is_active", true).in("id", userIds);
  if (profileResult.error) throw new Error(profileResult.error.message);
  const activeUsers = new Set((profileResult.data ?? []).map((profile) => profile.id));
  return rows.flatMap((row) => activeUsers.has(row.user_id)
    ? [{ userId: row.user_id, scopeType: row.scope_type, scopeId: row.scope_id ?? null }]
    : []);
}

async function activeWorkforceContext(companyId: string, workerId: string, workerType: LeaveWorkerType) {
  const today = indiaToday();
  const workerColumn = workerType === "employee" ? "employee_id" : "contractor_id";
  const engagementResult = await db().from("hr_engagements").select("id,person_id,status")
    .eq("company_id", companyId).eq("worker_type", workerType).eq(workerColumn, workerId).maybeSingle();
  if (engagementResult.error || !engagementResult.data || engagementResult.data.status !== "active") {
    throw new Error(engagementResult.error?.message ?? "Your active People engagement is not configured.");
  }
  const assignmentResult = await db().from("hr_work_assignments")
    .select("id,business_line,position_title,location_id,designation_id,is_top_level,effective_from,effective_to")
    .eq("company_id", companyId).eq("engagement_id", engagementResult.data.id).eq("is_primary", true)
    .lte("effective_from", today).or(`effective_to.is.null,effective_to.gte.${today}`)
    .order("effective_from", { ascending: false }).limit(1).maybeSingle();
  if (assignmentResult.error || !assignmentResult.data) {
    throw new Error(assignmentResult.error?.message ?? "Your active work assignment is not configured.");
  }
  return { today, engagement: engagementResult.data, assignment: assignmentResult.data };
}

export async function resolveWorkforceLeaveEntitlements({ companyId, workerId, workerType }: {
  companyId: string;
  workerId: string;
  workerType: LeaveWorkerType;
}): Promise<WorkforceLeaveEntitlement[]> {
  const context = await activeWorkforceContext(companyId, workerId, workerType);
  const result = await db().rpc("hr_resolve_leave_entitlements", {
    p_company_id: companyId,
    p_worker_type: workerType,
    p_location_id: context.assignment.location_id,
    p_designation_id: context.assignment.designation_id,
    p_as_of: context.today
  });
  if (result.error) throw new Error(result.error.message);
  return (result.data ?? []) as WorkforceLeaveEntitlement[];
}

export async function resolveWorkforceLeaveApproval({ companyId, workerId, workerType, days }: {
  companyId: string;
  workerId: string;
  workerType: LeaveWorkerType;
  days: number;
}) {
  const { today, engagement, assignment } = await activeWorkforceContext(companyId, workerId, workerType);
  const requesterLink = await db().from("hr_user_person_links").select("user_id,status")
    .eq("company_id", companyId).eq("person_id", engagement.person_id).maybeSingle();
  if (requesterLink.error) throw new Error(requesterLink.error.message);
  if (assignment.is_top_level) {
    return {
      direct: true,
      policyName: "Top-level direct record",
      requesterUserId: requesterLink.data?.status === "active" ? requesterLink.data.user_id : null,
      steps: [] as LeaveApprovalStep[]
    };
  }
  const configured = await resolveConfiguredApprovalWorkflow({
    companyId,
    workflowCode: "leave_request",
    workerId,
    workerType,
    asOf: today
  });
  if (configured) {
    return {
      direct: false,
      policyName: configured.routeName,
      requesterUserId: requesterLink.data?.status === "active" ? requesterLink.data.user_id : null,
      steps: configured.steps.map((step) => ({
        step_name: step.step_name,
        approver_user_id: step.approver_user_id,
        approver_person_id: step.approver_person_id
      }))
    };
  }
  const policyResult = await db().from("hr_leave_approval_policies")
    .select("name,business_line,location_id,designation_id,manager_levels,priority,minimum_days")
    .eq("company_id", companyId).eq("worker_type", workerType).eq("is_active", true)
    .lte("minimum_days", days).or(`maximum_days.is.null,maximum_days.gte.${days}`)
    .order("priority").order("minimum_days", { ascending: false });
  if (policyResult.error) throw new Error(policyResult.error.message);
  const policy = (policyResult.data ?? [])
    .filter((item) => (!item.business_line || item.business_line === assignment.business_line)
      && (!item.location_id || item.location_id === assignment.location_id)
      && (!item.designation_id || item.designation_id === assignment.designation_id))
    .sort((left, right) => {
      const leftScope = left.location_id && left.designation_id ? 3 : left.location_id ? 2 : left.designation_id ? 1 : 0;
      const rightScope = right.location_id && right.designation_id ? 3 : right.location_id ? 2 : right.designation_id ? 1 : 0;
      return rightScope - leftScope || left.priority - right.priority || right.minimum_days - left.minimum_days;
    })[0];
  if (!policy) throw new Error("No active leave approval policy matches this request.");
  const permittedApprovers = await usersWithApprovalPermission(companyId);
  const steps: LeaveApprovalStep[] = [];
  const seenPeople = new Set<string>([engagement.person_id]);
  let subjectAssignmentId = assignment.id;
  for (let level = 1; level <= policy.manager_levels; level += 1) {
    const relationshipResult = await db().from("hr_reporting_relationships").select("manager_assignment_id")
      .eq("company_id", companyId).eq("subject_assignment_id", subjectAssignmentId)
      .eq("relationship_type", "solid_line").eq("is_primary", true)
      .lte("effective_from", today).or(`effective_to.is.null,effective_to.gte.${today}`)
      .order("effective_from", { ascending: false }).limit(1).maybeSingle();
    if (relationshipResult.error) throw new Error(relationshipResult.error.message);
    if (!relationshipResult.data) {
      // Policies define the maximum approval depth. A valid shorter hierarchy uses
      // every available manager instead of blocking the worker at a missing upper level.
      if (canUseAvailableManagerChain(level, steps.length)) break;
      throw new Error(`Reporting manager level ${level} is not configured for your profile.`);
    }
    const managerAssignment = await db().from("hr_work_assignments")
      .select("id,engagement_id,position_title,effective_from,effective_to")
      .eq("company_id", companyId).eq("id", relationshipResult.data.manager_assignment_id).maybeSingle();
    if (managerAssignment.error || !managerAssignment.data || managerAssignment.data.effective_from > today || (managerAssignment.data.effective_to && managerAssignment.data.effective_to < today)) {
      throw new Error(`Reporting manager level ${level} does not have an active assignment.`);
    }
    const managerEngagement = await db().from("hr_engagements").select("person_id,status")
      .eq("company_id", companyId).eq("id", managerAssignment.data.engagement_id).maybeSingle();
    if (managerEngagement.error || !managerEngagement.data || managerEngagement.data.status !== "active") throw new Error(`Reporting manager level ${level} is not active.`);
    if (seenPeople.has(managerEngagement.data.person_id)) throw new Error("The reporting chain contains a cycle.");
    seenPeople.add(managerEngagement.data.person_id);
    const [personResult, linkResult] = await Promise.all([
      db().from("hr_people").select("display_name").eq("company_id", companyId).eq("id", managerEngagement.data.person_id).maybeSingle(),
      db().from("hr_user_person_links").select("user_id,status").eq("company_id", companyId).eq("person_id", managerEngagement.data.person_id).maybeSingle()
    ]);
    if (personResult.error || linkResult.error) throw new Error(personResult.error?.message ?? linkResult.error?.message ?? "Manager account could not be resolved.");
    if (!linkResult.data || linkResult.data.status !== "active") throw new Error(`${personResult.data?.display_name ?? `Manager level ${level}`} does not have an active People login.`);
    const grants = permittedApprovers.filter((item) => item.userId === linkResult.data?.user_id);
    const mayApprove = grants.some((grant) => grant.scopeType === "company"
      || (grant.scopeType === "location" && grant.scopeId === assignment.location_id)
      || grant.scopeType === "direct_reports" || grant.scopeType === "reporting_subtree");
    if (!mayApprove) throw new Error(`${personResult.data?.display_name ?? `Manager level ${level}`} is not enabled for Approval Inbox approval.`);
    steps.push({
      step_name: `${managerAssignment.data.position_title} approval`,
      approver_user_id: linkResult.data.user_id,
      approver_person_id: managerEngagement.data.person_id
    });
    subjectAssignmentId = managerAssignment.data.id;
  }
  return {
    direct: false,
    policyName: policy.name,
    requesterUserId: requesterLink.data?.status === "active" ? requesterLink.data.user_id : null,
    steps
  };
}
