import type { SupabaseClient } from "@supabase/supabase-js";

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

type SearchScope = "reporting_chain" | "same_location" | "same_cluster" | "same_region";
type FallbackMode = "target_reporting_manager" | "next_reporting_manager" | "same_designation_location" | "same_designation_cluster" | "same_designation_region" | "specific_person" | "block";
type Route = {
  id: string;
  route_name: string;
  workflow_code: string | null;
  requester_person_id: string | null;
  location_id: string | null;
  level_1_designation_id: string;
  level_1_search_scope: SearchScope;
  level_1_fallback_mode: FallbackMode;
  level_1_fallback_person_id: string | null;
  level_2_required: boolean;
  level_2_designation_id: string | null;
  level_2_search_scope: SearchScope;
  level_2_fallback_mode: FallbackMode;
  level_2_fallback_person_id: string | null;
  hr_final_required: boolean;
  hr_final_designation_id: string | null;
  hr_final_search_scope: SearchScope;
  hr_final_fallback_mode: FallbackMode;
  hr_final_fallback_person_id: string | null;
  priority: number;
};
type Candidate = {
  assignmentId: string;
  personId: string;
  designationId: string | null;
  locationId: string | null;
  positionTitle: string;
  workerType: "employee" | "contractor";
  employeeId: string | null;
  contractorId: string | null;
  chainIndex: number;
};

function indiaToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function routeSpecificity(route: Route, workflowCode: string, locationId: string | null, requesterPersonId: string) {
  return Number(route.requester_person_id === requesterPersonId) * 4
    + Number(route.workflow_code === workflowCode) * 2
    + Number(Boolean(locationId && route.location_id === locationId));
}

class ConfiguredApprovalRouter {
  constructor(private readonly db: SupabaseClient) {}

  private async activeWorker(companyId: string, workerType: "employee" | "contractor", workerId: string, asOf: string) {
    const workerColumn = workerType === "employee" ? "employee_id" : "contractor_id";
    const engagement = await this.db.from("hr_engagements").select("id,person_id,worker_type,employee_id,contractor_id,status")
      .eq("company_id", companyId).eq("worker_type", workerType).eq(workerColumn, workerId).eq("status", "active")
      .order("start_date", { ascending: false }).limit(1).maybeSingle();
    if (engagement.error || !engagement.data) throw new Error(engagement.error?.message ?? "The requester does not have an active People engagement.");
    const assignment = await this.db.from("hr_work_assignments").select("id,engagement_id,designation_id,location_id,position_title,is_top_level,effective_from,effective_to")
      .eq("company_id", companyId).eq("engagement_id", engagement.data.id).eq("is_primary", true)
      .lte("effective_from", asOf).or(`effective_to.is.null,effective_to.gte.${asOf}`)
      .order("effective_from", { ascending: false }).limit(1).maybeSingle();
    if (assignment.error || !assignment.data) throw new Error(assignment.error?.message ?? "The requester does not have an active People assignment.");
    return { engagement: engagement.data, assignment: assignment.data };
  }

  private async matchingRoute(companyId: string, workflowCode: string, requesterDesignationId: string | null, requesterPersonId: string, locationId: string | null) {
    if (!requesterDesignationId) return null;
    const result = await this.db.from("hr_approval_workflow_routes")
      .select("id,route_name,workflow_code,requester_person_id,location_id,level_1_designation_id,level_1_search_scope,level_1_fallback_mode,level_1_fallback_person_id,level_2_required,level_2_designation_id,level_2_search_scope,level_2_fallback_mode,level_2_fallback_person_id,hr_final_required,hr_final_designation_id,hr_final_search_scope,hr_final_fallback_mode,hr_final_fallback_person_id,priority")
      .eq("company_id", companyId).eq("requester_designation_id", requesterDesignationId).eq("is_active", true);
    if (result.error) {
      if (/does not exist|schema cache/i.test(result.error.message)) return null;
      throw new Error(result.error.message);
    }
    return ((result.data ?? []) as Route[])
      .filter((route) => (route.workflow_code === null || route.workflow_code === workflowCode)
        && (route.location_id === null || route.location_id === locationId)
        && (!route.requester_person_id || route.requester_person_id === requesterPersonId))
      .sort((left, right) => routeSpecificity(right, workflowCode, locationId, requesterPersonId)
        - routeSpecificity(left, workflowCode, locationId, requesterPersonId)
        || left.priority - right.priority
        || left.id.localeCompare(right.id))[0] ?? null;
  }

  private async candidateFromAssignment(companyId: string, assignment: { id: string; engagement_id: string; designation_id: string | null; location_id: string | null; position_title: string }, chainIndex: number): Promise<Candidate | null> {
    const engagement = await this.db.from("hr_engagements").select("person_id,worker_type,employee_id,contractor_id,status")
      .eq("company_id", companyId).eq("id", assignment.engagement_id).maybeSingle();
    if (engagement.error) throw new Error(engagement.error.message);
    if (!engagement.data || engagement.data.status !== "active") return null;
    return {
      assignmentId: assignment.id,
      personId: engagement.data.person_id,
      designationId: assignment.designation_id,
      locationId: assignment.location_id,
      positionTitle: assignment.position_title,
      workerType: engagement.data.worker_type as "employee" | "contractor",
      employeeId: engagement.data.employee_id,
      contractorId: engagement.data.contractor_id,
      chainIndex
    };
  }

  private async reportingChain(companyId: string, subjectAssignmentId: string, asOf: string) {
    const chain: Candidate[] = [];
    const seen = new Set([subjectAssignmentId]);
    let current = subjectAssignmentId;
    for (let index = 0; index < 16; index += 1) {
      const relationship = await this.db.from("hr_reporting_relationships").select("manager_assignment_id")
        .eq("company_id", companyId).eq("subject_assignment_id", current).eq("relationship_type", "solid_line").eq("is_primary", true)
        .lte("effective_from", asOf).or(`effective_to.is.null,effective_to.gte.${asOf}`)
        .order("effective_from", { ascending: false }).limit(1).maybeSingle();
      if (relationship.error) throw new Error(relationship.error.message);
      if (!relationship.data || seen.has(relationship.data.manager_assignment_id)) break;
      seen.add(relationship.data.manager_assignment_id);
      const assignment = await this.db.from("hr_work_assignments").select("id,engagement_id,designation_id,location_id,position_title")
        .eq("company_id", companyId).eq("id", relationship.data.manager_assignment_id).maybeSingle();
      if (assignment.error) throw new Error(assignment.error.message);
      if (!assignment.data) break;
      current = assignment.data.id;
      const candidate = await this.candidateFromAssignment(companyId, assignment.data, index);
      if (candidate) chain.push(candidate);
    }
    return chain;
  }

  private async approvalUsers(companyId: string, requesterLocationId: string | null, asOf: string) {
    const page = await this.db.from("hr_permission_pages").select("id")
      .eq("company_id", companyId).eq("code", "approvals").eq("is_active", true).maybeSingle();
    if (page.error) throw new Error(page.error.message);
    if (!page.data) return new Set<string>();
    const permissions = await this.db.from("hr_role_page_permissions").select("role_id")
      .eq("company_id", companyId).eq("page_id", page.data.id).eq("can_approve", true);
    if (permissions.error) throw new Error(permissions.error.message);
    const roleIds = [...new Set((permissions.data ?? []).map((row) => row.role_id))];
    if (!roleIds.length) return new Set<string>();
    const [grants, legacy] = await Promise.all([
      this.db.from("hr_access_grants").select("user_id,scope_type,scope_id")
        .eq("company_id", companyId).eq("is_active", true).in("role_id", roleIds)
        .lte("effective_from", asOf).or(`effective_to.is.null,effective_to.gte.${asOf}`),
      this.db.from("hr_user_access").select("user_id,all_locations,location_ids")
        .eq("company_id", companyId).eq("is_active", true).in("role_id", roleIds)
    ]);
    const missingGrantTable = /does not exist|schema cache/i.test(grants.error?.message ?? "");
    if (grants.error && !missingGrantTable) throw new Error(grants.error.message);
    if (legacy.error && missingGrantTable) throw new Error(legacy.error.message);
    const rows = missingGrantTable
      ? (legacy.data ?? []).flatMap((access) => access.all_locations
        ? [{ user_id: access.user_id, scope_type: "company", scope_id: null }]
        : (access.location_ids ?? []).map((locationId: string) => ({ user_id: access.user_id, scope_type: "location", scope_id: locationId })))
      : grants.data ?? [];
    const scopedUsers = new Set(rows.filter((row) => row.scope_type === "company"
      || row.scope_type === "direct_reports"
      || row.scope_type === "reporting_subtree"
      || (row.scope_type === "location" && row.scope_id === requesterLocationId)).map((row) => row.user_id));
    if (!scopedUsers.size) return scopedUsers;
    const profiles = await this.db.from("profiles").select("id").eq("company_id", companyId).eq("is_active", true).in("id", [...scopedUsers]);
    if (profiles.error) throw new Error(profiles.error.message);
    return new Set((profiles.data ?? []).map((profile) => profile.id));
  }

  private async unavailable(companyId: string, candidate: Candidate, asOf: string, permittedUsers: Set<string>) {
    const [person, link] = await Promise.all([
      this.db.from("hr_people").select("display_name,status").eq("company_id", companyId).eq("id", candidate.personId).maybeSingle(),
      this.db.from("hr_user_person_links").select("user_id,status").eq("company_id", companyId).eq("person_id", candidate.personId).maybeSingle()
    ]);
    if (person.error || link.error) throw new Error(person.error?.message ?? link.error?.message);
    if (!person.data || person.data.status !== "active" || !link.data || link.data.status !== "active") {
      return { unavailable: true, reason: "inactive or unlinked account", person: person.data, link: link.data };
    }
    if (!permittedUsers.has(link.data.user_id)) {
      return { unavailable: true, reason: "approval access is not enabled", person: person.data, link: link.data };
    }
    let leave = this.db.from("hr_leave_requests").select("id").eq("company_id", companyId).eq("status", "approved")
      .lte("start_date", asOf).gte("end_date", asOf).limit(1);
    leave = candidate.workerType === "employee" ? leave.eq("employee_id", candidate.employeeId) : leave.eq("contractor_id", candidate.contractorId);
    const leaveResult = await leave.maybeSingle();
    if (leaveResult.error) throw new Error(leaveResult.error.message);
    return { unavailable: Boolean(leaveResult.data), reason: leaveResult.data ? "approved leave" : null, person: person.data, link: link.data };
  }

  private async activePersonCandidate(companyId: string, personId: string, asOf: string, chainIndex = -1) {
    const engagement = await this.db.from("hr_engagements").select("id").eq("company_id", companyId).eq("person_id", personId).eq("status", "active")
      .order("start_date", { ascending: false }).limit(1).maybeSingle();
    if (engagement.error) throw new Error(engagement.error.message);
    if (!engagement.data) return null;
    const assignment = await this.db.from("hr_work_assignments").select("id,engagement_id,designation_id,location_id,position_title")
      .eq("company_id", companyId).eq("engagement_id", engagement.data.id).eq("is_primary", true)
      .lte("effective_from", asOf).or(`effective_to.is.null,effective_to.gte.${asOf}`)
      .order("effective_from", { ascending: false }).limit(1).maybeSingle();
    if (assignment.error) throw new Error(assignment.error.message);
    return assignment.data ? this.candidateFromAssignment(companyId, assignment.data, chainIndex) : null;
  }

  private async delegatedCandidate(companyId: string, workflowCode: string, original: Candidate, asOf: string) {
    const result = await this.db.from("hr_approval_delegations").select("delegate_person_id,workflow_code,effective_from")
      .eq("company_id", companyId).eq("approver_person_id", original.personId).eq("is_active", true)
      .lte("effective_from", asOf).gte("effective_to", asOf);
    if (result.error) {
      if (/does not exist|schema cache/i.test(result.error.message)) return null;
      throw new Error(result.error.message);
    }
    const delegation = (result.data ?? []).filter((item) => !item.workflow_code || item.workflow_code === workflowCode)
      .sort((left, right) => Number(Boolean(right.workflow_code)) - Number(Boolean(left.workflow_code)) || right.effective_from.localeCompare(left.effective_from))[0];
    return delegation ? this.activePersonCandidate(companyId, delegation.delegate_person_id, asOf, original.chainIndex) : null;
  }

  private async scopedCandidates(companyId: string, designationId: string, scope: SearchScope, requesterLocationId: string | null, asOf: string) {
    const result = await this.db.from("hr_work_assignments").select("id,engagement_id,designation_id,location_id,position_title")
      .eq("company_id", companyId).eq("designation_id", designationId).eq("is_primary", true)
      .lte("effective_from", asOf).or(`effective_to.is.null,effective_to.gte.${asOf}`).limit(500);
    if (result.error) throw new Error(result.error.message);
    let allowedLocations: Set<string> | null = null;
    if (scope !== "reporting_chain") {
      if (!requesterLocationId) return [];
      if (scope === "same_location") allowedLocations = new Set([requesterLocationId]);
      else {
        const station = await this.db.from("stations").select("region,cluster,cluster_name").eq("company_id", companyId).eq("id", requesterLocationId).maybeSingle();
        if (station.error || !station.data) return [];
        const stations = await this.db.from("stations").select("id,region,cluster,cluster_name").eq("company_id", companyId).eq("is_active", true);
        if (stations.error) throw new Error(stations.error.message);
        const cluster = station.data.cluster || station.data.cluster_name;
        allowedLocations = new Set((stations.data ?? []).filter((item) => scope === "same_region"
          ? Boolean(station.data?.region && item.region === station.data.region)
          : Boolean(cluster && (item.cluster || item.cluster_name) === cluster)).map((item) => item.id));
      }
    }
    const candidates = await Promise.all((result.data ?? [])
      .filter((assignment) => !allowedLocations || Boolean(assignment.location_id && allowedLocations.has(assignment.location_id)))
      .map((assignment) => this.candidateFromAssignment(companyId, assignment, -1)));
    return candidates.filter((candidate): candidate is Candidate => Boolean(candidate));
  }

  private async stepFor(companyId: string, routeId: string, level: number, candidate: Candidate, via: ConfiguredApprovalStep["resolved_via"], originalPersonId: string | null, reason: string | null, asOf: string, permittedUsers: Set<string>) {
    const state = await this.unavailable(companyId, candidate, asOf, permittedUsers);
    if (state.unavailable || !state.link || !state.person) return null;
    return {
      step_name: `${candidate.positionTitle || `Level ${level}`} approval`,
      approver_user_id: state.link.user_id,
      approver_person_id: candidate.personId,
      approver_name: state.person.display_name,
      route_id: routeId,
      resolved_via: via,
      original_approver_person_id: originalPersonId,
      fallback_reason: reason
    } satisfies ConfiguredApprovalStep;
  }

  private async firstAvailable(candidates: Candidate[], companyId: string, routeId: string, level: number, excluded: Set<string>, via: ConfiguredApprovalStep["resolved_via"], originalPersonId: string | null, reason: string | null, asOf: string, permittedUsers: Set<string>) {
    for (const candidate of candidates) {
      if (excluded.has(candidate.personId)) continue;
      const step = await this.stepFor(companyId, routeId, level, candidate, via, originalPersonId, reason, asOf, permittedUsers);
      if (step) return { candidate, step };
    }
    return null;
  }

  async resolve(input: { companyId: string; workflowCode: string; workerType: "employee" | "contractor"; workerId: string; asOf?: string }) {
    const asOf = input.asOf ?? indiaToday();
    const worker = await this.activeWorker(input.companyId, input.workerType, input.workerId, asOf);
    const route = await this.matchingRoute(input.companyId, input.workflowCode, worker.assignment.designation_id, worker.engagement.person_id, worker.assignment.location_id);
    if (!route) return null;
    const [chain, permittedUsers] = await Promise.all([
      this.reportingChain(input.companyId, worker.assignment.id, asOf),
      this.approvalUsers(input.companyId, worker.assignment.location_id, asOf)
    ]);
    const excluded = new Set<string>([worker.engagement.person_id]);
    const steps: ConfiguredApprovalStep[] = [];
    let lastChainIndex = -1;
    for (const level of [1, 2, 3] as const) {
      if (level === 2 && !route.level_2_required) continue;
      if (level === 3 && !route.hr_final_required) continue;
      const designationId = level === 1 ? route.level_1_designation_id : level === 2 ? route.level_2_designation_id : route.hr_final_designation_id;
      if (!designationId) throw new Error(`${level === 3 ? "HR final" : `Level ${level}`} approver role is missing. Update the People Approval Workflow Master.`);
      const searchScope = level === 1 ? route.level_1_search_scope : level === 2 ? route.level_2_search_scope : route.hr_final_search_scope;
      const fallbackMode = level === 1 ? route.level_1_fallback_mode : level === 2 ? route.level_2_fallback_mode : route.hr_final_fallback_mode;
      const fallbackPersonId = level === 1 ? route.level_1_fallback_person_id : level === 2 ? route.level_2_fallback_person_id : route.hr_final_fallback_person_id;
      const primary = searchScope === "reporting_chain"
        ? chain.filter((candidate) => candidate.chainIndex > lastChainIndex && candidate.designationId === designationId)
        : await this.scopedCandidates(input.companyId, designationId, searchScope, worker.assignment.location_id, asOf);
      const original = primary.find((candidate) => !excluded.has(candidate.personId)) ?? null;
      let resolved = await this.firstAvailable(primary, input.companyId, route.id, level, excluded, "configured_designation", null, null, asOf, permittedUsers);
      if (original) {
        const delegated = await this.delegatedCandidate(input.companyId, input.workflowCode, original, asOf);
        if (delegated && !excluded.has(delegated.personId)) {
          const step = await this.stepFor(input.companyId, route.id, level, delegated, "delegation", original.personId, "Temporary approval cover", asOf, permittedUsers);
          if (step) resolved = { candidate: delegated, step };
        }
      }
      if (!resolved && fallbackMode !== "block") {
        let fallback: Candidate[] = [];
        if (fallbackMode === "specific_person" && fallbackPersonId) {
          const candidate = await this.activePersonCandidate(input.companyId, fallbackPersonId, asOf);
          if (candidate) fallback = [candidate];
        } else if (fallbackMode === "target_reporting_manager" || fallbackMode === "next_reporting_manager") {
          const after = original?.chainIndex ?? lastChainIndex;
          fallback = chain.filter((candidate) => candidate.chainIndex > after);
        } else {
          fallback = await this.scopedCandidates(input.companyId, designationId, fallbackMode.replace("same_designation_", "same_") as SearchScope, worker.assignment.location_id, asOf);
        }
        resolved = await this.firstAvailable(fallback, input.companyId, route.id, level, excluded, "fallback", original?.personId ?? null, original ? "Configured approver unavailable" : "Configured role not found", asOf, permittedUsers);
      }
      if (!resolved) throw new Error(`${level === 3 ? "HR final" : `Level ${level}`} approval cannot be assigned. Check the People route, reporting tree, leave cover and DropX One approval access.`);
      if (level === 3) resolved.step.step_name = "HR final approval";
      steps.push(resolved.step);
      excluded.add(resolved.candidate.personId);
      if (resolved.candidate.chainIndex >= 0) lastChainIndex = Math.max(lastChainIndex, resolved.candidate.chainIndex);
    }
    return { routeName: route.route_name, steps };
  }
}

export async function resolveConfiguredApprovalWorkflow(
  client: SupabaseClient,
  input: { companyId: string; workflowCode: string; workerType: "employee" | "contractor"; workerId: string; asOf?: string }
) {
  return new ConfiguredApprovalRouter(client).resolve(input);
}
