import "server-only";

import { resolveConfiguredApprovalWorkflow, type ConfiguredApprovalStep } from "@/lib/approval-workflow-routing";
import { isTeamLeadDesignation } from "@/lib/approval-designation-labels";
import { resolveConnectApproverUserId } from "@/lib/connect-approver-identity";
import { supabaseAdmin } from "@/lib/supabase-admin";

export type AttendanceRegularizationApprovalStep = {
  step_name: string;
  approver_user_id: string;
  approver_person_id: string;
  route_id?: string;
  resolved_via?: string;
  original_approver_person_id?: string | null;
  fallback_reason?: string | null;
};

export type AttendanceRegularizationRouteResolution = {
  routeName: string;
  steps: AttendanceRegularizationApprovalStep[];
  requiresHrFinal: boolean;
  directToHr: boolean;
};

const WORKFLOW_CODE = "attendance_regularization";

function db() {
  if (!supabaseAdmin) throw new Error("Database configuration is missing.");
  return supabaseAdmin;
}

function indiaToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function mapStep(step: ConfiguredApprovalStep): AttendanceRegularizationApprovalStep {
  return {
    step_name: step.step_name,
    approver_user_id: step.approver_user_id,
    approver_person_id: step.approver_person_id,
    route_id: step.route_id,
    resolved_via: step.resolved_via,
    original_approver_person_id: step.original_approver_person_id,
    fallback_reason: step.fallback_reason
  };
}

async function noRouteFallbackLabel(companyId: string) {
  const catalog = await db().from("hr_approval_workflow_catalog")
    .select("no_route_fallback_name")
    .eq("company_id", companyId)
    .eq("workflow_code", WORKFLOW_CODE)
    .maybeSingle();
  if (catalog.error) throw new Error(catalog.error.message);
  const label = catalog.data?.no_route_fallback_name?.trim();
  return label || "Missed approver head";
}

async function routeRequiresHrFinal(companyId: string, routeId: string) {
  const route = await db().from("hr_approval_workflow_routes")
    .select("hr_final_required")
    .eq("company_id", companyId)
    .eq("id", routeId)
    .maybeSingle();
  if (route.error) throw new Error(route.error.message);
  return route.data?.hr_final_required ?? true;
}

async function managerLevels(companyId: string) {
  const settings = await db().from("hr_company_settings").select("regularization_manager_levels")
    .eq("company_id", companyId).maybeSingle();
  if (settings.error) throw new Error(settings.error.message);
  return Math.max(1, Math.min(Number(settings.data?.regularization_manager_levels ?? 2), 2));
}

async function resolveChainFallbackSteps(input: {
  companyId: string;
  workerType: "employee" | "contractor";
  workerId: string;
  asOf: string;
  managerLevels: number;
}) {
  const workerColumn = input.workerType === "employee" ? "employee_id" : "contractor_id";
  const engagement = await db().from("hr_engagements").select("id,person_id,status")
    .eq("company_id", input.companyId).eq("worker_type", input.workerType).eq(workerColumn, input.workerId)
    .eq("status", "active").order("start_date", { ascending: false }).limit(1).maybeSingle();
  if (engagement.error || !engagement.data) return [];

  const assignment = await db().from("hr_work_assignments")
    .select("id,location_id,is_top_level")
    .eq("company_id", input.companyId).eq("engagement_id", engagement.data.id).eq("is_primary", true)
    .lte("effective_from", input.asOf).or(`effective_to.is.null,effective_to.gte.${input.asOf}`)
    .order("effective_from", { ascending: false }).limit(1).maybeSingle();
  if (assignment.error || !assignment.data || assignment.data.is_top_level) return [];

  const steps: AttendanceRegularizationApprovalStep[] = [];
  const seenPeople = new Set<string>([engagement.data.person_id]);
  let subjectAssignmentId = assignment.data.id;

  for (let hop = 0; hop < 16 && steps.length < input.managerLevels; hop += 1) {
    const relationship = await db().from("hr_reporting_relationships").select("manager_assignment_id")
      .eq("company_id", input.companyId).eq("subject_assignment_id", subjectAssignmentId)
      .eq("relationship_type", "solid_line").eq("is_primary", true)
      .lte("effective_from", input.asOf).or(`effective_to.is.null,effective_to.gte.${input.asOf}`)
      .order("effective_from", { ascending: false }).limit(1).maybeSingle();
    if (relationship.error) throw new Error(relationship.error.message);
    if (!relationship.data) break;

    const managerAssignment = await db().from("hr_work_assignments")
      .select("id,engagement_id,position_title,designation_id,effective_from,effective_to")
      .eq("company_id", input.companyId).eq("id", relationship.data.manager_assignment_id).maybeSingle();
    if (managerAssignment.error || !managerAssignment.data
      || managerAssignment.data.effective_from > input.asOf
      || (managerAssignment.data.effective_to && managerAssignment.data.effective_to < input.asOf)) {
      break;
    }
    subjectAssignmentId = managerAssignment.data.id;

    let designationLabel: { name: string; code: string | null } | null = null;
    if (managerAssignment.data.designation_id) {
      const designation = await db().from("designations").select("name,code")
        .eq("company_id", input.companyId).eq("id", managerAssignment.data.designation_id).maybeSingle();
      if (designation.error) throw new Error(designation.error.message);
      designationLabel = designation.data ? { name: designation.data.name, code: designation.data.code } : null;
    }
    if (isTeamLeadDesignation(designationLabel)) continue;

    const managerEngagement = await db().from("hr_engagements").select("person_id,status,worker_type,employee_id,contractor_id")
      .eq("company_id", input.companyId).eq("id", managerAssignment.data.engagement_id).maybeSingle();
    if (managerEngagement.error || !managerEngagement.data || managerEngagement.data.status !== "active") continue;
    if (seenPeople.has(managerEngagement.data.person_id)) break;
    seenPeople.add(managerEngagement.data.person_id);

    const person = await db().from("hr_people").select("display_name,status")
      .eq("company_id", input.companyId).eq("id", managerEngagement.data.person_id).maybeSingle();
    if (person.error || !person.data || person.data.status !== "active") continue;

    let leaveQuery = db().from("hr_leave_requests").select("id").eq("company_id", input.companyId).eq("status", "approved")
      .lte("start_date", input.asOf).gte("end_date", input.asOf).limit(1);
    leaveQuery = managerEngagement.data.worker_type === "employee"
      ? leaveQuery.eq("employee_id", managerEngagement.data.employee_id)
      : leaveQuery.eq("contractor_id", managerEngagement.data.contractor_id);
    const leave = await leaveQuery.maybeSingle();
    if (leave.error) throw new Error(leave.error.message);
    if (leave.data) continue;

    const approverUserId = await resolveConnectApproverUserId(input.companyId, managerEngagement.data.person_id);
    if (!approverUserId) continue;

    steps.push({
      step_name: `${managerAssignment.data.position_title || "Reporting manager"} approval`,
      approver_user_id: approverUserId,
      approver_person_id: managerEngagement.data.person_id,
      resolved_via: steps.length ? "fallback" : "configured_designation",
      original_approver_person_id: null,
      fallback_reason: steps.length ? "Next available reporting manager" : null
    });
  }

  return steps;
}

/**
 * Resolves attendance regularization manager approval steps before HR finalization.
 *
 * Flow:
 * 1. Use configured route from Approval Workflow Master for up to two manager levels.
 * 2. If the route cannot resolve enough managers, walk the reporting chain and pick the
 *    next available non-team-lead manager with DropX One access.
 * 3. If no manager can be resolved, route directly to HR.
 */
export async function resolveAttendanceRegularizationApprovers(
  companyId: string,
  workerType: "employee" | "contractor",
  workerId: string,
  asOf?: string
): Promise<AttendanceRegularizationRouteResolution> {
  const today = asOf ?? indiaToday();
  const levels = await managerLevels(companyId);

  try {
    const configured = await resolveConfiguredApprovalWorkflow({
      companyId,
      workflowCode: WORKFLOW_CODE,
      workerType,
      workerId,
      asOf: today,
      maxLevel: levels > 1 ? 2 : 1
    });

    if (configured?.steps.length) {
      let steps = configured.steps.map(mapStep);
      if (steps.length < levels) {
        const chainSteps = await resolveChainFallbackSteps({
          companyId,
          workerType,
          workerId,
          asOf: today,
          managerLevels: levels
        });
        const seenPeople = new Set(steps.map((step) => step.approver_person_id));
        for (const step of chainSteps) {
          if (steps.length >= levels) break;
          if (seenPeople.has(step.approver_person_id)) continue;
          seenPeople.add(step.approver_person_id);
          steps.push(step);
        }
      }
      return {
        routeName: configured.routeName,
        steps,
        requiresHrFinal: await routeRequiresHrFinal(companyId, configured.routeId),
        directToHr: false
      };
    }
  } catch (error) {
    console.warn("Configured attendance regularization route failed, trying reporting-chain fallback:", error);
  }

  const chainSteps = await resolveChainFallbackSteps({
    companyId,
    workerType,
    workerId,
    asOf: today,
    managerLevels: levels
  });
  if (chainSteps.length) {
    return {
      routeName: "Reporting manager chain",
      steps: chainSteps,
      requiresHrFinal: true,
      directToHr: false
    };
  }

  return {
    routeName: await noRouteFallbackLabel(companyId),
    steps: [],
    requiresHrFinal: true,
    directToHr: true
  };
}
