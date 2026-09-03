import "server-only";

import { resolveConfiguredApprovalWorkflow } from "@/lib/approval-workflow-routing";
import { isCompanyOwner, type AuthorizationContext } from "@/lib/authorization";
import type { CodLocationRow } from "@/lib/ops-pulse/cod";
import { loadOpsStationManpower } from "@/lib/ops-pulse/station-manpower";
import { supabaseAdmin } from "@/lib/supabase-admin";

type WorkerType = "employee" | "contractor";
type StageType = "level_1" | "level_2" | "hr";

export type OpsRosterPerson = {
  id: string;
  workerType: WorkerType;
  code: string;
  name: string;
  designation: string;
  locationId: string;
};

export type OpsRosterShift = {
  id: string;
  code: string;
  name: string;
  startTime: string;
  endTime: string;
  color: string;
};

export type OpsRosterEntry = {
  id: string;
  workerType: WorkerType;
  workerId: string;
  rosterDate: string;
  dayType: "working" | "weekly_off";
  shiftId: string | null;
  notes: string | null;
};

export type OpsRosterPlan = {
  id: string;
  name: string;
  locationId: string;
  periodStart: string;
  periodEnd: string;
  effectiveFrom: string | null;
  supersededAt: string | null;
  revisionNo: number;
  status: string;
  submittedAt: string | null;
  decisionNote: string | null;
  entries: OpsRosterEntry[];
};

export type OpsRosterPolicy = {
  submissionLeadDays: number;
  approvalRequired: boolean;
  approvalLevels: 1 | 2;
  hrApprovalRequired: boolean;
};

export type OpsRosterCapabilities = {
  designationId: string | null;
  designationName: string | null;
  canPlan: boolean;
  canApprove: boolean;
  canApproveL1: boolean;
  canApproveL2: boolean;
  canApproveHr: boolean;
  canPublishDirect: boolean;
};

export type OpsRosterApprovalRoute = {
  direct: boolean;
  approvalRequired: boolean;
  summary: string;
  error: string | null;
  steps: Array<{
    stageNo: number;
    stageType: StageType;
    approverUserId: string | null;
    approverName: string | null;
    routeId?: string;
    resolvedVia?: string;
    originalApproverPersonId?: string | null;
    fallbackReason?: string | null;
  }>;
};

export type OpsRosterApproval = {
  stepId: string;
  planId: string;
  stationCode: string;
  stationName: string;
  periodStart: string;
  periodEnd: string;
  revisionNo: number;
  stageNo: number;
  stageType: StageType;
  submittedAt: string | null;
  submittedBy: string;
  peopleCount: number;
  assignmentCount: number;
};

function db() {
  if (!supabaseAdmin) throw new Error("Database service is unavailable.");
  return supabaseAdmin;
}

export function indiaToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

export function addRosterDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function rosterMonday(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - weekday + 1);
  return date.toISOString().slice(0, 10);
}

export function rosterPlanLocationIds(plan: { location_id?: string | null; hr_roster_plan_locations?: Array<{ location_id: string }> | null }) {
  const ids = (plan.hr_roster_plan_locations ?? []).map((item) => item.location_id).filter(Boolean);
  if (plan.location_id && !ids.includes(plan.location_id)) ids.unshift(plan.location_id);
  return [...new Set(ids)];
}

export function canUseRosterLocation(authorization: AuthorizationContext, locationId: string) {
  return authorization.hasAllLocationAccess || authorization.locationScopeIds.includes(locationId);
}

export async function loadOpsRosteringPolicy(companyId: string, locationId?: string | null): Promise<OpsRosterPolicy> {
  const company = await db().from("hr_company_settings")
    .select("roster_submission_lead_days,roster_approval_manager_levels,roster_approval_required,roster_approval_levels,roster_hr_approval_required")
    .eq("company_id", companyId)
    .maybeSingle();
  if (company.error) throw new Error(company.error.message);

  let locationPolicy: { approval_required: boolean; approval_levels: number; hr_approval_required: boolean } | null = null;
  if (locationId) {
    const result = await db().from("hr_roster_location_policies")
      .select("approval_required,approval_levels,hr_approval_required")
      .eq("company_id", companyId)
      .eq("location_id", locationId)
      .maybeSingle();
    if (result.error) throw new Error(result.error.message);
    locationPolicy = result.data;
  }

  const approvalLevels = Number(locationPolicy?.approval_levels ?? company.data?.roster_approval_levels ?? company.data?.roster_approval_manager_levels ?? 1) === 2 ? 2 : 1;
  return {
    submissionLeadDays: Number(company.data?.roster_submission_lead_days ?? 3),
    approvalRequired: Boolean(locationPolicy?.approval_required ?? company.data?.roster_approval_required ?? true),
    approvalLevels,
    hrApprovalRequired: Boolean(locationPolicy?.hr_approval_required ?? company.data?.roster_hr_approval_required ?? false)
  };
}

type ActorIdentity = {
  personId: string | null;
  workerType: WorkerType | null;
  workerId: string | null;
  assignmentId: string | null;
  designationId: string | null;
  designationName: string | null;
};

async function actorIdentity(authorization: AuthorizationContext): Promise<ActorIdentity> {
  const today = indiaToday();
  const link = await db().from("hr_user_person_links")
    .select("person_id")
    .eq("company_id", authorization.companyId)
    .eq("user_id", authorization.userId)
    .eq("status", "active")
    .maybeSingle();
  if (link.error) throw new Error(link.error.message);
  if (!link.data?.person_id) return { personId: null, workerType: null, workerId: null, assignmentId: null, designationId: null, designationName: null };

  const engagement = await db().from("hr_engagements")
    .select("id,worker_type,employee_id,contractor_id")
    .eq("company_id", authorization.companyId)
    .eq("person_id", link.data.person_id)
    .eq("status", "active")
    .order("start_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (engagement.error) throw new Error(engagement.error.message);
  if (!engagement.data) return { personId: link.data.person_id, workerType: null, workerId: null, assignmentId: null, designationId: null, designationName: null };

  const assignment = await db().from("hr_work_assignments")
    .select("id,designation_id")
    .eq("company_id", authorization.companyId)
    .eq("engagement_id", engagement.data.id)
    .eq("is_primary", true)
    .lte("effective_from", today)
    .or(`effective_to.is.null,effective_to.gte.${today}`)
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (assignment.error) throw new Error(assignment.error.message);
  const designation = assignment.data?.designation_id
    ? await db().from("designations").select("name").eq("company_id", authorization.companyId).eq("id", assignment.data.designation_id).maybeSingle()
    : { data: null, error: null };
  if (designation.error) throw new Error(designation.error.message);
  const workerType = engagement.data.worker_type === "employee" || engagement.data.worker_type === "contractor" ? engagement.data.worker_type : null;
  const workerId = workerType === "employee" ? engagement.data.employee_id : workerType === "contractor" ? engagement.data.contractor_id : null;
  return {
    personId: link.data.person_id,
    workerType,
    workerId,
    assignmentId: assignment.data?.id ?? null,
    designationId: assignment.data?.designation_id ?? null,
    designationName: designation.data?.name ?? null
  };
}

export async function loadOpsRosterCapabilities(authorization: AuthorizationContext): Promise<OpsRosterCapabilities> {
  const owner = isCompanyOwner(authorization);
  const identity = await actorIdentity(authorization);
  if (!identity.designationId) {
    return {
      designationId: null,
      designationName: identity.designationName,
      canPlan: owner,
      canApprove: owner,
      canApproveL1: owner,
      canApproveL2: owner,
      canApproveHr: owner,
      canPublishDirect: owner
    };
  }
  const result = await db().from("hr_roster_designation_rules")
    .select("can_plan,can_approve,can_approve_l1,can_approve_l2,can_approve_hr,can_publish_direct")
    .eq("company_id", authorization.companyId)
    .eq("designation_id", identity.designationId)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  const canApproveL1 = Boolean(result.data?.can_approve_l1 ?? result.data?.can_approve);
  const canApproveL2 = Boolean(result.data?.can_approve_l2);
  const canApproveHr = Boolean(result.data?.can_approve_hr);
  return {
    designationId: identity.designationId,
    designationName: identity.designationName,
    canPlan: owner || Boolean(result.data?.can_plan),
    canApprove: owner || canApproveL1 || canApproveL2 || canApproveHr,
    canApproveL1: owner || canApproveL1,
    canApproveL2: owner || canApproveL2,
    canApproveHr: owner || canApproveHr,
    canPublishDirect: owner || Boolean(result.data?.can_publish_direct)
  };
}

type ApprovalCandidate = {
  userId: string;
  designationId: string | null;
  name: string;
};

async function reportingManagerChain(authorization: AuthorizationContext, assignmentId: string | null): Promise<ApprovalCandidate[]> {
  if (!assignmentId) return [];
  const today = indiaToday();
  const chain: ApprovalCandidate[] = [];
  const seen = new Set([assignmentId]);
  let subjectAssignmentId = assignmentId;
  for (let depth = 0; depth < 10; depth += 1) {
    const relationship = await db().from("hr_reporting_relationships")
      .select("manager_assignment_id")
      .eq("company_id", authorization.companyId)
      .eq("subject_assignment_id", subjectAssignmentId)
      .eq("relationship_type", "solid_line")
      .eq("is_primary", true)
      .lte("effective_from", today)
      .or(`effective_to.is.null,effective_to.gte.${today}`)
      .order("effective_from", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (relationship.error) throw new Error(relationship.error.message);
    const managerAssignmentId = relationship.data?.manager_assignment_id;
    if (!managerAssignmentId || seen.has(managerAssignmentId)) break;
    seen.add(managerAssignmentId);
    subjectAssignmentId = managerAssignmentId;

    const managerAssignment = await db().from("hr_work_assignments")
      .select("engagement_id,designation_id")
      .eq("company_id", authorization.companyId)
      .eq("id", managerAssignmentId)
      .maybeSingle();
    if (managerAssignment.error) throw new Error(managerAssignment.error.message);
    if (!managerAssignment.data?.engagement_id) continue;
    const engagement = await db().from("hr_engagements")
      .select("person_id")
      .eq("company_id", authorization.companyId)
      .eq("id", managerAssignment.data.engagement_id)
      .eq("status", "active")
      .maybeSingle();
    if (engagement.error) throw new Error(engagement.error.message);
    if (!engagement.data?.person_id) continue;
    const [person, link] = await Promise.all([
      db().from("hr_people").select("display_name").eq("company_id", authorization.companyId).eq("id", engagement.data.person_id).eq("status", "active").maybeSingle(),
      db().from("hr_user_person_links").select("user_id").eq("company_id", authorization.companyId).eq("person_id", engagement.data.person_id).eq("status", "active").maybeSingle()
    ]);
    if (person.error || link.error) throw new Error(person.error?.message ?? link.error?.message ?? "The reporting line could not be resolved.");
    if (link.data?.user_id && link.data.user_id !== authorization.userId) {
      chain.push({ userId: link.data.user_id, designationId: managerAssignment.data.designation_id, name: person.data?.display_name ?? "Reporting manager" });
    }
  }
  return chain;
}

export async function resolveOpsRosterApprovalRoute(authorization: AuthorizationContext, policy: OpsRosterPolicy): Promise<OpsRosterApprovalRoute> {
  if (!policy.approvalRequired) return { direct: true, approvalRequired: false, summary: "Applies directly under the station policy.", error: null, steps: [] };
  const [capabilities, identity] = await Promise.all([loadOpsRosterCapabilities(authorization), actorIdentity(authorization)]);
  if (capabilities.canPublishDirect) return { direct: true, approvalRequired: false, summary: "Your designation can apply roster changes directly.", error: null, steps: [] };

  if (identity.workerType && identity.workerId) {
    const configured = await resolveConfiguredApprovalWorkflow({
      companyId: authorization.companyId!,
      workerType: identity.workerType,
      workerId: identity.workerId,
      workflowCode: "roster_publish"
    });
    if (configured) {
      return {
        direct: false,
        approvalRequired: true,
        error: null,
        summary: `Approval route: ${configured.steps.map((step) => step.approver_name).join(" → ")}.`,
        steps: configured.steps.map((step, index) => ({
          stageNo: index + 1,
          stageType: index === 0 ? "level_1" : index === configured.steps.length - 1 && /hr/i.test(step.step_name) ? "hr" : "level_2",
          approverUserId: step.approver_user_id,
          approverName: step.approver_name,
          routeId: step.route_id,
          resolvedVia: step.resolved_via,
          originalApproverPersonId: step.original_approver_person_id,
          fallbackReason: step.fallback_reason
        }))
      };
    }
  }

  const [chain, rules] = await Promise.all([
    reportingManagerChain(authorization, identity.assignmentId),
    db().from("hr_roster_designation_rules")
      .select("designation_id,can_approve,can_approve_l1,can_approve_l2")
      .eq("company_id", authorization.companyId)
  ]);
  if (rules.error) throw new Error(rules.error.message);
  const byDesignation = new Map((rules.data ?? []).map((rule) => [rule.designation_id, rule]));
  const level1Index = chain.findIndex((manager) => {
    const rule = manager.designationId ? byDesignation.get(manager.designationId) : null;
    return Boolean(rule?.can_approve_l1 ?? rule?.can_approve);
  });
  const level1 = level1Index >= 0 ? chain[level1Index] : null;
  const level2 = policy.approvalLevels === 2 && level1
    ? chain.slice(level1Index + 1).find((manager) => Boolean(manager.designationId && byDesignation.get(manager.designationId)?.can_approve_l2)) ?? null
    : null;
  if (!level1) return { direct: false, approvalRequired: true, summary: "No Level 1 roster approver is configured above you.", error: "No Level 1 roster approver is configured above you. Contact HR.", steps: [] };
  if (policy.approvalLevels === 2 && !level2) return { direct: false, approvalRequired: true, summary: "No Level 2 roster approver is configured above Level 1.", error: "No Level 2 roster approver is configured above Level 1. Contact HR.", steps: [] };
  const managerSteps: OpsRosterApprovalRoute["steps"] = [
    { stageNo: 1, stageType: "level_1", approverUserId: level1.userId, approverName: level1.name },
    ...(level2 ? [{ stageNo: 2, stageType: "level_2" as const, approverUserId: level2.userId, approverName: level2.name }] : [])
  ];
  const steps = policy.hrApprovalRequired
    ? [...managerSteps, { stageNo: managerSteps.length + 1, stageType: "hr" as const, approverUserId: null, approverName: "HR roster approver group" }]
    : managerSteps;
  return { direct: false, approvalRequired: true, summary: `Approval route: ${steps.map((step) => step.approverName).join(" → ")}.`, error: null, steps };
}

function relation<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function normalizePlan(row: Record<string, any>): OpsRosterPlan {
  return {
    id: row.id,
    name: row.name,
    locationId: row.location_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    effectiveFrom: row.effective_from,
    supersededAt: row.superseded_at,
    revisionNo: Number(row.revision_no ?? 1),
    status: row.status,
    submittedAt: row.submitted_at,
    decisionNote: row.decision_note,
    entries: (row.hr_roster_entries ?? []).map((entry: Record<string, any>) => ({
      id: entry.id,
      workerType: entry.worker_type,
      workerId: entry.worker_id,
      rosterDate: entry.roster_date,
      dayType: entry.day_type,
      shiftId: entry.shift_id,
      notes: entry.notes
    }))
  };
}

export async function loadOpsRosterWorkspace(companyId: string, location: CodLocationRow) {
  const today = indiaToday();
  const [manpower, planResult, shiftResult] = await Promise.all([
    loadOpsStationManpower(companyId, [location], today),
    db().from("hr_roster_plans")
      .select("id,name,location_id,period_start,period_end,status,decision_note,roster_kind,effective_from,superseded_at,revision_no,submitted_at,created_at,hr_roster_entries(id,worker_type,worker_id,roster_date,day_type,shift_id,notes)")
      .eq("company_id", companyId)
      .eq("location_id", location.id)
      .eq("roster_kind", "recurring_weekly")
      .order("created_at", { ascending: false })
      .limit(20),
    db().from("hr_shifts")
      .select("id,code,name,start_time,end_time,color")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("start_time")
  ]);
  if (planResult.error || shiftResult.error) throw new Error(planResult.error?.message ?? shiftResult.error?.message ?? "Rostering could not be loaded.");
  const plans = (planResult.data ?? []).map((row) => normalizePlan(row as Record<string, any>));
  const openPlan = plans.find((plan) => ["draft", "returned", "pending_approval"].includes(plan.status)) ?? null;
  const approved = plans.filter((plan) => plan.status === "approved" && plan.effectiveFrom).sort((left, right) => String(right.effectiveFrom).localeCompare(String(left.effectiveFrom)));
  const activePlan = approved.find((plan) => String(plan.effectiveFrom) <= today && (!plan.supersededAt || today < plan.supersededAt)) ?? null;
  const selectedPlan = openPlan ?? activePlan ?? approved[0] ?? null;
  return {
    people: manpower.people.map((person): OpsRosterPerson => ({
      id: person.id,
      workerType: person.workerType,
      code: person.code,
      name: person.name,
      designation: person.designation,
      locationId: person.locationId
    })),
    shifts: (shiftResult.data ?? []).map((shift): OpsRosterShift => ({
      id: shift.id,
      code: shift.code,
      name: shift.name,
      startTime: shift.start_time,
      endTime: shift.end_time,
      color: shift.color || "#e5502c"
    })),
    openPlan,
    activePlan,
    selectedPlan,
    blankPeriodStart: rosterMonday(today),
    blankPeriodEnd: addRosterDays(rosterMonday(today), 6)
  };
}

export async function loadAssignedOpsRosterApprovals(authorization: AuthorizationContext): Promise<OpsRosterApproval[]> {
  const capabilities = await loadOpsRosterCapabilities(authorization);
  if (!capabilities.canApprove) return [];
  const result = await db().from("hr_roster_approval_steps")
    .select("id,plan_id,stage_no,stage_type,status,approver_user_id")
    .eq("company_id", authorization.companyId)
    .eq("status", "pending")
    .order("created_at")
    .limit(200);
  if (result.error) throw new Error(result.error.message);
  const owner = isCompanyOwner(authorization);
  const steps = (result.data ?? []).filter((step) => owner || step.approver_user_id === authorization.userId || (step.stage_type === "hr" && !step.approver_user_id && capabilities.canApproveHr));
  if (!steps.length) return [];
  const planIds = [...new Set(steps.map((step) => step.plan_id))];
  const plans = await db().from("hr_roster_plans")
    .select("id,location_id,period_start,period_end,revision_no,submitted_at,submitted_by,hr_roster_plan_locations(location_id),hr_roster_entries(worker_type,worker_id)")
    .eq("company_id", authorization.companyId)
    .in("id", planIds)
    .eq("status", "pending_approval");
  if (plans.error) throw new Error(plans.error.message);
  const scopedPlans = (plans.data ?? []).filter((plan) => rosterPlanLocationIds(plan).every((id) => canUseRosterLocation(authorization, id)));
  const stationIds = [...new Set(scopedPlans.map((plan) => plan.location_id).filter(Boolean))];
  const submitterIds = [...new Set(scopedPlans.map((plan) => plan.submitted_by).filter(Boolean))];
  const [stations, submitters] = await Promise.all([
    stationIds.length ? db().from("stations").select("id,station_code,station_name").eq("company_id", authorization.companyId).in("id", stationIds) : Promise.resolve({ data: [], error: null }),
    submitterIds.length ? db().from("profiles").select("id,full_name").eq("company_id", authorization.companyId).in("id", submitterIds) : Promise.resolve({ data: [], error: null })
  ]);
  if (stations.error || submitters.error) throw new Error(stations.error?.message ?? submitters.error?.message ?? "Roster approvals could not be loaded.");
  const planById = new Map(scopedPlans.map((plan) => [plan.id, plan]));
  const stationById = new Map((stations.data ?? []).map((station) => [station.id, station]));
  const submitterById = new Map((submitters.data ?? []).map((profile) => [profile.id, profile.full_name]));
  return steps.flatMap((step) => {
    const plan = planById.get(step.plan_id);
    if (!plan) return [];
    const station = stationById.get(plan.location_id);
    const people = new Set((plan.hr_roster_entries ?? []).map((entry) => `${entry.worker_type}:${entry.worker_id}`));
    return [{
      stepId: step.id,
      planId: plan.id,
      stationCode: station?.station_code ?? "Station",
      stationName: station?.station_name ?? "",
      periodStart: plan.period_start,
      periodEnd: plan.period_end,
      revisionNo: Number(plan.revision_no ?? 1),
      stageNo: Number(step.stage_no),
      stageType: step.stage_type as StageType,
      submittedAt: plan.submitted_at,
      submittedBy: submitterById.get(plan.submitted_by) ?? "Roster planner",
      peopleCount: people.size,
      assignmentCount: (plan.hr_roster_entries ?? []).length
    }];
  });
}
