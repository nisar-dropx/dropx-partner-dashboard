import { supabaseAdmin } from "@/lib/supabase-admin";
import { findPositionApprover, loadEffectivePositionAccess, roleIdsWithPageEditAccess } from "@/lib/position-access";
import { paymentRoutingDay, resolvePaymentCover } from "@/lib/payment-delegation-policy";
import { resolveInitialStage } from "@/lib/payment-stage-policy";

export type ApprovalStepCandidate = { role_id: string; scope: "station" | "cluster" | "company" };
export type ApprovalStepRow = {
  id: string;
  step_order: number;
  candidates: ApprovalStepCandidate[];
  is_required: boolean;
  has_local_candidates?: boolean;
};
export type ApproverTarget = { userId: string; roleId: string; routingReason?: string | null } | null;

/**
 * Loads the ordered step list for a payment head, filtering each step's
 * candidate roles down to ones that actually hold edit access on
 * payment_approvals - the same guard as the legacy flat-array routing, now
 * applied once per step instead of duplicated per call site.
 */
export async function loadApprovalSteps(companyId: string, paymentHeadId: string, requestId?: string): Promise<ApprovalStepRow[]> {
  if (!supabaseAdmin) return [];
  const result = await supabaseAdmin
    .from("payment_head_approval_steps")
    .select("id, step_order, candidates, is_required")
    .eq("company_id", companyId)
    .eq("payment_head_id", paymentHeadId)
    .order("step_order", { ascending: true });
  if (result.error) throw new Error(result.error.message);

  let rows = (result.data ?? []) as ApprovalStepRow[];
  if (requestId) {
    const request = await supabaseAdmin.from("payment_requests").select("adhoc_approval_steps").eq("company_id",companyId).eq("id",requestId).single();
    if(request.error) throw new Error(request.error.message);
    if(Array.isArray(request.data.adhoc_approval_steps)) rows = request.data.adhoc_approval_steps as ApprovalStepRow[];
  }
  const allRoleIds = Array.from(new Set(rows.flatMap((row) => row.candidates.map((candidate) => candidate.role_id))));
  const editableRoleIds = await roleIdsWithPageEditAccess(companyId, allRoleIds, "payment_approvals", true);

  return rows.map((row) => ({
    ...row,
    has_local_candidates: row.candidates.some(candidate => candidate.scope !== "company"),
    candidates: row.candidates.filter((candidate) => editableRoleIds.has(candidate.role_id))
  }));
}

async function stationCluster(companyId: string, locationId: string | null | undefined) {
  if (!supabaseAdmin || !locationId) return null;
  const result = await supabaseAdmin.from("stations").select("cluster").eq("company_id", companyId).eq("id", locationId).maybeSingle();
  return result.data?.cluster ?? null;
}

async function stationLocationModelId(companyId: string, locationId: string | null | undefined) {
  if (!supabaseAdmin || !locationId) return null;
  const result = await supabaseAdmin.from("stations").select("location_model_id").eq("company_id", companyId).eq("id", locationId).maybeSingle();
  return result.data?.location_model_id ?? null;
}

/**
 * The set of business-model ids (location_model_id) covered by a candidate's
 * own assigned stations - used as a defense-in-depth check alongside the
 * station/cluster scope match: a Regional Manager whose 7 stations are all
 * "NOW" model has no business being routed a "EDSP" model station's request
 * even if a data mistake ever put that station in their location_scope_ids.
 * has_all_location_access has no station list to derive a model set from, so
 * it is treated as covering every model (same all-locations meaning it already has).
 */
async function candidateModelIds(companyId: string, locationScopeIds: string[], hasAllLocationAccess: boolean): Promise<Set<string> | null> {
  if (hasAllLocationAccess || !supabaseAdmin) return null;
  if (!locationScopeIds.length) return new Set();
  const result = await supabaseAdmin.from("stations").select("location_model_id").eq("company_id", companyId).in("id", locationScopeIds);
  return new Set((result.data ?? []).map((row) => row.location_model_id).filter((id): id is string => Boolean(id)));
}

async function candidateUserIds(companyId: string, roleId: string, scope: "station" | "cluster" | "company", locationId: string | null | undefined): Promise<string[]> {
  if (!supabaseAdmin) return [];

  if (scope === "company") {
    const memberships = await supabaseAdmin
      .from("company_product_memberships")
      .select("user_id, has_all_location_access")
      .eq("company_id", companyId)
      .eq("role_id", roleId)
      .eq("is_active", true);
    if (memberships.error) throw new Error(memberships.error.message);
    if (memberships.data?.length) return memberships.data.map((row) => row.user_id);
    const profiles = await supabaseAdmin.from("profiles").select("id").eq("company_id", companyId).eq("role_id", roleId).eq("is_active", true);
    if (profiles.error) throw new Error(profiles.error.message);
    return (profiles.data ?? []).map((row) => row.id);
  }

  // station / cluster: narrow to people whose location scope actually covers
  // the requester's station (or, for cluster, any station sharing the same
  // stations.cluster label), and whose own stations include the requester's
  // station's business model (see candidateModelIds).
  const memberships = await supabaseAdmin
    .from("company_product_memberships")
    .select("user_id, has_all_location_access, location_scope_ids")
    .eq("company_id", companyId)
    .eq("role_id", roleId)
    .eq("is_active", true);
  if (memberships.error) throw new Error(memberships.error.message);
  const rows = memberships.data ?? [];
  if (!locationId) return [];

  const requestModelId = await stationLocationModelId(companyId, locationId);
  async function matchesModel(row: { has_all_location_access: boolean; location_scope_ids: string[] | null }) {
    if (!requestModelId) return true;
    const modelIds = await candidateModelIds(companyId, row.location_scope_ids ?? [], row.has_all_location_access);
    return modelIds === null || modelIds.has(requestModelId);
  }

  if (scope === "station") {
    const inStation = rows.filter((row) => row.has_all_location_access || (row.location_scope_ids ?? []).includes(locationId));
    const matched = await Promise.all(inStation.map(async (row) => (await matchesModel(row)) ? row.user_id : null));
    return matched.filter((id): id is string => Boolean(id));
  }

  // cluster scope: a candidate qualifies if the requester's station shares a
  // cluster label with any station in the candidate's location_scope_ids.
  const cluster = await stationCluster(companyId, locationId);
  if (!cluster) return [];
  const scopedStations = await supabaseAdmin.from("stations").select("id").eq("company_id", companyId).eq("cluster", cluster);
  if (scopedStations.error) throw new Error(scopedStations.error.message);
  const clusterStationIds = new Set((scopedStations.data ?? []).map((row) => row.id));
  const inCluster = rows.filter((row) => row.has_all_location_access || (row.location_scope_ids ?? []).some((id: string) => clusterStationIds.has(id)));
  const matchedCluster = await Promise.all(inCluster.map(async (row) => (await matchesModel(row)) ? row.user_id : null));
  return matchedCluster.filter((id): id is string => Boolean(id));
}

/** Validate substitute access against the same Operations role/location source as the inbox. */
async function delegateCanAct(companyId: string, userId: string, locationId: string | null | undefined) {
  if (!supabaseAdmin) return false;
  const [profile, memberships, position] = await Promise.all([
    supabaseAdmin.from("profiles").select("id,is_active,role_id,location_scope_ids").eq("company_id", companyId).eq("id",userId).maybeSingle(),
    supabaseAdmin.from("company_product_memberships").select("role_id,has_all_location_access,location_scope_ids").eq("company_id",companyId).eq("user_id",userId).eq("product_code","operations").eq("is_active",true),
    loadEffectivePositionAccess(companyId,userId)
  ]);
  if (profile.error || memberships.error) throw new Error("Could not verify approver access.");
  if (!profile.data?.is_active) return false;
  const members = memberships.data ?? [];
  const roleIds = members.length ? members.map(row => row.role_id).filter(Boolean) : [...new Set([profile.data.role_id,...position.roleIds].filter(Boolean))];
  if (!roleIds.length) return false;
  const roles = await supabaseAdmin.from("user_roles").select("id,code,location_access_mode").eq("company_id",companyId).eq("is_active",true).in("id",roleIds);
  if (roles.error) throw new Error("Could not verify approver roles.");
  const active = roles.data ?? [];
  const owner = active.some(row => row.code === "OWNER");
  const allLocations = owner || active.some(row => row.location_access_mode === "all_locations") || members.some(row => row.has_all_location_access);
  const locations = members.flatMap(row => row.location_scope_ids ?? []);
  if (!allLocations && (!locationId || !locations.includes(locationId))) return false;
  const editable = await roleIdsWithPageEditAccess(companyId,active.map(row => row.id),"payment_approvals",true);
  return owner || editable.size > 0;
}

async function redirectThroughDelegation(companyId: string, target: NonNullable<ApproverTarget>, locationId?: string | null): Promise<ApproverTarget> {
  if (!supabaseAdmin) return null;
  const admin = supabaseAdmin;
  const today = paymentRoutingDay();
  const result = await resolvePaymentCover(target.userId, async userId => {
    const [link, profile] = await Promise.all([
      admin.from("hr_user_person_links").select("person_id").eq("company_id",companyId).eq("user_id",userId).eq("status","active").maybeSingle(),
      admin.from("profiles").select("full_name,is_active").eq("company_id",companyId).eq("id",userId).maybeSingle()
    ]);
    if (link.error || profile.error) throw new Error("Could not verify People leave cover.");
    const base = { name: profile.data?.full_name || "Approver", canAct: Boolean(profile.data?.is_active), unavailable: false, delegateUserId: null as string | null };
    if (!link.data?.person_id) return { ...base, canAct: base.canAct && await delegateCanAct(companyId,userId,locationId) };
    const personId = link.data.person_id;
    const cover = await admin.from("hr_approval_delegations").select("delegate_person_id,reason")
      .eq("company_id",companyId).eq("approver_person_id",personId).eq("is_active",true)
      .lte("effective_from",today).gte("effective_to",today).is("workflow_code",null);
    if (cover.error) throw new Error("Could not verify active leave cover.");
    const valid = [];
    for (const row of cover.data ?? []) {
      // Ignore obsolete automatic cover after an approved absence is cancelled.
      const automatic = String(row.reason ?? "").match(/^Auto-delegated: (leave|business trip) ([a-f0-9-]{36})$/i);
      if (automatic) {
        const absence = await admin.from(automatic[1] === "leave" ? "hr_leave_requests" : "hr_business_trip_requests")
          .select("id").eq("company_id",companyId).eq("id",automatic[2]).eq("status","approved").lte("start_date",today).gte("end_date",today).maybeSingle();
        if (absence.error) throw new Error("Could not verify approved absence.");
        if (!absence.data) continue;
      }
      valid.push(row.delegate_person_id);
    }
    const delegates = [...new Set(valid)];
    if (delegates.length > 1) return { ...base, conflictingCover: true };
    if (delegates.length) {
      const delegate = await admin.from("hr_user_person_links").select("user_id").eq("company_id",companyId).eq("person_id",delegates[0]).eq("status","active").maybeSingle();
      if (delegate.error) throw new Error("Could not verify delegate identity.");
      return { ...base, unavailable: true, delegateUserId: delegate.data?.user_id ?? null };
    }
    // Approved absence without a valid delegate must use the role fallback;
    // daily roster absence/week-off does not remove approval responsibility.
    const engagements = await admin.from("hr_engagements").select("employee_id,contractor_id").eq("company_id",companyId).eq("person_id",personId);
    if (engagements.error) throw new Error("Could not verify approver engagement.");
    const employeeIds = [...new Set((engagements.data ?? []).map(row => row.employee_id).filter(Boolean))];
    const contractorIds = [...new Set((engagements.data ?? []).map(row => row.contractor_id).filter(Boolean))];
    const checks = await Promise.all([
      admin.from("hr_business_trip_requests").select("id",{count:"exact",head:true}).eq("company_id",companyId).eq("person_id",personId).eq("status","approved").lte("start_date",today).gte("end_date",today),
      ...([['employee_id',employeeIds],['contractor_id',contractorIds]] as [string,string[]][]).filter(([,ids]) => ids.length).map(([column,ids]) =>
        admin.from("hr_leave_requests").select("id",{count:"exact",head:true}).eq("company_id",companyId).in(column,ids).eq("status","approved").lte("start_date",today).gte("end_date",today))
    ]);
    if (checks.some(check => check.error)) throw new Error("Could not verify approver availability.");
    return { ...base, unavailable: checks.some(check => (check.count ?? 0) > 0), canAct: base.canAct && await delegateCanAct(companyId,userId,locationId) };
  });
  return result ? { ...target, ...result } : null;
}

/**
 * Resolves the first active approver for one step: tries each
 * candidate role in the step's configured order, and within a role, prefers
 * an org_positions-based assignment (acting cover first) before falling back
 * to company_product_memberships. Roster availability never removes approval
 * responsibility: use an explicit delegate or keep the request with its manager.
 */
export async function resolveStepApprover(companyId: string, step: ApprovalStepRow, locationId: string | null | undefined): Promise<ApproverTarget> {
  if (!supabaseAdmin) return null;

  for (const [candidateIndex, candidate] of step.candidates.entries()) {
    const scopedLocationId = candidate.scope === "company" ? null : locationId;
    const positionApprover = await findPositionApprover(companyId, [candidate.role_id], scopedLocationId);
    if (positionApprover) {
      const covered = await redirectThroughDelegation(companyId, positionApprover, locationId);
      if (covered) return { ...covered, routingReason: covered.routingReason || (candidateIndex ? "Configured fallback role: primary approver unavailable or unmapped" : "Current People assignment") };
    }

    const userIds = await candidateUserIds(companyId, candidate.role_id, candidate.scope, locationId);
    if (!userIds.length) continue;

    const profiles = await supabaseAdmin
      .from("profiles")
      .select("id, full_name")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .in("id", userIds)
      .order("full_name");
    if (profiles.error) throw new Error(profiles.error.message);

    for (const profile of profiles.data ?? []) {
      if (profile.id === positionApprover?.userId) continue;
      const covered = await redirectThroughDelegation(companyId, { userId: profile.id, roleId: candidate.role_id }, locationId);
      if (covered) return { ...covered, routingReason: covered.routingReason || (candidateIndex ? "Configured fallback role: primary approver unavailable or unmapped" : "Current People assignment") };
    }
  }

  return null;
}

export type InitialApprovalTarget = {
  approver: ApproverTarget;
  currentStepOrder: number;
  currentApprovalRoleIds: string[];
  totalSteps: number;
};

/**
 * Resolves where a brand-new request should start: the first step whose
 * candidates yield an approver (or the first required step with none, so the
 * request still lands somewhere visible instead of erroring at creation).
 * Used by both createPaymentRequest/createExpenseRequest so a request's
 * starting point is always consistent with how approvePaymentRequest will
 * later walk it forward.
 */
export async function resolveInitialApprovalTarget(companyId: string, steps: ApprovalStepRow[], locationId: string | null | undefined): Promise<InitialApprovalTarget> {
  const { step, approver } = await resolveInitialStage(steps, step => resolveStepApprover(companyId, step, locationId));
  return {
    approver,
    currentStepOrder: step?.step_order ?? 1,
    currentApprovalRoleIds: approver ? [approver.roleId] : step?.candidates.map(candidate => candidate.role_id) ?? [],
    totalSteps: steps.length
  };
}

export type AdvanceResult = {
  done: boolean;
  nextStepOrder: number | null;
  approver: ApproverTarget;
  noApproverConfigured: boolean;
};

/**
 * Walks forward from the request's current step to the next step that either
 * resolves to an approver or is the last step, skipping any step in between
 * that has no candidate and is marked not required. Returns done:true once
 * there are no more steps - the caller marks the request fully approved.
 */
export async function advanceApproval(
  companyId: string,
  steps: ApprovalStepRow[],
  currentStepOrder: number,
  locationId: string | null | undefined,
  alreadyApprovedUserIds: ReadonlySet<string> = new Set()
): Promise<AdvanceResult> {
  const remaining = steps.filter((step) => step.step_order > currentStepOrder).sort((left, right) => left.step_order - right.step_order);

  for (const step of remaining) {
    const approver = await resolveStepApprover(companyId, step, locationId);
    // Someone who already approved this request is not asked again at a later
    // step (e.g. the AOM approving on the CLM's behalf, or a Zonal Head who is
    // also the Business Head) - their approval already covers it. A mandatory
    // step with NO approver still blocks (below); it is only skipped when the
    // person who would approve it has already approved.
    if (approver && alreadyApprovedUserIds.has(approver.userId)) continue;
    if (approver) return { done: false, nextStepOrder: step.step_order, approver, noApproverConfigured: false };
    if (!step.is_required) continue;
    return { done: false, nextStepOrder: step.step_order, approver: null, noApproverConfigured: true };
  }

  return { done: true, nextStepOrder: null, approver: null, noApproverConfigured: false };
}
