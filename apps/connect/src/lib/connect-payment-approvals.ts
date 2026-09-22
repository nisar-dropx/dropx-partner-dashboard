import "server-only";

import { supabaseAdmin } from "./supabase-admin";
import { advanceApproval, loadApprovalSteps, type ApproverTarget } from "./payment-approval-steps";
import { initialApprovalReadyIds } from "../../../../src/lib/payment-initial-approval-gate";
import { isPendingPaymentApproval } from "../../../../src/lib/payment-stage-policy";

function db() {
  if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
  return supabaseAdmin;
}

export type PaymentApprovalListItem = {
  id: string;
  requestNo: string;
  locationCode: string | null;
  paymentHeadName: string;
  amount: number | null;
  amountRequested: number | null;
  requesterName: string | null;
  remarks: string | null;
  createdAt: string;
  attachmentCount: number;
};

type ActorRoleScope = { hasAllLocationAccess: boolean; locationScopeIds: string[]; modelIds: Set<string> | null };

/**
 * Per role the actor holds, the union of their location access for that role
 * (has_all_location_access, or the union of location_scope_ids across every
 * active membership row granting it - a profile's own profiles.role_id has no
 * location scope of its own, so it's treated as company-wide, matching prior
 * behavior for that fallback), plus the set of business-model ids
 * (stations.location_model_id) those stations belong to - null means
 * has_all_location_access (covers every model, same as it already covers
 * every station).
 */
async function actorRoleScopes(companyId: string, actorUserIds: string[]): Promise<Map<string, ActorRoleScope>> {
  const scopes = new Map<string, ActorRoleScope>();
  if (!actorUserIds.length) return scopes;

  function merge(roleId: string, hasAll: boolean, scopeIds: string[]) {
    const existing = scopes.get(roleId) ?? { hasAllLocationAccess: false, locationScopeIds: [], modelIds: null };
    existing.hasAllLocationAccess = existing.hasAllLocationAccess || hasAll;
    if (scopeIds.length) existing.locationScopeIds = [...new Set([...existing.locationScopeIds, ...scopeIds])];
    scopes.set(roleId, existing);
  }

  const memberships = await db()
    .from("company_product_memberships")
    .select("role_id, has_all_location_access, location_scope_ids")
    .eq("company_id", companyId)
    .in("user_id", actorUserIds)
    .eq("is_active", true);
  if (memberships.error) throw new Error(memberships.error.message);
  for (const row of memberships.data ?? []) {
    if (row.role_id) merge(row.role_id, Boolean(row.has_all_location_access), row.location_scope_ids ?? []);
  }

  const profiles = await db().from("profiles").select("role_id").eq("company_id", companyId).in("id", actorUserIds);
  for (const row of profiles.data ?? []) {
    if (row.role_id) merge(row.role_id, true, []);
  }

  const allScopeIds = [...new Set([...scopes.values()].flatMap((scope) => scope.locationScopeIds))];
  if (allScopeIds.length) {
    const stations = await db().from("stations").select("id, location_model_id").eq("company_id", companyId).in("id", allScopeIds);
    const modelByStation = new Map((stations.data ?? []).map((row) => [row.id, row.location_model_id]));
    for (const scope of scopes.values()) {
      if (scope.hasAllLocationAccess) continue;
      scope.modelIds = new Set(scope.locationScopeIds.map((id) => modelByStation.get(id)).filter((id): id is string => Boolean(id)));
    }
  }

  return scopes;
}

/**
 * A role-based match only counts if that role's location access (for this
 * actor) actually covers the request's station - otherwise, e.g., a Regional
 * Manager whose region is 7 specific stations would match every request
 * company-wide just for holding the role, including requests already
 * assigned to someone else in a different region entirely. Also requires the
 * request's business model (e.g. Amazon EDSP vs Amazon Now) to be one this
 * actor's own stations actually operate, as a defense-in-depth check
 * independent of the station list itself.
 */
function roleCoversLocation(scopes: Map<string, ActorRoleScope>, roleId: string, locationId: string | null, locationModelId: string | null) {
  const scope = scopes.get(roleId);
  if (!scope) return false;
  if (scope.hasAllLocationAccess) return true;
  if (!locationId) return false;
  if (!scope.locationScopeIds.includes(locationId)) return false;
  if (locationModelId && scope.modelIds && !scope.modelIds.has(locationModelId)) return false;
  return true;
}

/**
 * Payment requests currently routed to this Connect actor: a direct
 * current_approver_user_id match (any resolved user id for this person, a
 * Connect account can have more than one), or a role match against every
 * role the actor holds - same eligibility as canActOnPaymentRequest in the
 * ops dashboard, minus the OWNER/all-locations bypass since Connect accounts
 * are always specific people, never the ops admin session.
 *
 * A role-only match is additionally required to actually cover the
 * request's station for that actor (see roleCoversLocation) - otherwise
 * anyone holding a station/region-scoped role (e.g. Regional Manager) would
 * see every request company-wide just for holding the role, including ones
 * already assigned to a specific person outside their region. A direct
 * current_approver_user_id match is always trusted as-is, since it was
 * already scoped correctly when the engine resolved it.
 */
export async function listConnectPaymentApprovals(companyId: string, actorUserIds: string[]): Promise<PaymentApprovalListItem[]> {
  if (!actorUserIds.length) return [];
  const roleScopes = await actorRoleScopes(companyId, actorUserIds);
  const roleIds = [...roleScopes.keys()];

  let query = db()
    .from("payment_requests")
    .select("id, request_no, status, approval_status, location_id, location_code, amount, amount_requested, remarks, created_at, requested_by, current_approver_user_id, current_approver_role_id, current_approver_role_ids, stations(location_model_id), payment_heads(name), payment_request_answers(id)")
    .eq("company_id", companyId);

  const orParts = [`current_approver_user_id.in.(${actorUserIds.join(",")})`];
  if (roleIds.length) {
    orParts.push(`current_approver_role_id.in.(${roleIds.join(",")})`);
    orParts.push(`current_approver_role_ids.ov.{${roleIds.join(",")}}`);
  }
  query = query.or(orParts.join(","));

  const result = await query.order("created_at", { ascending: true });
  if (result.error) throw new Error(result.error.message);

  const assigned = (result.data ?? []).filter((row) => {
    if (!isPendingPaymentApproval(row.status, row.approval_status)) return false;
    if (row.current_approver_user_id) return actorUserIds.includes(row.current_approver_user_id);
    const station = Array.isArray(row.stations) ? row.stations[0] : row.stations;
    const locationModelId = station?.location_model_id ?? null;
    const roleCandidates = [row.current_approver_role_id, ...(row.current_approver_role_ids ?? [])].filter(Boolean) as string[];
    return roleCandidates.some((roleId) => roleCoversLocation(roleScopes, roleId, row.location_id, locationModelId));
  });
  const readyIds = await initialApprovalReadyIds(companyId, assigned.map(row => row.id), db());
  const scoped = assigned.filter(row => readyIds.has(row.id));

  const requesterIds = [...new Set(scoped.map((row) => row.requested_by).filter(Boolean))] as string[];
  const requesters = requesterIds.length
    ? await db().from("profiles").select("id, full_name").eq("company_id", companyId).in("id", requesterIds)
    : { data: [] as { id: string; full_name: string | null }[] };
  const requesterNameById = new Map((requesters.data ?? []).map((row) => [row.id, row.full_name]));

  return scoped.map((row) => {
    const paymentHead = Array.isArray(row.payment_heads) ? row.payment_heads[0] : row.payment_heads;
    return {
      id: row.id,
      requestNo: row.request_no,
      locationCode: row.location_code,
      paymentHeadName: paymentHead?.name ?? "Payment",
      amount: row.amount,
      amountRequested: row.amount_requested,
      requesterName: row.requested_by ? requesterNameById.get(row.requested_by) ?? null : null,
      remarks: row.remarks,
      createdAt: row.created_at,
      attachmentCount: Array.isArray(row.payment_request_answers) ? row.payment_request_answers.length : 0
    };
  });
}

type RequestRow = {
  id: string;
  company_id: string;
  location_id: string | null;
  payment_head_id: string | null;
  current_step_order: number | null;
  current_approver_user_id: string | null;
  current_approver_role_id: string | null;
  current_approver_role_ids: string[] | null;
  approval_cycle: number | null;
};

async function loadOwnedRequest(companyId: string, requestId: string, actorUserIds: string[], roleScopes: Map<string, ActorRoleScope>): Promise<RequestRow> {
  const result = await db()
    .from("payment_requests")
    .select("id, company_id, location_id, payment_head_id, current_step_order, current_approver_user_id, current_approver_role_id, current_approver_role_ids, approval_cycle, status, approval_status, stations(location_model_id)")
    .eq("id", requestId)
    .eq("company_id", companyId)
    .single();
  if (result.error || !result.data) throw new Error("Payment request not found.");
  if (!isPendingPaymentApproval(result.data.status, result.data.approval_status)) throw new Error("This request has already been decided.");

  const station = Array.isArray(result.data.stations) ? result.data.stations[0] : result.data.stations;
  const locationModelId = station?.location_model_id ?? null;
  const isOwnerMatch = Boolean(result.data.current_approver_user_id && actorUserIds.includes(result.data.current_approver_user_id));
  const roleCandidates = [result.data.current_approver_role_id, ...(result.data.current_approver_role_ids ?? [])].filter(Boolean) as string[];
  const isRoleMatch = !result.data.current_approver_user_id && roleCandidates.some((roleId) => roleCoversLocation(roleScopes, roleId, result.data.location_id, locationModelId));
  if (!isOwnerMatch && !isRoleMatch) throw new Error("This request is not pending with you.");
  if (!(await initialApprovalReadyIds(companyId, [requestId], db())).has(requestId)) throw new Error("Initial approval must be completed before this request can be approved at this stage.");

  return result.data;
}

async function nextApprovalSequence(companyId: string, requestId: string) {
  const result = await db().from("payment_request_approvals").select("sequence_no").eq("company_id", companyId).eq("payment_request_id", requestId);
  if (result.error) return 1;
  const max = Math.max(0, ...(result.data ?? []).map((row) => Number(row.sequence_no) || 0));
  return max + 1;
}

async function roleCode(companyId: string, roleId: string | null) {
  if (!roleId) return "USER";
  const result = await db().from("user_roles").select("code").eq("id", roleId).eq("company_id", companyId).maybeSingle();
  return String(result.data?.code ?? "USER").trim().toUpperCase();
}

async function logApprovalAction(companyId: string, requestId: string, actorUserId: string, actorRoleId: string | null, action: string, comments: string) {
  const [sequenceNo, code] = await Promise.all([
    nextApprovalSequence(companyId, requestId),
    roleCode(companyId, actorRoleId)
  ]);
  const insert = await db().from("payment_request_approvals").insert({
    company_id: companyId,
    request_id: requestId,
    payment_request_id: requestId,
    sequence_no: sequenceNo,
    role_code: code,
    status: action,
    approver_user_id: actorUserId,
    approver_role_id: actorRoleId,
    action,
    comments,
    approval_cycle: 1
  });
  if (insert.error) throw new Error(insert.error.message);
}

async function applyApproverTarget(companyId: string, requestId: string, roleCodeLabel: string, target: ApproverTarget, nextStepOrder: number | null) {
  await db().from("payment_requests").update({
    status: target ? `${roleCodeLabel}_APPROVED` : "NO_APPROVER_CONFIGURED",
    approval_status: target ? `${roleCodeLabel}_APPROVED` : "NO_APPROVER_CONFIGURED",
    current_step_order: nextStepOrder,
    current_approver_user_id: target?.userId ?? null,
    current_approver_role_id: target?.roleId ?? null,
    current_approver_role_ids: target?.roleId ? [target.roleId] : [],
    updated_at: new Date().toISOString()
  }).eq("id", requestId).eq("company_id", companyId);
}

export async function decideConnectPaymentApproval(companyId: string, actorUserIds: string[], requestId: string, decision: "approved" | "returned" | "rejected", comments: string) {
  if (!actorUserIds.length) throw new Error("A DropX One login is required to act on this request.");
  const roleScopes = await actorRoleScopes(companyId, actorUserIds);
  const roleIds = [...roleScopes.keys()];
  const request = await loadOwnedRequest(companyId, requestId, actorUserIds, roleScopes);
  const actorUserId = request.current_approver_user_id && actorUserIds.includes(request.current_approver_user_id)
    ? request.current_approver_user_id
    : actorUserIds[0];
  const actorRoleId = request.current_approver_role_id && roleIds.includes(request.current_approver_role_id)
    ? request.current_approver_role_id
    : roleIds[0] ?? null;
  const code = await roleCode(companyId, actorRoleId);

  if (decision === "rejected") {
    if (!comments.trim()) throw new Error("Reject remarks are required.");
    await logApprovalAction(companyId, requestId, actorUserId, actorRoleId, "rejected", comments);
    await db().from("payment_requests").update({
      status: "rejected", approval_status: "REJECTED",
      current_approver_user_id: null, current_approver_role_id: null, current_approver_role_ids: [],
      updated_at: new Date().toISOString()
    }).eq("id", requestId).eq("company_id", companyId);
    return;
  }

  if (decision === "returned") {
    if (!comments.trim()) throw new Error("Return remarks are required.");
    await logApprovalAction(companyId, requestId, actorUserId, actorRoleId, "returned", comments);
    await db().from("payment_requests").update({
      status: "returned", approval_status: "RETURNED",
      current_approver_user_id: null, current_approver_role_id: null, current_approver_role_ids: [],
      updated_at: new Date().toISOString()
    }).eq("id", requestId).eq("company_id", companyId);
    return;
  }

  await logApprovalAction(companyId, requestId, actorUserId, actorRoleId, "approved", comments);

  const steps = request.payment_head_id ? await loadApprovalSteps(companyId, request.payment_head_id) : [];
  if (!steps.length) {
    // No configured steps for this payment head yet - a Connect approver can
    // only be routed here via the step engine in the first place (payment
    // requests without steps still resolve through the legacy ops-only flat
    // arrays), so finalize outright rather than guessing a next step.
    await db().from("payment_requests").update({
      status: "approved", approval_status: "FINAL_APPROVED",
      current_approver_user_id: null, current_approver_role_id: null, current_approver_role_ids: [],
      updated_at: new Date().toISOString()
    }).eq("id", requestId).eq("company_id", companyId);
    return;
  }

  const storedStepOrder = Number(request.current_step_order) || 1;
  const advance = await advanceApproval(companyId, steps, storedStepOrder, request.location_id);
  if (advance.done) {
    await db().from("payment_requests").update({
      status: "approved", approval_status: "FINAL_APPROVED",
      current_approver_user_id: null, current_approver_role_id: null, current_approver_role_ids: [],
      updated_at: new Date().toISOString()
    }).eq("id", requestId).eq("company_id", companyId);
    return;
  }

  await applyApproverTarget(companyId, requestId, code, advance.approver, advance.nextStepOrder);
}
