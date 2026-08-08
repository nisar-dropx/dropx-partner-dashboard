"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId, withCompany } from "@/lib/company-scope";
import { canActOnPaymentRequest } from "@/lib/payment-approval-scope";
import { sendPaymentNotification } from "@/lib/payment-email-notifications";
import { isRoleAtOrAboveFinalApprover } from "@/lib/payment-role-hierarchy";
import { supabaseAdmin } from "@/lib/supabase-admin";

function clean(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text.length ? text : null;
}

function required(value: FormDataEntryValue | null, field: string) {
  const text = clean(value);
  if (!text) throw new Error(`${field} is required`);
  return text;
}

async function nextApprover(companyId: string, finalRoleIds: string[]) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");
  const { data: finalUser, error } = await supabaseAdmin
    .from("profiles")
    .select("id, role_id")
    .eq("company_id", companyId)
    .in("role_id", finalRoleIds)
    .eq("is_active", true)
    .order("full_name")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!finalUser) throw new Error("No active user is assigned to a configured final approval role.");
  return { userId: finalUser.id, roleId: finalUser.role_id ?? finalRoleIds[0] ?? null };
}

async function ensureUserHasNotAlreadyActed(
  companyId: string,
  requestId: string,
  userId: string | null,
  approvalCycle: number
) {
  if (!supabaseAdmin || !userId) return;

  const baseQuery = supabaseAdmin
    .from("payment_request_approvals")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId)
    .eq("approver_user_id", userId)
    .eq("approval_cycle", approvalCycle)
    .or(`payment_request_id.eq.${requestId},request_id.eq.${requestId}`);
  const { count, error } = await baseQuery;
  if (error) {
    const legacyQuery = await supabaseAdmin
      .from("payment_request_approvals")
      .select("id", { count: "exact", head: true })
      .eq("company_id", companyId)
      .eq("approver_user_id", userId)
      .eq("approval_cycle", approvalCycle)
      .eq("request_id", requestId);
    if (!legacyQuery.error && (legacyQuery.count ?? 0) > 0) {
      throw new Error("You have already acted on this payment request.");
    }
    return;
  }

  if ((count ?? 0) > 0) {
    throw new Error("You have already acted on this payment request.");
  }
}

function isConstraintError(error: unknown, constraintName: string) {
  return String((error as { message?: unknown })?.message ?? "").toLowerCase().includes(constraintName.toLowerCase());
}

function errorText(error: unknown) {
  return String((error as { message?: unknown })?.message ?? "").toLowerCase();
}

function needsLegacyRequestId(error: unknown) {
  const message = errorText(error);
  return message.includes("column \"request_id\"") || message.includes("'request_id'");
}

function needsSequenceNo(error: unknown) {
  const message = errorText(error);
  return message.includes("column \"sequence_no\"") || message.includes("'sequence_no'");
}

function isDuplicateApprovalSequence(error: unknown) {
  const message = errorText(error);
  return (
    message.includes("payment_request_approvals_request_id_sequence_no_key") ||
    (message.includes("23505") && message.includes("sequence_no"))
  );
}

function missingNotNullColumn(error: unknown) {
  return String((error as { message?: unknown })?.message ?? "").match(/null value in column "([^"]+)"/i)?.[1] ?? null;
}

function isNextRedirect(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "digest" in error &&
      String((error as { digest?: unknown }).digest ?? "").startsWith("NEXT_REDIRECT")
  );
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const payload = error as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown };
    const parts = [payload.message, payload.details, payload.hint, payload.code]
      .map((part) => String(part ?? "").trim())
      .filter(Boolean);
    if (parts.length) return parts.join(" ");
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error || "Unable to update payment request.");
}

function approvalRedirect(params: Record<string, string>): never {
  redirect(`/payments/approvals?${new URLSearchParams(params).toString()}`);
}

function redirectParams(formData: FormData, key: "approvalError" | "approvalNotice", message: string) {
  const params: Record<string, string> = { [key]: message };
  const status = clean(formData.get("status"));
  const requestId = clean(formData.get("request_id"));
  if (status) params.status = status;
  if (key === "approvalError" && requestId) params.manage = requestId;
  return params;
}

function appendEmailNotice(message: string, emailReason?: string) {
  return emailReason ? `${message} Email not sent: ${emailReason}` : message;
}

async function runApprovalAction(formData: FormData, action: (payload: FormData) => Promise<string | void>, successMessage: string) {
  try {
    const emailReason = await action(formData);
    approvalRedirect(redirectParams(formData, "approvalNotice", appendEmailNotice(successMessage, emailReason || undefined)));
  } catch (error) {
    if (isNextRedirect(error)) throw error;
    approvalRedirect(redirectParams(formData, "approvalError", errorMessage(error)));
  }
}

export async function insertPaymentApprovalLog(payload: Record<string, unknown>, companyId: string) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");
  const admin = supabaseAdmin;
  const approvalRequestId = (approvalPayload: Record<string, unknown>) =>
    String(approvalPayload.request_id ?? approvalPayload.payment_request_id ?? "").trim();
  const nextApprovalSequence = async (approvalPayload: Record<string, unknown>, minimum = 1) => {
    const requestId = approvalRequestId(approvalPayload);
    if (!requestId) return minimum;

    const baseQuery = admin
      .from("payment_request_approvals")
      .select("sequence_no")
      .eq("company_id", companyId)
      .or(`payment_request_id.eq.${requestId},request_id.eq.${requestId}`);
    const { data, error } = await baseQuery;
    if (error) {
      const legacyQuery = await admin
        .from("payment_request_approvals")
        .select("sequence_no")
        .eq("company_id", companyId)
        .eq("request_id", requestId);
      if (legacyQuery.error) return minimum;
      const maxLegacySequence = Math.max(
        0,
        ...(legacyQuery.data ?? []).map((row) => Number((row as { sequence_no?: unknown }).sequence_no) || 0)
      );
      return Math.max(minimum, maxLegacySequence + 1);
    }

    const maxSequence = Math.max(
      0,
      ...(data ?? []).map((row) => Number((row as { sequence_no?: unknown }).sequence_no) || 0)
    );
    return Math.max(minimum, maxSequence + 1);
  };
  const legacyValueForColumn = async (column: string, approvalPayload: Record<string, unknown>) => {
    const name = column.toLowerCase();
    if (name === "role_code" || name === "approver_role_code") {
      const roleId = String(approvalPayload.approver_role_id ?? "");
      if (roleId) {
        const { data: role } = await admin
          .from("user_roles")
          .select("code")
          .eq("id", roleId)
          .eq("company_id", companyId)
          .maybeSingle();
        if (role?.code) return String(role.code).trim().toUpperCase();
      }
      return "USER";
    }
    if (name === "sequence_no" || name === "step_order") return nextApprovalSequence(approvalPayload);
    if (name === "approval_cycle") return Number(approvalPayload.approval_cycle) || 1;
    if (name === "status") return approvalPayload.action ?? "approved";
    if (name === "request_id") return approvalPayload.payment_request_id;
    if (name === "payment_request_id") return approvalPayload.request_id;
    if (name === "comments" || name === "remarks" || name === "approval_remarks") return approvalPayload.comments ?? "-";
    if (name === "company_id") return companyId;
    if (name === "approver_user_id" || name === "user_id") return approvalPayload.approver_user_id;
    if (name === "approver_role_id" || name === "role_id") return approvalPayload.approver_role_id;
    if (name === "action") return approvalPayload.action ?? "approved";
    return "-";
  };

  const writePayload = async (approvalPayload: Record<string, unknown>) => {
    const attempts = [approvalPayload];
    if (approvalPayload.payment_request_id) {
      const { payment_request_id, ...rest } = approvalPayload;
      attempts.push({ ...rest, request_id: payment_request_id });
    }

    let lastError: unknown = null;
    for (const originalAttempt of attempts) {
      const attempt = { ...originalAttempt };
      const filledColumns = new Set<string>();
      for (let retry = 0; retry < 10; retry += 1) {
        const { error } = await admin.from("payment_request_approvals").insert(withCompany(attempt, companyId));
        if (!error) return null;
        lastError = error;

        const missingColumn = missingNotNullColumn(error);
        if (missingColumn && !filledColumns.has(missingColumn)) {
          filledColumns.add(missingColumn);
          attempt[missingColumn] = await legacyValueForColumn(missingColumn, attempt);
          continue;
        }

        if (needsSequenceNo(error) && !filledColumns.has("sequence_no")) {
          filledColumns.add("sequence_no");
          attempt.sequence_no = await nextApprovalSequence(attempt);
          continue;
        }

        if (isDuplicateApprovalSequence(error)) {
          const currentSequence = Number(attempt.sequence_no) || 0;
          attempt.sequence_no = await nextApprovalSequence(attempt, currentSequence + 1);
          continue;
        }

        break;
      }

      if (!needsLegacyRequestId(lastError)) break;
    }

    return lastError;
  };

  const error = await writePayload(payload);
  if (!error) return;
  if (payload.action === "returned" && isConstraintError(error, "payment_request_approvals_action_check")) {
    const fallbackError = await writePayload({
      ...payload,
      action: "rejected",
      comments: `Returned: ${payload.comments ?? ""}`.trim()
    });
    if (!fallbackError) return;
    throw new Error(`Payment approval log was not saved: ${errorMessage(fallbackError)}`);
  }
  throw new Error(`Payment approval log was not saved: ${errorMessage(error)}`);
}

async function updatePaymentRequest(
  requestId: string,
  companyId: string,
  updatePayload: Record<string, unknown>,
  fallbackPayload?: Record<string, unknown>
) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");
  const attempts = [updatePayload, fallbackPayload].filter(Boolean) as Record<string, unknown>[];
  const expandedAttempts = attempts.flatMap((payload) => {
    const status = typeof payload.status === "string" ? payload.status : null;
    if (!status || status === status.toUpperCase()) return [payload];
    return [payload, { ...payload, status: status.toUpperCase() }];
  });

  let lastError: unknown = null;
  for (const payload of expandedAttempts) {
    const update = await supabaseAdmin
      .from("payment_requests")
      .update(payload)
      .eq("id", requestId)
      .eq("company_id", companyId);
    if (!update.error) return;
    lastError = update.error;
  }

  throw new Error(errorMessage(lastError));
}

export async function approvePaymentRequest(formData: FormData) {
  const authorization = await requirePagePermission("payment_approvals", "edit");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");

  const requestId = required(formData.get("request_id"), "Payment request");
  const comments = clean(formData.get("comments"));
  const { data: request, error } = await supabaseAdmin
    .from("payment_requests")
    .select("id, location_id, requested_by, status, approval_status, approval_cycle, current_step_order, current_approver_user_id, current_approver_role_id, current_approver_role_ids, final_approval_role_id, final_approval_role_ids")
    .eq("id", requestId)
    .eq("company_id", companyId)
    .single();
  if (error || !request) throw new Error("Payment request not found.");
  if (!(await canActOnPaymentRequest(companyId, authorization, request))) throw new Error("This request is not pending with you.");
  const approvalCycle = Number(request.approval_cycle) || 1;
  await ensureUserHasNotAlreadyActed(companyId, request.id, authorization.userId, approvalCycle);

  const { data: role } = await supabaseAdmin
    .from("user_roles")
    .select("code")
    .eq("id", authorization.roleId ?? request.current_approver_role_id)
    .eq("company_id", companyId)
    .maybeSingle();
  const roleCode = String(role?.code ?? authorization.roleCode ?? "USER").trim().toUpperCase();

  await insertPaymentApprovalLog({
    payment_request_id: request.id,
    approver_user_id: authorization.userId,
    approver_role_id: authorization.roleId ?? request.current_approver_role_id,
    approval_cycle: approvalCycle,
    action: "approved",
    comments
  }, companyId);

  const finalRoleIds = (request.final_approval_role_ids?.length ? request.final_approval_role_ids : request.final_approval_role_id ? [request.final_approval_role_id] : []) as string[];
  if (!finalRoleIds.length) throw new Error("Final approval role is not configured for this payment request.");

  const { data: companyRoles, error: companyRolesError } = await supabaseAdmin
    .from("user_roles")
    .select("id, parent_role_id")
    .eq("company_id", companyId)
    .eq("is_active", true);
  if (companyRolesError) throw new Error(companyRolesError.message);

  // A final approver, any role above a final approver in the configured role
  // hierarchy, and the company/master owner can complete approval immediately.
  const actorCanFinalize =
    authorization.isMasterOwner ||
    roleCode === "OWNER" ||
    isRoleAtOrAboveFinalApprover(authorization.roleId, finalRoleIds, companyRoles ?? []);
  const storedStepOrder = Number(request.current_step_order);
  const legacyStatus = String(request.approval_status || request.status || "").trim().toUpperCase();
  const currentStepOrder = storedStepOrder > 0
    ? storedStepOrder
    : legacyStatus.endsWith("_APPROVED") ? 2 : 1;
  const isFinalApproval = currentStepOrder >= 2 || actorCanFinalize;

  if (isFinalApproval) {
    await updatePaymentRequest(request.id, companyId, {
        status: "approved",
        approval_status: `${roleCode}_APPROVED`,
        current_approver_user_id: null,
        current_approver_role_id: null,
        current_approver_role_ids: [],
        updated_at: new Date().toISOString()
      });
  } else {
    const target = await nextApprover(companyId, finalRoleIds);
    await updatePaymentRequest(request.id, companyId, {
        status: `${roleCode}_APPROVED`,
        approval_status: `${roleCode}_APPROVED`,
        current_step_order: 2,
        current_approver_user_id: target.userId,
        current_approver_role_id: target.roleId,
        current_approver_role_ids: finalRoleIds,
        updated_at: new Date().toISOString()
      }, {
        status: "pending",
        approval_status: `${roleCode}_APPROVED`,
        current_step_order: 2,
        current_approver_user_id: target.userId,
        current_approver_role_id: target.roleId,
        current_approver_role_ids: finalRoleIds,
        updated_at: new Date().toISOString()
      });
  }

  revalidatePath("/payments/approvals");
  revalidatePath("/payments/requests");
  revalidatePath("/payments/process");
  revalidatePath("/payments/report");
  const emailResult = await sendPaymentNotification({
    actorUserId: authorization.userId,
    companyId,
    eventType: "payment_approve",
    remarks: comments,
    requestId: request.id
  });
  return emailResult.sent ? undefined : emailResult.reason;
}

export async function rejectPaymentRequest(formData: FormData) {
  const authorization = await requirePagePermission("payment_approvals", "edit");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");

  const requestId = required(formData.get("request_id"), "Payment request");
  const comments = required(formData.get("comments"), "Reject remarks");
  const { data: request, error } = await supabaseAdmin
    .from("payment_requests")
    .select("id, location_id, requested_by, approval_cycle, current_approver_user_id, current_approver_role_id, current_approver_role_ids")
    .eq("id", requestId)
    .eq("company_id", companyId)
    .single();
  if (error || !request) throw new Error("Payment request not found.");
  if (!(await canActOnPaymentRequest(companyId, authorization, request))) throw new Error("This request is not pending with you.");
  const approvalCycle = Number(request.approval_cycle) || 1;
  await ensureUserHasNotAlreadyActed(companyId, request.id, authorization.userId, approvalCycle);

  await insertPaymentApprovalLog({
    payment_request_id: request.id,
    approver_user_id: authorization.userId,
    approver_role_id: authorization.roleId ?? request.current_approver_role_id,
    approval_cycle: approvalCycle,
    action: "rejected",
    comments
  }, companyId);

  await updatePaymentRequest(request.id, companyId, {
      status: "rejected",
      approval_status: "REJECTED",
      current_approver_user_id: null,
      current_approver_role_id: null,
      current_approver_role_ids: [],
      updated_at: new Date().toISOString()
    });

  revalidatePath("/payments/approvals");
  revalidatePath("/payments/requests");
  revalidatePath("/payments/report");
  const emailResult = await sendPaymentNotification({
    actorUserId: authorization.userId,
    companyId,
    eventType: "payment_reject",
    remarks: comments,
    requestId: request.id
  });
  return emailResult.sent ? undefined : emailResult.reason;
}

export async function returnPaymentRequest(formData: FormData) {
  const authorization = await requirePagePermission("payment_approvals", "edit");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");

  const requestId = required(formData.get("request_id"), "Payment request");
  const comments = required(formData.get("comments"), "Return remarks");
  const { data: request, error } = await supabaseAdmin
    .from("payment_requests")
    .select("id, location_id, requested_by, approval_cycle, current_approver_user_id, current_approver_role_id, current_approver_role_ids")
    .eq("id", requestId)
    .eq("company_id", companyId)
    .single();
  if (error || !request) throw new Error("Payment request not found.");
  if (!(await canActOnPaymentRequest(companyId, authorization, request))) throw new Error("This request is not pending with you.");
  const approvalCycle = Number(request.approval_cycle) || 1;
  await ensureUserHasNotAlreadyActed(companyId, request.id, authorization.userId, approvalCycle);

  await insertPaymentApprovalLog({
    payment_request_id: request.id,
    approver_user_id: authorization.userId,
    approver_role_id: authorization.roleId ?? request.current_approver_role_id,
    approval_cycle: approvalCycle,
    action: "returned",
    comments
  }, companyId);

  await updatePaymentRequest(request.id, companyId, {
      status: "returned",
      approval_status: "RETURNED",
      current_approver_user_id: null,
      current_approver_role_id: null,
      current_approver_role_ids: [],
      updated_at: new Date().toISOString()
    }, {
        status: "pending",
        approval_status: "RETURNED",
        current_approver_user_id: null,
        current_approver_role_id: null,
        current_approver_role_ids: [],
        updated_at: new Date().toISOString()
      });

  revalidatePath("/payments/approvals");
  revalidatePath("/payments/requests");
  revalidatePath("/payments/report");
  const emailResult = await sendPaymentNotification({
    actorUserId: authorization.userId,
    companyId,
    eventType: "payment_return",
    remarks: comments,
    requestId: request.id
  });
  return emailResult.sent ? undefined : emailResult.reason;
}

export async function handlePaymentApprovalAction(formData: FormData) {
  const action = clean(formData.get("approval_action")) ?? "";
  try {
    if (action === "approve") {
      await approvePaymentRequest(formData);
      approvalRedirect({ approvalNotice: "Payment request approved." });
    }
    if (action === "return") {
      await returnPaymentRequest(formData);
      approvalRedirect({ approvalNotice: "Payment request returned." });
    }
    if (action === "reject") {
      await rejectPaymentRequest(formData);
      approvalRedirect({ approvalNotice: "Payment request rejected." });
    }
    throw new Error("Unsupported approval action.");
  } catch (error) {
    if (isNextRedirect(error)) throw error;
    approvalRedirect({ approvalError: errorMessage(error) });
  }
}

export async function handleApprovePaymentApproval(formData: FormData) {
  await runApprovalAction(formData, approvePaymentRequest, "Payment request approved.");
}

export async function handleReturnPaymentApproval(formData: FormData) {
  await runApprovalAction(formData, returnPaymentRequest, "Payment request returned.");
}

export async function handleRejectPaymentApproval(formData: FormData) {
  await runApprovalAction(formData, rejectPaymentRequest, "Payment request rejected.");
}
