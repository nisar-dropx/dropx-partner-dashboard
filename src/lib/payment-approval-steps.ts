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
    if (positionApprover && await isApproverAvailable(companyId, positionApprover.userId)) return positionApprover;

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
      if (await isApproverAvailable(companyId, profile.id)) return { userId: profile.id, roleId: candidate.role_id };
    }
  }

  return null;
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
