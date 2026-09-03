import "server-only";

import { selectApprovalRoute } from "@/lib/approval-workflow-routing-core";
import { isTeamLeadDesignation } from "@/lib/approval-designation-labels";
import { resolveConnectApproverUserId } from "@/lib/connect-approver-identity";
import { loadPeopleOperationalHierarchy } from "@/lib/people-operational-hierarchy";
import { supabaseAdmin } from "@/lib/supabase-admin";

export type ConfiguredApprovalStep = {
  step_name: string;
  approver_user_id: string;
  approver_person_id: string;
  approver_name: string;
  route_id: string;
  resolved_via: "configured_designation" | "delegation" | "fallback";
  original_approver_person_id: string | null;
  fallback_reason: string | null;
};

type Route = {
  id: string; route_name: string; workflow_code: string | null; location_id: string | null; requester_person_id: string | null;
  level_1_designation_id: string; level_1_search_scope: SearchScope; level_1_fallback_mode: FallbackMode; level_1_fallback_person_id: string | null;
  level_2_required: boolean; level_2_designation_id: string | null; level_2_search_scope: SearchScope; level_2_fallback_mode: FallbackMode; level_2_fallback_person_id: string | null;
  hr_final_required: boolean; hr_final_designation_id: string | null; hr_final_search_scope: SearchScope; hr_final_fallback_mode: FallbackMode; hr_final_fallback_person_id: string | null;
  priority: number;
};
type SearchScope = "reporting_chain" | "immediate_reporting_manager" | "manager_above_team_lead" | "same_location" | "same_cluster" | "same_region";
type FallbackMode = "target_reporting_manager" | "next_reporting_manager" | "same_designation_location" | "same_designation_cluster" | "same_designation_region" | "specific_person" | "block";
type Candidate = {
  assignmentId: string; engagementId: string; personId: string; designationId: string | null;
  locationId: string | null; positionTitle: string; workerType: "employee" | "contractor";
  employeeId: string | null; contractorId: string | null; chainIndex: number;
};

function db() {
  if (!supabaseAdmin) throw new Error("Database configuration is missing.");
  return supabaseAdmin;
}

function indiaToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

async function activeWorkerAssignment(companyId: string, workerType: "employee" | "contractor", workerId: string, asOf: string) {
  const workerColumn = workerType === "employee" ? "employee_id" : "contractor_id";
  const engagement = await db().from("hr_engagements").select("id,person_id,worker_type,employee_id,contractor_id,status")
    .eq("company_id", companyId).eq("worker_type", workerType).eq(workerColumn, workerId).eq("status", "active")
    .order("start_date", { ascending: false }).limit(1).maybeSingle();
  if (engagement.error || !engagement.data) throw new Error(engagement.error?.message ?? "The requester does not have an active People engagement.");
  const assignment = await db().from("hr_work_assignments").select("id,engagement_id,designation_id,location_id,position_title,effective_from,effective_to")
    .eq("company_id", companyId).eq("engagement_id", engagement.data.id).eq("is_primary", true)
    .lte("effective_from", asOf).or(`effective_to.is.null,effective_to.gte.${asOf}`)
    .order("effective_from", { ascending: false }).limit(1).maybeSingle();
  if (assignment.error || !assignment.data) throw new Error(assignment.error?.message ?? "The requester does not have an active People assignment.");
  return { engagement: engagement.data, assignment: assignment.data };
}

async function matchingRoute(companyId: string, workflowCode: string, requesterDesignationId: string | null, requesterPersonId: string, locationId: string | null): Promise<Route | null> {
  if (!requesterDesignationId) return null;
  const result = await db().from("hr_approval_workflow_routes").select("id,route_name,workflow_code,requester_person_id,location_id,level_1_designation_id,level_1_search_scope,level_1_fallback_mode,level_1_fallback_person_id,level_2_required,level_2_designation_id,level_2_search_scope,level_2_fallback_mode,level_2_fallback_person_id,hr_final_required,hr_final_designation_id,hr_final_search_scope,hr_final_fallback_mode,hr_final_fallback_person_id,priority")
    .eq("company_id", companyId).eq("requester_designation_id", requesterDesignationId).eq("is_active", true);
  if (result.error) {
    if (/does not exist|schema cache/i.test(result.error.message)) return null;
    throw new Error(result.error.message);
  }
  return selectApprovalRoute((result.data ?? []) as Route[], workflowCode, locationId, requesterPersonId);
}

async function candidateFromAssignment(companyId: string, assignment: { id: string; engagement_id: string; designation_id: string | null; location_id: string | null; position_title: string }, chainIndex: number): Promise<Candidate | null> {
  const engagement = await db().from("hr_engagements").select("id,person_id,worker_type,employee_id,contractor_id,status")
    .eq("company_id", companyId).eq("id", assignment.engagement_id).maybeSingle();
  if (engagement.error) throw new Error(engagement.error.message);
  if (!engagement.data) return null;
  return {
    assignmentId: assignment.id, engagementId: engagement.data.id, personId: engagement.data.person_id,
    designationId: assignment.designation_id, locationId: assignment.location_id, positionTitle: assignment.position_title,
    workerType: engagement.data.worker_type as "employee" | "contractor", employeeId: engagement.data.employee_id,
    contractorId: engagement.data.contractor_id, chainIndex
  };
}

async function designationLabels(companyId: string, designationIds: string[]) {
  const unique = [...new Set(designationIds.filter(Boolean))];
  if (!unique.length) return new Map<string, { name: string; code: string | null }>();
  const result = await db().from("designations").select("id,name,code").eq("company_id", companyId).in("id", unique);
  if (result.error) throw new Error(result.error.message);
  return new Map((result.data ?? []).map((item) => [item.id, { name: item.name, code: item.code }]));
}

function chainCandidates(
  chain: Candidate[],
  searchScope: SearchScope,
  designationId: string,
  lastChainIndex: number,
  designationById: Map<string, { name: string; code: string | null }>
) {
  return chain.filter((item) => {
    if (item.chainIndex <= lastChainIndex) return false;
    const label = item.designationId ? designationById.get(item.designationId) : null;
    if (searchScope === "immediate_reporting_manager") return item.chainIndex === 0;
    if (searchScope === "manager_above_team_lead") {
      if (isTeamLeadDesignation(label)) return false;
      return item.designationId === designationId;
    }
    if (searchScope === "reporting_chain") return item.designationId === designationId;
    return false;
  });
}

async function reportingChain(companyId: string, subjectAssignmentId: string, asOf: string): Promise<Candidate[]> {
  const chain: Candidate[] = [];
  const seenAssignments = new Set([subjectAssignmentId]);
  let current = subjectAssignmentId;
  for (let index = 0; index < 16; index += 1) {
    const relationship = await db().from("hr_reporting_relationships").select("manager_assignment_id")
      .eq("company_id", companyId).eq("subject_assignment_id", current).eq("relationship_type", "solid_line").eq("is_primary", true)
      .lte("effective_from", asOf).or(`effective_to.is.null,effective_to.gte.${asOf}`).order("effective_from", { ascending: false }).limit(1).maybeSingle();
    if (relationship.error) throw new Error(relationship.error.message);
    if (!relationship.data || seenAssignments.has(relationship.data.manager_assignment_id)) break;
    seenAssignments.add(relationship.data.manager_assignment_id);
    const assignment = await db().from("hr_work_assignments").select("id,engagement_id,designation_id,location_id,position_title,effective_from,effective_to")
      .eq("company_id", companyId).eq("id", relationship.data.manager_assignment_id).maybeSingle();
    if (assignment.error) throw new Error(assignment.error.message);
    if (!assignment.data) break;
    current = assignment.data.id;
    const candidate = await candidateFromAssignment(companyId, assignment.data, index);
    if (candidate) chain.push(candidate);
  }
  return chain;
}

async function candidateIsUnavailable(companyId: string, candidate: Candidate, asOf: string) {
  const person = await db().from("hr_people").select("display_name,status").eq("company_id", companyId).eq("id", candidate.personId).maybeSingle();
  if (person.error) throw new Error(person.error.message);
  if (!person.data || person.data.status !== "active") {
    return { unavailable: true, reason: "inactive person record", person: person.data, approverUserId: null as string | null };
  }
  const approverUserId = await resolveConnectApproverUserId(companyId, candidate.personId);
  if (!approverUserId) {
    return { unavailable: true, reason: "no DropX One manager login", person: person.data, approverUserId: null as string | null };
  }
  let leaveQuery = db().from("hr_leave_requests").select("id").eq("company_id", companyId).eq("status", "approved").lte("start_date", asOf).gte("end_date", asOf).limit(1);
  leaveQuery = candidate.workerType === "employee" ? leaveQuery.eq("employee_id", candidate.employeeId) : leaveQuery.eq("contractor_id", candidate.contractorId);
  const leave = await leaveQuery.maybeSingle();
  if (leave.error) throw new Error(leave.error.message);
  return {
    unavailable: Boolean(leave.data),
    reason: leave.data ? "approved leave" : null,
    person: person.data,
    approverUserId
  };
}

async function activePersonCandidate(companyId: string, personId: string, asOf: string, chainIndex = -1): Promise<Candidate | null> {
  const engagement = await db().from("hr_engagements").select("id,person_id,worker_type,employee_id,contractor_id,status")
    .eq("company_id", companyId).eq("person_id", personId).eq("status", "active").order("start_date", { ascending: false }).limit(1).maybeSingle();
  if (engagement.error) throw new Error(engagement.error.message);
  if (!engagement.data) return null;
  const assignment = await db().from("hr_work_assignments").select("id,engagement_id,designation_id,location_id,position_title,effective_from,effective_to")
    .eq("company_id", companyId).eq("engagement_id", engagement.data.id).eq("is_primary", true)
    .lte("effective_from", asOf).or(`effective_to.is.null,effective_to.gte.${asOf}`).order("effective_from", { ascending: false }).limit(1).maybeSingle();
  if (assignment.error) throw new Error(assignment.error.message);
  return assignment.data ? candidateFromAssignment(companyId, assignment.data, chainIndex) : null;
}

async function delegatedCandidate(companyId: string, workflowCode: string, original: Candidate, asOf: string) {
  const result = await db().from("hr_approval_delegations").select("delegate_person_id,workflow_code,effective_from")
    .eq("company_id", companyId).eq("approver_person_id", original.personId).eq("is_active", true)
    .lte("effective_from", asOf).gte("effective_to", asOf);
  if (result.error) {
    if (/does not exist|schema cache/i.test(result.error.message)) return null;
    throw new Error(result.error.message);
  }
  const delegation = (result.data ?? []).filter((item) => !item.workflow_code || item.workflow_code === workflowCode)
    .sort((left, right) => Number(Boolean(right.workflow_code)) - Number(Boolean(left.workflow_code)) || right.effective_from.localeCompare(left.effective_from))[0];
  if (!delegation) return null;
  return activePersonCandidate(companyId, delegation.delegate_person_id, asOf, original.chainIndex);
}

async function scopedDesignationCandidates(companyId: string, designationId: string, scope: SearchScope, requesterLocationId: string | null, asOf: string) {
  const result = await db().from("hr_work_assignments").select("id,engagement_id,designation_id,location_id,position_title,effective_from,effective_to")
    .eq("company_id", companyId).eq("designation_id", designationId).eq("is_primary", true)
    .lte("effective_from", asOf).or(`effective_to.is.null,effective_to.gte.${asOf}`).limit(500);
  if (result.error) throw new Error(result.error.message);
  let allowedLocations: Set<string> | null = null;
  if (scope !== "reporting_chain" && scope !== "immediate_reporting_manager" && scope !== "manager_above_team_lead") {
    if (!requesterLocationId) return [];
    if (scope === "same_location") allowedLocations = new Set([requesterLocationId]);
    else {
      const requesterStation = await db().from("stations").select("region").eq("company_id", companyId).eq("id", requesterLocationId).maybeSingle();
      if (requesterStation.error || !requesterStation.data) return [];
      const stationResult = await db().from("stations").select("id,region").eq("company_id", companyId).eq("is_active", true);
      if (stationResult.error) throw new Error(stationResult.error.message);
      if (scope === "same_region") {
        allowedLocations = new Set((stationResult.data ?? []).filter((station) => (
          Boolean(requesterStation.data?.region && station.region === requesterStation.data.region)
        )).map((station) => station.id));
      } else {
        const stationIds = (stationResult.data ?? []).map((station) => station.id);
        const hierarchy = await loadPeopleOperationalHierarchy(companyId, stationIds);
        if (hierarchy.error) throw new Error(hierarchy.error);
        const requesterManagers = new Set((hierarchy.byLocation.get(requesterLocationId)?.clusterManagers ?? []).map((person) => person.personId));
        allowedLocations = new Set(stationIds.filter((stationId) => (
          (hierarchy.byLocation.get(stationId)?.clusterManagers ?? []).some((person) => requesterManagers.has(person.personId))
        )));
      }
    }
  }
  const assignments = (result.data ?? []).filter((assignment) => !allowedLocations || Boolean(assignment.location_id && allowedLocations.has(assignment.location_id)));
  const candidates = await Promise.all(assignments.map((assignment) => candidateFromAssignment(companyId, assignment, -1)));
  return candidates.filter((item): item is Candidate => Boolean(item));
}

async function stepForCandidate(companyId: string, routeId: string, level: number, candidate: Candidate, via: ConfiguredApprovalStep["resolved_via"], originalPersonId: string | null, fallbackReason: string | null, asOf: string) {
  const state = await candidateIsUnavailable(companyId, candidate, asOf);
  if (state.unavailable || !state.approverUserId || !state.person) return null;
  return {
    step_name: `${candidate.positionTitle || `Level ${level}`} approval`, approver_user_id: state.approverUserId,
    approver_person_id: candidate.personId, approver_name: state.person.display_name,
    route_id: routeId, resolved_via: via, original_approver_person_id: originalPersonId, fallback_reason: fallbackReason
  } satisfies ConfiguredApprovalStep;
}

async function findAvailable(candidates: Candidate[], companyId: string, routeId: string, level: number, excludedPeople: Set<string>, via: ConfiguredApprovalStep["resolved_via"], originalPersonId: string | null, fallbackReason: string | null, asOf: string) {
  for (const candidate of candidates) {
    if (excludedPeople.has(candidate.personId)) continue;
    const step = await stepForCandidate(companyId, routeId, level, candidate, via, originalPersonId, fallbackReason, asOf);
    if (step) return { candidate, step };
  }
  return null;
}

export async function resolveConfiguredApprovalWorkflow(input: {
  companyId: string; workflowCode: string; workerType: "employee" | "contractor"; workerId: string; asOf?: string;
  maxLevel?: 1 | 2 | 3;
}): Promise<{ routeName: string; steps: ConfiguredApprovalStep[]; routeId: string } | null> {
  const asOf = input.asOf ?? indiaToday();
  const worker = await activeWorkerAssignment(input.companyId, input.workerType, input.workerId, asOf);
  const route = await matchingRoute(input.companyId, input.workflowCode, worker.assignment.designation_id, worker.engagement.person_id, worker.assignment.location_id);
  if (!route) return null;
  const maxLevel = input.maxLevel ?? 3;
  const chain = await reportingChain(input.companyId, worker.assignment.id, asOf);
  const designationById = await designationLabels(input.companyId, chain.map((item) => item.designationId ?? "").filter(Boolean));
  const excludedPeople = new Set<string>([worker.engagement.person_id]);
  const steps: ConfiguredApprovalStep[] = [];
  let lastChainIndex = -1;
  for (const level of [1, 2, 3] as const) {
    if (level > maxLevel) continue;
    if (level === 2 && !route.level_2_required) continue;
    if (level === 3 && !route.hr_final_required) continue;
    const designationId = level === 1 ? route.level_1_designation_id : level === 2 ? route.level_2_designation_id : route.hr_final_designation_id;
    if (!designationId) throw new Error(`${level === 3 ? "HR final" : `Level ${level}`} approver designation is missing. Contact HR.`);
    const searchScope = level === 1 ? route.level_1_search_scope : level === 2 ? route.level_2_search_scope : route.hr_final_search_scope;
    const fallbackMode = level === 1 ? route.level_1_fallback_mode : level === 2 ? route.level_2_fallback_mode : route.hr_final_fallback_mode;
    const fallbackPersonId = level === 1 ? route.level_1_fallback_person_id : level === 2 ? route.level_2_fallback_person_id : route.hr_final_fallback_person_id;
    const primaryCandidates = ["reporting_chain", "immediate_reporting_manager", "manager_above_team_lead"].includes(searchScope)
      ? chainCandidates(chain, searchScope, designationId, lastChainIndex, designationById)
      : await scopedDesignationCandidates(input.companyId, designationId, searchScope, worker.assignment.location_id, asOf);
    let resolved = await findAvailable(primaryCandidates, input.companyId, route.id, level, excludedPeople, "configured_designation", null, null, asOf);
    const original = primaryCandidates.find((item) => !excludedPeople.has(item.personId)) ?? null;
    if (original) {
      const delegated = await delegatedCandidate(input.companyId, input.workflowCode, original, asOf);
      if (delegated && !excludedPeople.has(delegated.personId)) {
        const delegationStep = await stepForCandidate(input.companyId, route.id, level, delegated, "delegation", original.personId, "Temporary approval cover", asOf);
        if (delegationStep) resolved = { candidate: delegated, step: delegationStep };
      }
    }
    if (!resolved && fallbackMode !== "block") {
      let fallbackCandidates: Candidate[] = [];
      if (fallbackMode === "specific_person" && fallbackPersonId) {
        const candidate = await activePersonCandidate(input.companyId, fallbackPersonId, asOf);
        if (candidate) fallbackCandidates = [candidate];
      } else if (fallbackMode === "target_reporting_manager" || fallbackMode === "next_reporting_manager") {
        const after = original?.chainIndex ?? lastChainIndex;
        fallbackCandidates = chain.filter((item) => item.chainIndex > after);
      } else {
        const fallbackScope = fallbackMode.replace("same_designation_", "same_") as SearchScope;
        fallbackCandidates = await scopedDesignationCandidates(input.companyId, designationId, fallbackScope, worker.assignment.location_id, asOf);
      }
      resolved = await findAvailable(fallbackCandidates, input.companyId, route.id, level, excludedPeople, "fallback", original?.personId ?? null, original ? "Configured approver unavailable" : "Configured designation not found", asOf);
    }
    if (!resolved) throw new Error(`${level === 3 ? "HR final" : `Level ${level}`} approval is not available for this request. Contact HR.`);
    if (level === 3) resolved.step.step_name = "HR final approval";
    steps.push(resolved.step);
    excludedPeople.add(resolved.candidate.personId);
    if (resolved.candidate.chainIndex >= 0) lastChainIndex = Math.max(lastChainIndex, resolved.candidate.chainIndex);
  }
  return { routeName: route.route_name, steps, routeId: route.id };
}
