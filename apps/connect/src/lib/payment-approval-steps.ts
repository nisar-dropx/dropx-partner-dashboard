import { supabaseAdmin } from "./supabase-admin";
import { findPositionApprover, roleIdsWithPageEditAccess } from "./payment-position-access";

// Mirrors src/lib/payment-approval-steps.ts in the root dashboard app - see
// payment-position-access.ts's header comment for why this is duplicated
// rather than imported across the app boundary. Keep both copies in sync by
// hand when the routing logic changes.

export type ApprovalStepCandidate = { role_id: string; scope: "station" | "cluster" | "company" };
export type ApprovalStepRow = {
  id: string;
  step_order: number;
  candidates: ApprovalStepCandidate[];
  is_required: boolean;
};
export type ApproverTarget = { userId: string; roleId: string } | null;

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

  const cluster = await stationCluster(companyId, locationId);
  if (!cluster) return [];
  const scopedStations = await supabaseAdmin.from("stations").select("id").eq("company_id", companyId).eq("cluster", cluster);
  if (scopedStations.error) throw new Error(scopedStations.error.message);
  const clusterStationIds = new Set((scopedStations.data ?? []).map((row) => row.id));
  return rows
    .filter((row) => row.has_all_location_access || (row.location_scope_ids ?? []).some((id: string) => clusterStationIds.has(id)))
    .map((row) => row.user_id);
}

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

export async function resolveStepApprover(companyId: string, step: ApprovalStepRow, locationId: string | null | undefined): Promise<ApproverTarget> {
  if (!supabaseAdmin) return null;

  for (const candidate of step.candidates) {
    const scopedLocationId = candidate.scope === "company" ? null : locationId;
    const positionApprover = await findPositionApprover(companyId, [candidate.role_id], scopedLocationId);
    if (positionApprover) return redirectThroughDelegation(companyId, positionApprover);

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
      return redirectThroughDelegation(companyId, { userId: profile.id, roleId: candidate.role_id });
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
