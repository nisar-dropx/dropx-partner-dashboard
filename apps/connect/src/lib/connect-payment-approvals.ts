import "server-only";

import { supabaseAdmin } from "./supabase-admin";
import { advanceApproval, loadApprovalSteps, type ApproverTarget } from "./payment-approval-steps";

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

async function actorRoleIds(companyId: string, actorUserIds: string[]): Promise<string[]> {
  if (!actorUserIds.length) return [];
  const memberships = await db()
    .from("company_product_memberships")
    .select("role_id")
    .eq("company_id", companyId)
    .in("user_id", actorUserIds)
    .eq("is_active", true);
  if (memberships.error) throw new Error(memberships.error.message);
  const roleIds = (memberships.data ?? []).map((row) => row.role_id).filter(Boolean) as string[];

  const profiles = await db().from("profiles").select("role_id").eq("company_id", companyId).in("id", actorUserIds);
  for (const row of profiles.data ?? []) {
    if (row.role_id) roleIds.push(row.role_id);
  }

  return [...new Set(roleIds)];
}

/**
 * Payment requests currently routed to this Connect actor: a direct
 * current_approver_user_id match (any resolved user id for this person, a
 * Connect account can have more than one), or a role match against every
 * role the actor holds - same eligibility as canActOnPaymentRequest in the
 * ops dashboard, minus the OWNER/all-locations bypass since Connect accounts
 * are always specific people, never the ops admin session.
 */
export async function listConnectPaymentApprovals(companyId: string, actorUserIds: string[]): Promise<PaymentApprovalListItem[]> {
  if (!actorUserIds.length) return [];
  const roleIds = await actorRoleIds(companyId, actorUserIds);

  let query = db()
    .from("payment_requests")
    .select("id, request_no, location_code, amount, amount_requested, remarks, created_at, requested_by, payment_heads(name), payment_request_answers(id)")
    .eq("company_id", companyId)
    .in("status", ["pending", "resubmitted"])
    .not("current_approver_user_id", "is", null);

  const orParts = [`current_approver_user_id.in.(${actorUserIds.join(",")})`];
  if (roleIds.length) {
    orParts.push(`current_approver_role_id.in.(${roleIds.join(",")})`);
    orParts.push(`current_approver_role_ids.ov.{${roleIds.join(",")}}`);
  }
  query = query.or(orParts.join(","));

  const result = await query.order("created_at", { ascending: true });
  if (result.error) throw new Error(result.error.message);

  const requesterIds = [...new Set((result.data ?? []).map((row) => row.requested_by).filter(Boolean))] as string[];
  const requesters = requesterIds.length
    ? await db().from("profiles").select("id, full_name").eq("company_id", companyId).in("id", requesterIds)
    : { data: [] as { id: string; full_name: string | null }[] };
  const requesterNameById = new Map((requesters.data ?? []).map((row) => [row.id, row.full_name]));

  return (result.data ?? []).map((row) => {
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

async function loadOwnedRequest(companyId: string, requestId: string, actorUserIds: string[], roleIds: string[]): Promise<RequestRow> {
  const result = await db()
    .from("payment_requests")
    .select("id, company_id, location_id, payment_head_id, current_step_order, current_approver_user_id, current_approver_role_id, current_approver_role_ids, approval_cycle, status")
    .eq("id", requestId)
    .eq("company_id", companyId)
    .single();
  if (result.error || !result.data) throw new Error("Payment request not found.");
  if (!["pending", "resubmitted"].includes(String(result.data.status))) throw new Error("This request has already been decided.");

  const isOwnerMatch = Boolean(result.data.current_approver_user_id && actorUserIds.includes(result.data.current_approver_user_id));
  const isRoleMatch = Boolean(result.data.current_approver_role_id && roleIds.includes(result.data.current_approver_role_id))
    || (result.data.current_approver_role_ids ?? []).some((roleId: string) => roleIds.includes(roleId));
  if (!isOwnerMatch && !isRoleMatch) throw new Error("This request is not pending with you.");

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
  const roleIds = await actorRoleIds(companyId, actorUserIds);
  const request = await loadOwnedRequest(companyId, requestId, actorUserIds, roleIds);
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
