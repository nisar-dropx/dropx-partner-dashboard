import { supabaseAdmin } from "@/lib/supabase-admin";
import { findPositionApprover, roleIdsWithPageEditAccess } from "@/lib/position-access";

export type ApprovalStepCandidate = { role_id: string; scope: "station" | "cluster" | "company" };
export type ApprovalStepRow = {
  id: string;
  step_order: number;
  candidates: ApprovalStepCandidate[];
  is_required: boolean;
};
export type ApproverTarget = { userId: string; roleId: string } | null;

/**
 * Loads the ordered step list for a payment head, filtering each step's
 * candidate roles down to ones that actually hold edit access on
 * payment_approvals - the same guard as the legacy flat-array routing, now
 * applied once per step instead of duplicated per call site.
 */
export async function loadApprovalSteps(companyId: string, paymentHeadId: string): Promise<ApprovalStepRow[]> {
  if (!supabaseAdmin) return [];
  const result = await supabaseAdmin
    .from("payment_head_approval_steps")
    .select("id, step_order, candidates, is_required")
    .eq("company_id", companyId)
    .eq("payment_head_id", paymentHeadId)
    .order("step_order", { ascending: true });
  if (result.error) throw new Error(result.error.message);

  const rows = (result.data ?? []) as ApprovalStepRow[];
  const allRoleIds = Array.from(new Set(rows.flatMap((row) => row.candidates.map((candidate) => candidate.role_id))));
  const editableRoleIds = await roleIdsWithPageEditAccess(companyId, allRoleIds, "payment_approvals");

  return rows.map((row) => ({
    ...row,
    candidates: row.candidates.filter((candidate) => editableRoleIds.has(candidate.role_id))
  }));
}

async function stationCluster(companyId: string, locationId: string | null | undefined) {
  if (!supabaseAdmin || !locationId) return null;
  const result = await supabaseAdmin.from("stations").select("cluster").eq("company_id", companyId).eq("id", locationId).maybeSingle();
  return result.data?.cluster ?? null;
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
  // stations.cluster label).
  const memberships = await supabaseAdmin
    .from("company_product_memberships")
    .select("user_id, has_all_location_access, location_scope_ids")
    .eq("company_id", companyId)
    .eq("role_id", roleId)
    .eq("is_active", true);
  if (memberships.error) throw new Error(memberships.error.message);
  const rows = memberships.data ?? [];
  if (!locationId) return [];

  if (scope === "station") {
    return rows.filter((row) => row.has_all_location_access || (row.location_scope_ids ?? []).includes(locationId)).map((row) => row.user_id);
  }

  // cluster scope: a candidate qualifies if the requester's station shares a
  // cluster label with any station in the candidate's location_scope_ids.
  const cluster = await stationCluster(companyId, locationId);
  if (!cluster) return [];
  const scopedStations = await supabaseAdmin.from("stations").select("id").eq("company_id", companyId).eq("cluster", cluster);
  if (scopedStations.error) throw new Error(scopedStations.error.message);
  const clusterStationIds = new Set((scopedStations.data ?? []).map((row) => row.id));
  return rows
    .filter((row) => row.has_all_location_access || (row.location_scope_ids ?? []).some((id: string) => clusterStationIds.has(id)))
    .map((row) => row.user_id);
}

async function isApproverAvailable(companyId: string, userId: string) {
  if (!supabaseAdmin) return true;
  const result = await supabaseAdmin.rpc("hr_approval_email_is_working", { p_company_id: companyId, p_user_id: userId });
  // Availability is a courtesy skip, not a hard gate: if the RPC is missing
  // or errors (e.g. this company has no HRMS roster data), fall back to
  // treating the person as available rather than blocking the request.
  if (result.error) return true;
  return result.data !== false;
}

/**
 * hr_approval_delegations (HRMS) is auto-populated when a manager's business
 * trip or leave request is finally approved, pointing at their own reporting
 * manager for the trip/leave dates - workflow-agnostic, so it also governs
 * payment approvals here, not just HRMS's own workflows. Substitutes the
 * delegate for a resolved approver when one applies today; falls through to
 * the original approver unchanged if there's no HRMS identity link, no
 * delegation row, or the lookup errors (e.g. this company has no HRMS data).
 */
async function redirectThroughDelegation(companyId: string, target: { userId: string; roleId: string }): Promise<{ userId: string; roleId: string }> {
  if (!supabaseAdmin) return target;
  const today = new Date().toISOString().slice(0, 10);

  const link = await supabaseAdmin
    .from("hr_user_person_links")
    .select("person_id")
    .eq("company_id", companyId)
    .eq("user_id", target.userId)
    .eq("status", "active")
    .maybeSingle();
  if (link.error || !link.data?.person_id) return target;

  const delegation = await supabaseAdmin
    .from("hr_approval_delegations")
    .select("delegate_person_id")
    .eq("company_id", companyId)
    .eq("approver_person_id", link.data.person_id)
    .eq("is_active", true)
    .lte("effective_from", today)
    .gte("effective_to", today)
    .is("workflow_code", null)
    .maybeSingle();
  if (delegation.error || !delegation.data?.delegate_person_id) return target;

  const delegateLink = await supabaseAdmin
    .from("hr_user_person_links")
    .select("user_id")
    .eq("company_id", companyId)
    .eq("person_id", delegation.data.delegate_person_id)
    .eq("status", "active")
    .maybeSingle();
  if (delegateLink.error || !delegateLink.data?.user_id) return target;

  const delegateProfile = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("company_id", companyId)
    .eq("id", delegateLink.data.user_id)
    .eq("is_active", true)
    .maybeSingle();
  if (delegateProfile.error || !delegateProfile.data?.id) return target;

  return { userId: delegateProfile.data.id, roleId: target.roleId };
}

/**
 * Resolves the first available, active approver for one step: tries each
 * candidate role in the step's configured order, and within a role, prefers
 * an org_positions-based assignment (acting cover first) before falling back
 * to company_product_memberships - then skips anyone currently on leave or
 * off-roster per the shared HRMS availability RPC.
 */
export async function resolveStepApprover(companyId: string, step: ApprovalStepRow, locationId: string | null | undefined): Promise<ApproverTarget> {
  if (!supabaseAdmin) return null;

  for (const candidate of step.candidates) {
    const scopedLocationId = candidate.scope === "company" ? null : locationId;
    const positionApprover = await findPositionApprover(companyId, [candidate.role_id], scopedLocationId);
    if (positionApprover && await isApproverAvailable(companyId, positionApprover.userId)) return redirectThroughDelegation(companyId, positionApprover);

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
      if (await isApproverAvailable(companyId, profile.id)) return redirectThroughDelegation(companyId, { userId: profile.id, roleId: candidate.role_id });
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
  const ordered = [...steps].sort((left, right) => left.step_order - right.step_order);
  for (const step of ordered) {
    const approver = await resolveStepApprover(companyId, step, locationId);
    if (approver) {
      return {
        approver,
        currentStepOrder: step.step_order,
        currentApprovalRoleIds: step.candidates.map((candidate) => candidate.role_id),
        totalSteps: ordered.length
      };
    }
    if (step.is_required) {
      return {
        approver: null,
        currentStepOrder: step.step_order,
        currentApprovalRoleIds: step.candidates.map((candidate) => candidate.role_id),
        totalSteps: ordered.length
      };
    }
  }
  return { approver: null, currentStepOrder: ordered.length || 1, currentApprovalRoleIds: [], totalSteps: ordered.length };
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
export async function advanceApproval(companyId: string, steps: ApprovalStepRow[], currentStepOrder: number, locationId: string | null | undefined): Promise<AdvanceResult> {
  const remaining = steps.filter((step) => step.step_order > currentStepOrder).sort((left, right) => left.step_order - right.step_order);

  for (const step of remaining) {
    const approver = await resolveStepApprover(companyId, step, locationId);
    if (approver) return { done: false, nextStepOrder: step.step_order, approver, noApproverConfigured: false };
    if (!step.is_required) continue;
    return { done: false, nextStepOrder: step.step_order, approver: null, noApproverConfigured: true };
  }

  return { done: true, nextStepOrder: null, approver: null, noApproverConfigured: false };
}
