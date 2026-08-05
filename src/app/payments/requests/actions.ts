"use server";

import { randomInt } from "crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId, withCompany } from "@/lib/company-scope";
import { sendPaymentNotification } from "@/lib/payment-email-notifications";
import { canAccessPaymentLocation } from "@/lib/payment-approval-scope";
import { validatePaymentFile } from "@/lib/payment-file-types";
import { normalizePaymentModes, type PaymentMode } from "@/lib/payment-modes";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { insertPaymentApprovalLog } from "../approvals/actions";

function clean(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text.length ? text : null;
}

function required(value: FormDataEntryValue | null, field: string) {
  const text = clean(value);
  if (!text) throw new Error(`${field} is required`);
  return text;
}

function safeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
}

function paymentRequestsRedirect(params?: Record<string, string>): never {
  const query = params ? `?${new URLSearchParams(params).toString()}` : "";
  redirect(`/payments/requests${query}`);
}

function expenseRequestsRedirect(params?: Record<string, string>): never {
  const query = params ? `?${new URLSearchParams(params).toString()}` : "";
  redirect(`/payments/expense-request${query}`);
}

function paymentEmailNotice(message: string, reason?: string) {
  return reason ? `${message} Email not sent: ${reason}` : message;
}

function paymentRequestErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Unable to save payment request.";
  const lower = message.toLowerCase();
  if (
    lower.includes("schema cache") ||
    lower.includes("bank_account_no") ||
    lower.includes("account_holder_name") ||
    lower.includes("contact_no") ||
    lower.includes("ifsc")
  ) {
    return "Payment request database columns are missing. Run scripts/payment_requests_v1.sql in Supabase SQL Editor, then refresh.";
  }
  return message;
}

function missingNotNullColumn(message: string) {
  return message.match(/null value in column "([^"]+)"/i)?.[1] ?? null;
}

function isCategoryCheckError(message: string) {
  return message.toLowerCase().includes("payment_requests_category_check");
}

function schemaMissingColumn(message: string) {
  const match = message.match(/(?:column|schema cache).*['"]([a-zA-Z0-9_]+)['"]/i);
  return match?.[1] ?? null;
}

type ApproverTarget = {
  userId: string | null;
  roleId: string | null;
};

type PaymentQuestionForAction = {
  id: string;
  question_text?: string | null;
  answer_type: string;
  dropdown_options?: string | null;
  is_required: boolean;
  field_stage?: string | null;
  sort_order?: number | null;
};

function validateQuestionFile(file: File, question: PaymentQuestionForAction) {
  const error = validatePaymentFile(file, question.dropdown_options);
  if (error) throw new Error(`${question.question_text || "File upload"}: ${error}`);
}

function questionStage(question: PaymentQuestionForAction) {
  return question.field_stage === "payment" ? "payment" : "expense";
}

function questionsForStage<T extends PaymentQuestionForAction>(questions: T[] | null | undefined, stage: "expense" | "payment") {
  return (questions ?? [])
    .filter((question) => Number(question.sort_order ?? 0) > 0)
    .filter((question) => questionStage(question) === stage);
}

function randomPaymentRequestNo() {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return Array.from({ length: 10 }, () => alphabet[randomInt(alphabet.length)]).join("");
}

async function nextPaymentRequestNo(companyId: string) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const requestNo = randomPaymentRequestNo();
    const { data, error } = await supabaseAdmin
      .from("payment_requests")
      .select("id")
      .eq("company_id", companyId)
      .eq("request_no", requestNo)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return requestNo;
  }

  throw new Error("Unable to generate a unique payment request ID.");
}

async function approverForRoles(companyId: string, roleIds: string[], label: string): Promise<ApproverTarget> {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");
  if (!roleIds.length) throw new Error(`${label} is not configured.`);

  const { data: approver, error } = await supabaseAdmin
    .from("profiles")
    .select("id, role_id")
    .eq("company_id", companyId)
    .in("role_id", roleIds)
    .eq("is_active", true)
    .order("full_name")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!approver) throw new Error(`No active user is assigned to any configured ${label}.`);

  return { userId: approver.id, roleId: approver.role_id ?? roleIds[0] };
}

function configuredRoleIds(roleIds: string[] | null | undefined, legacyRoleId: string | null | undefined) {
  // An empty modern array is an intentional "no role" configuration. Only
  // legacy rows where the array is absent should fall back to the old column.
  if (Array.isArray(roleIds)) return roleIds;
  return legacyRoleId ? [legacyRoleId] : [];
}

export async function createExpenseRequest(formData: FormData) {
  const authorization = await requirePagePermission("expense_requests", "add");
  const companyId = requireCompanyId(authorization);
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");
    const admin = supabaseAdmin;

    const locationId = required(formData.get("location_id"), "Location");
    const paymentHeadId = required(formData.get("payment_head_id"), "Payment Head");
    const amountText = required(formData.get("amount"), "Estimated Amount");
    const remarks = clean(formData.get("remarks"));

    const [locationResult, headResult] = await Promise.all([
      admin.from("stations").select("id, station_code, station_email, station_manager_email").eq("id", locationId).eq("company_id", companyId).single(),
      admin
        .from("payment_heads")
        .select("id, code, initial_approval_role_id, initial_approval_role_ids, final_approval_role_id, final_approval_role_ids, payment_process_role_ids, payment_head_questions (id, question_text, answer_type, dropdown_options, is_required, field_stage, sort_order)")
        .eq("id", paymentHeadId)
        .eq("company_id", companyId)
        .single()
    ]);
    if (locationResult.error) throw new Error("Location not found for this company.");
    if (headResult.error) throw new Error("Payment head not found for this company.");
    if (!authorization.hasAllLocationAccess) {
      const userEmail = authorization.email?.trim().toLowerCase() ?? "";
      const locationEmail = locationResult.data.station_email?.trim().toLowerCase();
      const managerEmail = locationResult.data.station_manager_email?.trim().toLowerCase();
      const hasScopedAccess = authorization.locationScopeIds.includes(locationResult.data.id);
      const hasEmailAccess = Boolean(userEmail && (locationEmail === userEmail || managerEmail === userEmail));
      if (!hasScopedAccess && !hasEmailAccess) {
        throw new Error("You can request expense only for your assigned locations.");
      }
    }

    const initialApprovalRoleIds = configuredRoleIds(headResult.data.initial_approval_role_ids, headResult.data.initial_approval_role_id);
    const finalApprovalRoleIds = configuredRoleIds(headResult.data.final_approval_role_ids, headResult.data.final_approval_role_id);
    const paymentProcessRoleIds = (headResult.data.payment_process_role_ids ?? []) as string[];
    if (!finalApprovalRoleIds.length) throw new Error("Final approval role is not configured for this payment head.");
    if (!paymentProcessRoleIds.length) throw new Error("Payment process role is not configured for this payment head.");

    const expenseQuestions = questionsForStage(headResult.data.payment_head_questions, "expense");
    const fileQuestions = expenseQuestions.filter((question) => question.answer_type === "file");
    for (const question of fileQuestions) {
      const file = formData.get(`files[${question.id}]`);
      if (file instanceof File && file.size > 0) validateQuestionFile(file, question);
      if (question.is_required && !(file instanceof File && file.size > 0)) {
        throw new Error("Required file upload is missing.");
      }
    }

    const requestNo = await nextPaymentRequestNo(companyId);
    const workDate = new Date().toISOString().slice(0, 10);
    const startsWithFinalApproval = !initialApprovalRoleIds.length;
    const currentApprovalRoleIds = startsWithFinalApproval ? finalApprovalRoleIds : initialApprovalRoleIds;
    const approver = await approverForRoles(
      companyId,
      currentApprovalRoleIds,
      startsWithFinalApproval ? "final approver roles" : "initial approver roles"
    );

    const { data: request, error: requestError } = await admin
      .from("payment_requests")
      .insert(withCompany({
        request_no: requestNo,
        location_id: locationResult.data.id,
        location_code: locationResult.data.station_code,
        station_code: locationResult.data.station_code,
        payment_head_id: paymentHeadId,
        category: "expense",
        work_date: workDate,
        requested_for_name: locationResult.data.station_code,
        amount: null,
        amount_requested: Number(amountText),
        bank_account_no: null,
        ifsc: null,
        account_holder_name: null,
        beneficiary_account_no: null,
        beneficiary_account_number: null,
        beneficiary_ifsc: null,
        beneficiary_account_holder: null,
        contact_no: null,
        email: null,
        remarks,
        status: "pending",
        approval_status: "PENDING",
        current_step_order: startsWithFinalApproval ? 2 : 1,
        current_approver_user_id: approver.userId,
        current_approver_role_id: approver.roleId,
        current_approver_role_ids: currentApprovalRoleIds,
        final_approval_role_id: finalApprovalRoleIds[0],
        final_approval_role_ids: finalApprovalRoleIds,
        payment_process_role_ids: paymentProcessRoleIds,
        requested_by: authorization.userId
      }, companyId))
      .select("id")
      .single();
    if (requestError) throw new Error(requestError.message);

    await insertPaymentApprovalLog(withCompany({
      payment_request_id: request.id,
      request_id: request.id,
      approver_user_id: authorization.userId,
      approver_role_id: authorization.roleId,
      approval_cycle: 1,
      action: "created",
      comments: remarks || "Expense request created."
    }, companyId), companyId);

    const questionIds = formData.getAll("question_ids").map((value) => String(value));
    if (questionIds.length) {
      const questionById = new Map(expenseQuestions.map((question) => [question.id, question]));
      const answers = await Promise.all(questionIds.map(async (questionId) => {
        const question = questionById.get(questionId);
        if (question?.answer_type === "file") {
          const file = formData.get(`files[${questionId}]`);
          if (file instanceof File && file.size > 0) {
            validateQuestionFile(file, question);
            const path = `${companyId}/${request.id}/${questionId}/${Date.now()}-${safeFileName(file.name)}`;
            const { error: uploadError } = await admin.storage.from("payment-request-documents").upload(path, file, { upsert: false });
            if (uploadError) throw new Error(uploadError.message);
            return withCompany({
              payment_request_id: request.id,
              question_id: questionId,
              answer_value: file.name,
              file_path: path,
              file_name: file.name,
              file_size: file.size
            }, companyId);
          }
          return withCompany({
            payment_request_id: request.id,
            question_id: questionId,
            answer_value: null,
            file_path: null,
            file_name: null,
            file_size: null
          }, companyId);
        }

        return withCompany({
          payment_request_id: request.id,
          question_id: questionId,
          answer_value: clean(formData.get(`answers[${questionId}]`)),
          file_path: null,
          file_name: null,
          file_size: null
        }, companyId);
      }));
      const { error: answersError } = await admin.from("payment_request_answers").insert(answers);
      if (answersError) throw new Error(answersError.message);
    }

    revalidatePath("/payments/expense-request");
    revalidatePath("/payments/requests");
    revalidatePath("/payments/approvals");
    revalidatePath("/payments/report");
    const emailResult = await sendPaymentNotification({
      actorUserId: authorization.userId,
      companyId,
      eventType: "payment_request",
      remarks,
      requestId: request.id
    });
    if (!emailResult.sent) {
      expenseRequestsRedirect({
        expenseNotice: paymentEmailNotice("Expense request submitted for approval.", emailResult.reason)
      });
    }
  } catch (error) {
    expenseRequestsRedirect({
      expenseError: paymentRequestErrorMessage(error)
    });
  }

  expenseRequestsRedirect({ expenseNotice: "Expense request submitted for approval." });
}

export async function createPaymentRequest(formData: FormData) {
  const authorization = await requirePagePermission("payment_requests", "add");
  const companyId = requireCompanyId(authorization);
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");
    const admin = supabaseAdmin;

    const locationId = required(formData.get("location_id"), "Location");
    const paymentHeadId = required(formData.get("payment_head_id"), "Payment Head");
    const amountText = required(formData.get("amount"), "Amount");
    const paymentModeValue = clean(formData.get("payment_mode"));
    const paymentMode = paymentModeValue === "online_payment"
      ? "online_payment"
      : paymentModeValue === "upi_payment"
        ? "upi_payment"
        : "account_transfer";
    const isOnlinePayment = paymentMode === "online_payment";
    const isUpiPayment = paymentMode === "upi_payment";
    const isAccountTransfer = paymentMode === "account_transfer";
    const bankAccountNo = isAccountTransfer ? required(formData.get("bank_account_no"), "Bank Account No") : null;
    const ifsc = isAccountTransfer ? required(formData.get("ifsc"), "IFSC") : null;
    const accountHolderName = isAccountTransfer ? required(formData.get("account_holder_name"), "Acc Holder Name") : null;
    if (isAccountTransfer && clean(formData.get("bank_verified")) !== "1") {
      throw new Error("Verify the bank account before submitting the payment request.");
    }
    const paymentPortal = isOnlinePayment ? required(formData.get("payment_portal"), "Payment Portal") : null;
    const paymentReference = isOnlinePayment
      ? clean(formData.get("payment_reference"))
      : isUpiPayment
        ? required(formData.get("upi_id"), "UPI ID")
        : null;
    const submittedUpiHolderName = isUpiPayment ? required(formData.get("upi_account_holder_name"), "UPI Account Holder Name") : null;
    if (isUpiPayment && clean(formData.get("upi_verified")) !== "1") {
      throw new Error("Verify the UPI ID before submitting the payment request.");
    }
    const contactNo = clean(formData.get("contact_no"));
    const email = clean(formData.get("email"));
    const remarks = clean(formData.get("remarks"));

    const [locationResult, headResult] = await Promise.all([
      admin.from("stations").select("id, station_code, station_email, station_manager_email").eq("id", locationId).eq("company_id", companyId).single(),
      admin
        .from("payment_heads")
        .select("id, code, initial_approval_role_id, initial_approval_role_ids, final_approval_role_id, final_approval_role_ids, payment_process_role_ids, supported_payment_modes, requires_supporting_document, request_expense_approval, expense_approval_threshold, payment_head_questions (id, question_text, answer_type, dropdown_options, is_required, field_stage, sort_order)")
        .eq("id", paymentHeadId)
        .eq("company_id", companyId)
        .single()
    ]);
    if (locationResult.error) throw new Error("Location not found for this company.");
    if (headResult.error) throw new Error("Payment head not found for this company.");
    if (!normalizePaymentModes(headResult.data.supported_payment_modes).includes(paymentMode)) {
      throw new Error("The selected payment method is not supported by this payment head.");
    }

    let verifiedUpiHolderName: string | null = null;
    if (isUpiPayment && paymentReference) {
      const verifiedContact = await admin
        .from("payment_contacts")
        .select("account_holder_name")
        .eq("company_id", companyId)
        .ilike("upi_id", paymentReference)
        .maybeSingle();
      if (verifiedContact.error) throw new Error(verifiedContact.error.message);
      verifiedUpiHolderName = clean(verifiedContact.data?.account_holder_name);
      if (!verifiedUpiHolderName || verifiedUpiHolderName.toUpperCase() !== submittedUpiHolderName?.toUpperCase()) {
        throw new Error("UPI verification has changed. Verify the UPI ID again.");
      }
    }
    const requestedAmount = Number(amountText);
    const expenseApprovalThreshold = headResult.data.expense_approval_threshold == null ? null : Number(headResult.data.expense_approval_threshold);
    if (headResult.data.request_expense_approval && (expenseApprovalThreshold == null || requestedAmount > expenseApprovalThreshold)) {
      throw new Error("Required Expense Approval");
    }
    if (!authorization.hasAllLocationAccess) {
      const userEmail = authorization.email?.trim().toLowerCase() ?? "";
      const locationEmail = locationResult.data.station_email?.trim().toLowerCase();
      const managerEmail = locationResult.data.station_manager_email?.trim().toLowerCase();
      const hasScopedAccess = authorization.locationScopeIds.includes(locationResult.data.id);
      const hasEmailAccess = Boolean(userEmail && (locationEmail === userEmail || managerEmail === userEmail));
      if (!hasScopedAccess && !hasEmailAccess) {
        throw new Error("You can request payment only for your assigned locations.");
      }
    }
    const initialApprovalRoleIds = configuredRoleIds(headResult.data.initial_approval_role_ids, headResult.data.initial_approval_role_id);
    const finalApprovalRoleIds = configuredRoleIds(headResult.data.final_approval_role_ids, headResult.data.final_approval_role_id);
    const paymentProcessRoleIds = (headResult.data.payment_process_role_ids ?? []) as string[];
    if (!finalApprovalRoleIds.length) throw new Error("Final approval role is not configured for this payment head.");
    if (!paymentProcessRoleIds.length) throw new Error("Payment process role is not configured for this payment head.");

    const requestNo = await nextPaymentRequestNo(companyId);
    const workDate = new Date().toISOString().slice(0, 10);
    const legacyAccountValue = bankAccountNo ?? paymentReference ?? paymentPortal ?? locationResult.data.station_code;
    const legacyIfscValue = ifsc ?? (isUpiPayment ? "UPI" : "ONLINE");
    const legacyHolderValue = accountHolderName ?? verifiedUpiHolderName ?? paymentPortal ?? "Online Payment";
    const startsWithFinalApproval = !initialApprovalRoleIds.length;
    const currentApprovalRoleIds = startsWithFinalApproval ? finalApprovalRoleIds : initialApprovalRoleIds;
    const approver = await approverForRoles(
      companyId,
      currentApprovalRoleIds,
      startsWithFinalApproval ? "final approver roles" : "initial approver roles"
    );
    const paymentQuestions = questionsForStage(headResult.data.payment_head_questions, "payment");
    const fileQuestions = paymentQuestions.filter((question) => question.answer_type === "file");
    for (const question of fileQuestions) {
      const file = formData.get(`files[${question.id}]`);
      if (file instanceof File && file.size > 0) validateQuestionFile(file, question);
      if (question.is_required && !(file instanceof File && file.size > 0)) {
        throw new Error("Required file upload is missing.");
      }
    }

    const requestPayload = withCompany({
      request_no: requestNo,
      location_id: locationResult.data.id,
      location_code: locationResult.data.station_code,
      station_code: locationResult.data.station_code,
      payment_head_id: paymentHeadId,
      work_date: workDate,
      requested_for_name: locationResult.data.station_code,
      amount: requestedAmount,
      amount_requested: requestedAmount,
      payment_mode: paymentMode,
      payment_portal: paymentPortal,
      payment_reference: paymentReference,
      bank_account_no: legacyAccountValue,
      ifsc: legacyIfscValue,
      account_holder_name: legacyHolderValue,
      beneficiary_account_no: legacyAccountValue,
      beneficiary_account_number: legacyAccountValue,
      beneficiary_ifsc: legacyIfscValue,
      beneficiary_account_holder: legacyHolderValue,
      contact_no: contactNo,
      email,
      remarks,
      status: "pending",
      approval_status: "PENDING",
      current_step_order: startsWithFinalApproval ? 2 : 1,
      current_approver_user_id: approver.userId,
      current_approver_role_id: approver.roleId,
      current_approver_role_ids: currentApprovalRoleIds,
      final_approval_role_id: finalApprovalRoleIds[0],
      final_approval_role_ids: finalApprovalRoleIds,
      payment_process_role_ids: paymentProcessRoleIds,
      requested_by: authorization.userId
    }, companyId) as Record<string, unknown>;

    const legacyColumnValues: Record<string, unknown> = {
      category: "expense",
      station_code: locationResult.data.station_code,
      work_date: workDate,
      requested_for_name: locationResult.data.station_code,
      amount_requested: requestedAmount,
      payment_mode: paymentMode,
      payment_portal: paymentPortal,
      payment_reference: paymentReference,
      bank_account_no: legacyAccountValue,
      ifsc: legacyIfscValue,
      account_holder_name: legacyHolderValue,
      beneficiary_account_no: legacyAccountValue,
      beneficiary_account_number: legacyAccountValue,
      beneficiary_ifsc: legacyIfscValue,
      beneficiary_account_holder: legacyHolderValue
    };
    const legacyCategoryFallbacks = ["expense", "other", "advance", "reimbursement", "fuel", "location_expense"];

    const legacyValueForMissingColumn = (column: string): unknown => {
      const name = column.toLowerCase();
      if (name.includes("amount")) return Number(amountText);
      if (name.includes("payment_mode")) return paymentMode;
      if (name.includes("payment_portal") || name.includes("portal")) return paymentPortal ?? "";
      if (name.includes("payment_reference")) return paymentReference ?? "";
      if (name.includes("ifsc")) return legacyIfscValue;
      if (name.includes("account_holder") || name.includes("beneficiary_name") || name.includes("holder")) return legacyHolderValue;
      if (name.includes("account")) return legacyAccountValue;
      if (name.includes("work_date") || name.endsWith("_date") || name.includes("date")) return workDate;
      if (name.includes("station") || name.includes("location")) return locationResult.data.station_code;
      if (name.includes("requested_for") || name.includes("beneficiary")) return locationResult.data.station_code;
      if (name.includes("category")) return "expense";
      if (name.includes("head")) return headResult.data.code;
      if (name.includes("status")) return name.includes("approval") ? "PENDING" : "pending";
      if (name.includes("email")) return email ?? authorization.email ?? "not-provided@example.com";
      if (name.includes("contact") || name.includes("mobile") || name.includes("phone")) return contactNo ?? "0";
      if (name.includes("remarks") || name.includes("description") || name.includes("purpose")) return remarks ?? headResult.data.code;
      if (name === "requested_by" || name.includes("user_id")) return authorization.userId;
      if (name.includes("role_id")) return approver.roleId ?? finalApprovalRoleIds[0];
      if (name.endsWith("_id")) {
        if (name.includes("company")) return companyId;
        if (name.includes("payment_head")) return paymentHeadId;
        if (name.includes("location") || name.includes("station")) return locationResult.data.id;
        return authorization.userId;
      }
      return locationResult.data.station_code;
    };

    let request: { id: string } | null = null;
    const filledLegacyColumns = new Set<string>();
    let categoryFallbackIndex = 0;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const { data, error } = await admin
        .from("payment_requests")
        .insert(requestPayload)
        .select("id")
        .single();
      if (!error) {
        request = data;
        break;
      }
      if (isCategoryCheckError(error.message) && categoryFallbackIndex < legacyCategoryFallbacks.length - 1) {
        categoryFallbackIndex += 1;
        requestPayload.category = legacyCategoryFallbacks[categoryFallbackIndex];
        continue;
      }
      if (isCategoryCheckError(error.message) && "category" in requestPayload) {
        delete requestPayload.category;
        continue;
      }
      const missingSchemaColumn = schemaMissingColumn(error.message);
      if (missingSchemaColumn && missingSchemaColumn in requestPayload) {
        delete requestPayload[missingSchemaColumn];
        continue;
      }
      const missingColumn = missingNotNullColumn(error.message);
      if (!missingColumn || filledLegacyColumns.has(missingColumn)) {
        throw new Error(error.message);
      }
      filledLegacyColumns.add(missingColumn);
      requestPayload[missingColumn] = legacyColumnValues[missingColumn] ?? legacyValueForMissingColumn(missingColumn);
    }
    if (!request) throw new Error("Unable to save payment request after filling legacy required fields.");

    await insertPaymentApprovalLog(withCompany({
      payment_request_id: request.id,
      request_id: request.id,
      approver_user_id: authorization.userId,
      approver_role_id: authorization.roleId,
      approval_cycle: 1,
      action: "created",
      comments: remarks || "Payment request created."
    }, companyId), companyId);

    const questionIds = formData.getAll("question_ids").map((value) => String(value));
    if (questionIds.length) {
      const questionById = new Map(paymentQuestions.map((question) => [question.id, question]));
      const answers = await Promise.all(questionIds.map(async (questionId) => {
        const question = questionById.get(questionId);
        if (question?.answer_type === "file") {
          const file = formData.get(`files[${questionId}]`);
          if (file instanceof File && file.size > 0) {
            validateQuestionFile(file, question);
            const path = `${companyId}/${request.id}/${questionId}/${Date.now()}-${safeFileName(file.name)}`;
            const { error: uploadError } = await admin.storage.from("payment-request-documents").upload(path, file, { upsert: false });
            if (uploadError) throw new Error(uploadError.message);
            return withCompany({
              payment_request_id: request.id,
              question_id: questionId,
              answer_value: file.name,
              file_path: path,
              file_name: file.name,
              file_size: file.size
            }, companyId);
          }
          return withCompany({
            payment_request_id: request.id,
            question_id: questionId,
            answer_value: null,
            file_path: null,
            file_name: null,
            file_size: null
          }, companyId);
        }

        return withCompany({
          payment_request_id: request.id,
          question_id: questionId,
          answer_value: clean(formData.get(`answers[${questionId}]`)),
          file_path: null,
          file_name: null,
          file_size: null
        }, companyId);
      }));
      const { error: answersError } = await admin.from("payment_request_answers").insert(answers);
      if (answersError) throw new Error(answersError.message);
    }

    revalidatePath("/payments/requests");
    revalidatePath("/payments/approvals");
    revalidatePath("/payments/report");
    const emailResult = await sendPaymentNotification({
      actorUserId: authorization.userId,
      companyId,
      eventType: "payment_request",
      remarks,
      requestId: request.id
    });
    if (!emailResult.sent) {
      paymentRequestsRedirect({
        paymentNotice: paymentEmailNotice("Payment request submitted successfully.", emailResult.reason)
      });
    }
  } catch (error) {
    paymentRequestsRedirect({
      paymentError: paymentRequestErrorMessage(error)
    });
  }

  paymentRequestsRedirect({ paymentNotice: "Payment request submitted successfully." });
}

export async function submitPaymentBankDetails(formData: FormData) {
  const authorization = await requirePagePermission("payment_requests", "add");
  const companyId = requireCompanyId(authorization);
  const returnToExpense = clean(formData.get("return_to")) === "expense";
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");
    const admin = supabaseAdmin;
    const requestId = required(formData.get("request_id"), "Payment request");
    const amountText = required(formData.get("amount"), "Actual Amount");
    const paymentModeValue = clean(formData.get("payment_mode"));
    if (paymentModeValue !== "account_transfer" && paymentModeValue !== "upi_payment" && paymentModeValue !== "online_payment") {
      throw new Error("Select a supported payment method.");
    }
    const paymentMode = paymentModeValue as PaymentMode;
    const isAccountTransfer = paymentMode === "account_transfer";
    const bankAccountNo = isAccountTransfer ? required(formData.get("bank_account_no"), "Bank Account No").toUpperCase() : null;
    const ifsc = isAccountTransfer ? required(formData.get("ifsc"), "IFSC").toUpperCase() : null;
    const submittedHolderName = isAccountTransfer ? required(formData.get("account_holder_name"), "Acc Holder Name") : null;
    const upiId = paymentMode === "upi_payment" ? required(formData.get("upi_id"), "UPI ID") : null;
    const submittedUpiHolderName = paymentMode === "upi_payment" ? required(formData.get("upi_account_holder_name"), "UPI Account Holder Name") : null;
    const paymentPortal = paymentMode === "online_payment" ? required(formData.get("payment_portal"), "Payment Portal") : null;
    const onlineReference = paymentMode === "online_payment" ? clean(formData.get("payment_reference")) : null;
    if (isAccountTransfer && clean(formData.get("bank_verified")) !== "1") {
      throw new Error("Verify the bank account before submitting payment details.");
    }
    if (paymentMode === "upi_payment" && clean(formData.get("upi_verified")) !== "1") {
      throw new Error("Verify the UPI ID before submitting payment details.");
    }
    if (bankAccountNo && !/^[A-Z0-9]{4,30}$/.test(bankAccountNo)) throw new Error("Invalid bank account number.");
    if (ifsc && !/^[A-Z0-9]{11}$/.test(ifsc)) throw new Error("Invalid IFSC.");
    if (upiId && !/^[A-Z0-9._-]{2,256}@[A-Z0-9.-]{2,64}$/i.test(upiId)) throw new Error("Invalid UPI ID.");
    const contactNo = clean(formData.get("contact_no"));
    const email = clean(formData.get("email"));
    const remarks = clean(formData.get("remarks"));

    const { data: request, error: requestError } = await admin
      .from("payment_requests")
      .select("id, location_id, payment_head_id, requested_by, status, approval_status, current_approver_user_id, current_approver_role_id, current_approver_role_ids")
      .eq("id", requestId)
      .eq("company_id", companyId)
      .single();
    if (requestError || !request) throw new Error("Payment request not found.");
    if (!canAccessPaymentLocation(authorization, request.location_id)) {
      throw new Error("You do not have access to this request location.");
    }
    if (request.requested_by !== authorization.userId) throw new Error("Only the initiator can submit bank details.");

    let accountHolderName: string | null = null;
    if (isAccountTransfer && bankAccountNo && ifsc) {
      const verifiedContact = await admin
        .from("payment_contacts")
        .select("account_holder_name")
        .eq("company_id", companyId)
        .ilike("bank_account_no", bankAccountNo)
        .ilike("ifsc", ifsc)
        .maybeSingle();
      if (verifiedContact.error) throw new Error(verifiedContact.error.message);
      if (!verifiedContact.data?.account_holder_name) {
        throw new Error("Verify the bank account before submitting payment details.");
      }
      accountHolderName = String(verifiedContact.data.account_holder_name).trim();
      if (!accountHolderName || accountHolderName.toUpperCase() !== submittedHolderName?.trim().toUpperCase()) {
        throw new Error("Bank verification has changed. Verify the account again.");
      }
    }
    if (paymentMode === "upi_payment" && upiId) {
      const verifiedContact = await admin
        .from("payment_contacts")
        .select("account_holder_name")
        .eq("company_id", companyId)
        .ilike("upi_id", upiId)
        .maybeSingle();
      if (verifiedContact.error) throw new Error(verifiedContact.error.message);
      accountHolderName = clean(verifiedContact.data?.account_holder_name);
      if (!accountHolderName || accountHolderName.toUpperCase() !== submittedUpiHolderName?.toUpperCase()) {
        throw new Error("UPI verification has changed. Verify the UPI ID again.");
      }
    }

    const status = String(request.status ?? "").toUpperCase();
    const approvalStatus = String(request.approval_status ?? "").toUpperCase();
    const isRejectedOrReturned = ["REJECTED", "RETURNED", "CANCELLED"].includes(status) || ["REJECTED", "RETURNED", "CANCELLED"].includes(approvalStatus);
    const isAlreadyProcessing = ["PROCESSING", "PROCESSED"].includes(status) || ["PROCESSING", "PROCESSED"].includes(approvalStatus);
    const isApproved = status === "APPROVED" ||
      approvalStatus === "APPROVED" ||
      status === "OWNER_APPROVED" ||
      approvalStatus === "OWNER_APPROVED" ||
      (approvalStatus.endsWith("_APPROVED") && !request.current_approver_user_id && !request.current_approver_role_id && !(request.current_approver_role_ids?.length));
    if (!isApproved || isRejectedOrReturned || isAlreadyProcessing) {
      throw new Error("Bank details can be submitted only after final approval.");
    }

    const { data: headData, error: headError } = await admin
      .from("payment_heads")
      .select("id, supported_payment_modes, payment_head_questions (id, question_text, answer_type, dropdown_options, is_required, field_stage, sort_order)")
      .eq("id", request.payment_head_id)
      .eq("company_id", companyId)
      .single();
    if (headError || !headData) throw new Error("Payment head not found for this company.");
    if (!normalizePaymentModes(headData.supported_payment_modes).includes(paymentMode)) {
      throw new Error("The selected payment method is not supported by this payment head.");
    }

    const paymentQuestions = questionsForStage(headData.payment_head_questions, "payment");
    const questionIds = formData.getAll("question_ids").map((value) => String(value));
    const questionById = new Map(paymentQuestions.map((question) => [question.id, question]));
    const questionAnswers = await Promise.all(questionIds.map(async (questionId) => {
      const question = questionById.get(questionId);
      if (!question) return null;
      if (question.answer_type === "file") {
        const file = formData.get(`files[${questionId}]`);
        if (file instanceof File && file.size > 0) {
          validateQuestionFile(file, question);
          const path = `${companyId}/${request.id}/${questionId}/${Date.now()}-${safeFileName(file.name)}`;
          const { error: uploadError } = await admin.storage.from("payment-request-documents").upload(path, file, { upsert: false });
          if (uploadError) throw new Error(uploadError.message);
          return withCompany({
            payment_request_id: request.id,
            question_id: questionId,
            answer_value: file.name,
            file_path: path,
            file_name: file.name,
            file_size: file.size
          }, companyId);
        }
        if (question.is_required) throw new Error("Required file upload is missing.");
        return withCompany({
          payment_request_id: request.id,
          question_id: questionId,
          answer_value: null,
          file_path: null,
          file_name: null,
          file_size: null
        }, companyId);
      }

      const answerValue = clean(formData.get(`answers[${questionId}]`));
      if (question.is_required && !answerValue) throw new Error("Required payment detail is missing.");
      return withCompany({
        payment_request_id: request.id,
        question_id: questionId,
        answer_value: answerValue,
        file_path: null,
        file_name: null,
        file_size: null
      }, companyId);
    }));
    const answersToSave = questionAnswers.filter((answer): answer is Exclude<(typeof questionAnswers)[number], null> => Boolean(answer));
    if (answersToSave.length) {
      const { error: deleteAnswersError } = await admin
        .from("payment_request_answers")
        .delete()
        .eq("company_id", companyId)
        .eq("payment_request_id", request.id)
        .in("question_id", answersToSave.map((answer) => String(answer.question_id)));
      if (deleteAnswersError) throw new Error(deleteAnswersError.message);
      const { error: answersError } = await admin.from("payment_request_answers").insert(answersToSave);
      if (answersError) throw new Error(answersError.message);
    }

    const { error: updateError } = await admin
      .from("payment_requests")
      .update({
        amount: Number(amountText),
        payment_mode: paymentMode,
        payment_portal: paymentMode === "upi_payment" ? "UPI" : paymentPortal,
        payment_reference: upiId ?? onlineReference,
        bank_account_no: bankAccountNo,
        ifsc,
        account_holder_name: accountHolderName,
        beneficiary_account_no: bankAccountNo,
        beneficiary_account_number: bankAccountNo,
        beneficiary_ifsc: ifsc,
        beneficiary_account_holder: accountHolderName,
        contact_no: contactNo,
        email,
        remarks,
        status: "approved",
        approval_status: "APPROVED",
        updated_at: new Date().toISOString()
      })
      .eq("id", request.id)
      .eq("company_id", companyId);
    if (updateError) throw new Error(updateError.message);

    revalidatePath("/payments/requests");
    revalidatePath("/payments/expense-request");
    revalidatePath("/payments/process");
    revalidatePath("/payments/report");
  } catch (error) {
    if (returnToExpense) {
      expenseRequestsRedirect({
        expenseError: paymentRequestErrorMessage(error)
      });
    }
    paymentRequestsRedirect({
      paymentError: paymentRequestErrorMessage(error)
    });
  }

  if (returnToExpense) {
    expenseRequestsRedirect({ expenseNotice: "Payment details submitted for payment processing." });
  }
  paymentRequestsRedirect({ paymentNotice: "Payment details submitted for payment processing." });
}

export async function resubmitExpenseRequest(formData: FormData) {
  const authorization = await requirePagePermission("expense_requests", "add");
  const companyId = requireCompanyId(authorization);
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");
    const admin = supabaseAdmin;
    const requestId = required(formData.get("request_id"), "Expense request");
    const amountText = required(formData.get("amount"), "Estimated Amount");
    const remarks = required(formData.get("remarks"), "Remarks");

    const { data: request, error: requestError } = await admin
      .from("payment_requests")
      .select("id, location_id, payment_head_id, requested_by, status, approval_status, approval_cycle")
      .eq("id", requestId)
      .eq("company_id", companyId)
      .single();
    if (requestError || !request) throw new Error("Expense request not found.");
    if (!canAccessPaymentLocation(authorization, request.location_id)) {
      throw new Error("You do not have access to this request location.");
    }
    if (request.requested_by !== authorization.userId) {
      throw new Error("Only the initiator can resubmit a returned request.");
    }

    const [locationResult, headResult, returnedApprovalResult] = await Promise.all([
      admin.from("stations").select("id, station_code").eq("id", request.location_id).eq("company_id", companyId).single(),
      admin
        .from("payment_heads")
        .select("id, initial_approval_role_id, initial_approval_role_ids, final_approval_role_id, final_approval_role_ids, payment_head_questions (id, question_text, answer_type, dropdown_options, is_required, field_stage, sort_order)")
        .eq("id", request.payment_head_id)
        .eq("company_id", companyId)
        .single(),
      admin
        .from("payment_request_approvals")
        .select("action, approver_user_id, approver_role_id, created_at")
        .eq("company_id", companyId)
        .or(`payment_request_id.eq.${request.id},request_id.eq.${request.id}`)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
    ]);
    if (locationResult.error) throw new Error("Location not found for this company.");
    if (headResult.error) throw new Error("Payment head not found for this company.");
    const normalizedApprovalStatus = String(request.approval_status ?? "").toUpperCase();
    const normalizedStatus = String(request.status ?? "").toLowerCase();
    const latestReturnedApproval = String(returnedApprovalResult.data?.action ?? "").toLowerCase() === "returned"
      ? returnedApprovalResult.data
      : null;
    if (normalizedApprovalStatus !== "RETURNED" && normalizedStatus !== "returned" && !latestReturnedApproval) {
      throw new Error("Only returned requests can be resubmitted.");
    }

    const initialApprovalRoleIds = configuredRoleIds(headResult.data.initial_approval_role_ids, headResult.data.initial_approval_role_id);
    const finalApprovalRoleIds = configuredRoleIds(headResult.data.final_approval_role_ids, headResult.data.final_approval_role_id);
    if (!finalApprovalRoleIds.length) throw new Error("Final approval role is not configured for this payment head.");

    let approver: ApproverTarget;
    let currentApprovalRoleIds: string[];
    let currentApprovalStep: number;
    if (latestReturnedApproval?.approver_user_id) {
      approver = {
        userId: latestReturnedApproval.approver_user_id,
        roleId: latestReturnedApproval.approver_role_id ?? null
      };
      currentApprovalRoleIds = latestReturnedApproval.approver_role_id ? [latestReturnedApproval.approver_role_id] : [];
      currentApprovalStep = initialApprovalRoleIds.includes(latestReturnedApproval.approver_role_id ?? "") ? 1 : 2;
    } else {
      const startsWithFinalApproval = !initialApprovalRoleIds.length;
      currentApprovalRoleIds = startsWithFinalApproval ? finalApprovalRoleIds : initialApprovalRoleIds;
      currentApprovalStep = startsWithFinalApproval ? 2 : 1;
      approver = await approverForRoles(
        companyId,
        currentApprovalRoleIds,
        startsWithFinalApproval ? "final approver roles" : "initial approver roles"
      );
    }

    const { data: existingAnswers, error: existingAnswersError } = await admin
      .from("payment_request_answers")
      .select("id, question_id, file_name")
      .eq("company_id", companyId)
      .eq("payment_request_id", request.id);
    if (existingAnswersError) throw new Error(existingAnswersError.message);
    const existingAnswerByQuestionId = new Map((existingAnswers ?? []).map((answer) => [answer.question_id, answer]));
    const expenseQuestions = questionsForStage(headResult.data.payment_head_questions, "expense");
    const questionById = new Map(expenseQuestions.map((question) => [question.id, question]));

    for (const questionId of formData.getAll("question_ids").map(String)) {
      const question = questionById.get(questionId);
      if (!question) continue;
      const existingAnswer = existingAnswerByQuestionId.get(questionId);
      const answerPayload = withCompany({
        payment_request_id: request.id,
        question_id: questionId,
        updated_at: new Date().toISOString()
      }, companyId) as Record<string, unknown>;

      if (question.answer_type === "file") {
        const file = formData.get(`files[${questionId}]`);
        if (file instanceof File && file.size > 0) {
          validateQuestionFile(file, question);
          const path = `${companyId}/${request.id}/${questionId}/${Date.now()}-${safeFileName(file.name)}`;
          const { error: uploadError } = await admin.storage.from("payment-request-documents").upload(path, file, { upsert: false });
          if (uploadError) throw new Error(uploadError.message);
          answerPayload.answer_value = file.name;
          answerPayload.file_path = path;
          answerPayload.file_name = file.name;
          answerPayload.file_size = file.size;
        } else if (question.is_required && !existingAnswer?.file_name) {
          throw new Error("Required file upload is missing.");
        } else {
          continue;
        }
      } else {
        const answerValue = clean(formData.get(`answers[${questionId}]`));
        if (question.is_required && !answerValue) throw new Error("A required expense detail is missing.");
        answerPayload.answer_value = answerValue;
        answerPayload.file_path = null;
        answerPayload.file_name = null;
        answerPayload.file_size = null;
      }

      const answerWrite = existingAnswer
        ? await admin.from("payment_request_answers").update(answerPayload).eq("id", existingAnswer.id).eq("company_id", companyId)
        : await admin.from("payment_request_answers").insert(answerPayload);
      if (answerWrite.error) throw new Error(answerWrite.error.message);
    }

    const nextApprovalCycle = (Number(request.approval_cycle) || 1) + 1;
    const { error: updateError } = await admin
      .from("payment_requests")
      .update({
        location_code: locationResult.data.station_code,
        station_code: locationResult.data.station_code,
        amount: null,
        amount_requested: Number(amountText),
        remarks,
        status: "resubmitted",
        approval_status: "RESUBMITTED",
        approval_cycle: nextApprovalCycle,
        current_step_order: currentApprovalStep,
        current_approver_user_id: approver.userId,
        current_approver_role_id: approver.roleId,
        current_approver_role_ids: currentApprovalRoleIds,
        updated_at: new Date().toISOString()
      })
      .eq("id", request.id)
      .eq("company_id", companyId);
    if (updateError) throw new Error(updateError.message);

    await insertPaymentApprovalLog(withCompany({
      payment_request_id: request.id,
      request_id: request.id,
      approver_user_id: authorization.userId,
      approver_role_id: authorization.roleId,
      approval_cycle: nextApprovalCycle,
      action: "resubmitted",
      comments: remarks
    }, companyId), companyId);

    revalidatePath("/payments/expense-request");
    revalidatePath("/payments/approvals");
    revalidatePath("/payments/report");
  } catch (error) {
    expenseRequestsRedirect({ expenseError: paymentRequestErrorMessage(error) });
  }

  expenseRequestsRedirect({ expenseNotice: "Expense request resubmitted for approval." });
}

export async function resubmitPaymentRequest(formData: FormData) {
  const authorization = await requirePagePermission("payment_requests", "add");
  const companyId = requireCompanyId(authorization);
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");
    const admin = supabaseAdmin;
    const requestId = required(formData.get("request_id"), "Payment request");
    const amountText = required(formData.get("amount"), "Amount");
    const bankAccountNo = required(formData.get("bank_account_no"), "Bank Account No");
    const ifsc = required(formData.get("ifsc"), "IFSC");
    const accountHolderName = required(formData.get("account_holder_name"), "Acc Holder Name");
    const contactNo = clean(formData.get("contact_no"));
    const email = clean(formData.get("email"));
    const remarks = required(formData.get("remarks"), "Remarks");

    const { data: request, error: requestError } = await admin
      .from("payment_requests")
      .select("id, location_id, payment_head_id, requested_by, status, approval_status, approval_cycle, processed_at, utr_cin")
      .eq("id", requestId)
      .eq("company_id", companyId)
      .single();
    if (requestError || !request) throw new Error("Payment request not found.");
    if (!canAccessPaymentLocation(authorization, request.location_id)) {
      throw new Error("You do not have access to this request location.");
    }
    if (request.requested_by !== authorization.userId) throw new Error("Only the initiator can resubmit a returned request.");
    const wasReturnedAfterProcessing = Boolean(
      (request as { processed_at?: string | null; utr_cin?: string | null }).processed_at ||
      (request as { utr_cin?: string | null }).utr_cin
    );
    const nextApprovalCycle = (Number(request.approval_cycle) || 1) + 1;

    const [locationResult, headResult, returnedApprovalResult] = await Promise.all([
      admin.from("stations").select("id, station_code, station_manager_email").eq("id", request.location_id).eq("company_id", companyId).single(),
      admin
        .from("payment_heads")
        .select("id, code, initial_approval_role_id, initial_approval_role_ids, final_approval_role_id, final_approval_role_ids, payment_process_role_ids, payment_head_questions (id, question_text, answer_type, dropdown_options, is_required, field_stage, sort_order)")
        .eq("id", request.payment_head_id)
        .eq("company_id", companyId)
        .single(),
      admin
        .from("payment_request_approvals")
        .select("action, approver_user_id, approver_role_id, approval_cycle, created_at")
        .eq("company_id", companyId)
        .or(`payment_request_id.eq.${request.id},request_id.eq.${request.id}`)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
    ]);
    if (locationResult.error) throw new Error("Location not found for this company.");
    if (headResult.error) throw new Error("Payment head not found for this company.");

    const normalizedApprovalStatus = String(request.approval_status ?? "").toUpperCase();
    const normalizedStatus = String(request.status ?? "").toLowerCase();
    const latestReturnedApproval =
      String(returnedApprovalResult.data?.action ?? "").toLowerCase() === "returned"
        ? returnedApprovalResult.data
        : null;
    if (
      normalizedApprovalStatus !== "RETURNED" &&
      normalizedStatus !== "returned" &&
      !latestReturnedApproval
    ) {
      throw new Error("Only returned requests can be resubmitted.");
    }

    let approver: { userId: string | null; roleId: string | null } = { userId: null, roleId: null };
    let currentApprovalRoleIds: string[] = [];
    let currentApprovalStep = 1;
    if (!wasReturnedAfterProcessing) {
      const initialApprovalRoleIds = configuredRoleIds(headResult.data.initial_approval_role_ids, headResult.data.initial_approval_role_id);
      const finalApprovalRoleIds = configuredRoleIds(headResult.data.final_approval_role_ids, headResult.data.final_approval_role_id);
      if (!finalApprovalRoleIds.length) throw new Error("Final approval role is not configured for this payment head.");

      const returnedApproval = latestReturnedApproval;
      if (returnedApproval?.approver_user_id) {
        approver = {
          userId: returnedApproval.approver_user_id,
          roleId: returnedApproval.approver_role_id ?? null
        };
        currentApprovalRoleIds = returnedApproval.approver_role_id ? [returnedApproval.approver_role_id] : [];
        currentApprovalStep = initialApprovalRoleIds.includes(returnedApproval.approver_role_id ?? "") ? 1 : 2;
      } else {
        const startsWithFinalApproval = !initialApprovalRoleIds.length;
        currentApprovalRoleIds = startsWithFinalApproval ? finalApprovalRoleIds : initialApprovalRoleIds;
        currentApprovalStep = startsWithFinalApproval ? 2 : 1;
        approver = await approverForRoles(
          companyId,
          currentApprovalRoleIds,
          startsWithFinalApproval ? "final approver roles" : "initial approver roles"
        );
      }
    }

    const { data: existingAnswers } = await admin
      .from("payment_request_answers")
      .select("id, question_id, file_name")
      .eq("company_id", companyId)
      .eq("payment_request_id", request.id);
    const existingAnswerByQuestionId = new Map((existingAnswers ?? []).map((answer) => [answer.question_id, answer]));

    const questionIds = formData.getAll("question_ids").map((value) => String(value));
    if (questionIds.length) {
      const paymentQuestions = questionsForStage(headResult.data.payment_head_questions, "payment");
      const questionById = new Map(paymentQuestions.map((question) => [question.id, question]));
      for (const questionId of questionIds) {
        const question = questionById.get(questionId);
        if (!question) continue;
        const existingAnswer = existingAnswerByQuestionId.get(questionId);
        const answerPayload = withCompany({
          payment_request_id: request.id,
          question_id: questionId,
          updated_at: new Date().toISOString()
        }, companyId) as Record<string, unknown>;

        if (question.answer_type === "file") {
          const file = formData.get(`files[${questionId}]`);
          if (file instanceof File && file.size > 0) {
            validateQuestionFile(file, question);
            const path = `${companyId}/${request.id}/${questionId}/${Date.now()}-${safeFileName(file.name)}`;
            const { error: uploadError } = await admin.storage.from("payment-request-documents").upload(path, file, { upsert: false });
            if (uploadError) throw new Error(uploadError.message);
            answerPayload.answer_value = file.name;
            answerPayload.file_path = path;
            answerPayload.file_name = file.name;
            answerPayload.file_size = file.size;
          } else if (question.is_required && !existingAnswer?.file_name) {
            throw new Error("Required file upload is missing.");
          } else {
            continue;
          }
        } else {
          answerPayload.answer_value = clean(formData.get(`answers[${questionId}]`));
          answerPayload.file_path = null;
          answerPayload.file_name = null;
          answerPayload.file_size = null;
        }

        const answerWrite = existingAnswer
          ? await admin.from("payment_request_answers").update(answerPayload).eq("id", existingAnswer.id).eq("company_id", companyId)
          : await admin.from("payment_request_answers").insert(answerPayload);
        if (answerWrite.error) throw new Error(answerWrite.error.message);
      }
    }

    const statusPayload = wasReturnedAfterProcessing
      ? {
        status: "processed",
        approval_status: "PROCESSED",
        bank_status: "Paid",
        current_step_order: null,
        current_approver_user_id: null,
        current_approver_role_id: null,
        current_approver_role_ids: []
      }
      : {
        status: "resubmitted",
        approval_status: "RESUBMITTED",
        approval_cycle: nextApprovalCycle,
        current_step_order: currentApprovalStep,
        current_approver_user_id: approver.userId,
        current_approver_role_id: approver.roleId,
        current_approver_role_ids: currentApprovalRoleIds
      };

    const { error: updateError } = await admin
      .from("payment_requests")
      .update({
        location_code: locationResult.data.station_code,
        station_code: locationResult.data.station_code,
        amount: Number(amountText),
        amount_requested: Number(amountText),
        bank_account_no: bankAccountNo,
        ifsc,
        account_holder_name: accountHolderName,
        beneficiary_account_no: bankAccountNo,
        beneficiary_account_number: bankAccountNo,
        beneficiary_ifsc: ifsc,
        beneficiary_account_holder: accountHolderName,
        contact_no: contactNo,
        email,
        remarks,
        ...statusPayload,
        updated_at: new Date().toISOString()
      })
      .eq("id", request.id)
      .eq("company_id", companyId);
    if (updateError) throw new Error(updateError.message);

    if (!wasReturnedAfterProcessing) {
      await insertPaymentApprovalLog(withCompany({
        payment_request_id: request.id,
        request_id: request.id,
        approver_user_id: authorization.userId,
        approver_role_id: authorization.roleId,
        approval_cycle: nextApprovalCycle,
        action: "resubmitted",
        comments: remarks
      }, companyId), companyId);
    }

    revalidatePath("/payments/requests");
    revalidatePath("/payments/approvals");
    revalidatePath("/payments/process");
    revalidatePath("/payments/report");
    const emailResult = await sendPaymentNotification({
      actorUserId: authorization.userId,
      companyId,
      eventType: "payment_request",
      remarks,
      requestId: request.id
    });
    if (!emailResult.sent) {
      paymentRequestsRedirect({
        paymentNotice: paymentEmailNotice("Payment request resubmitted successfully.", emailResult.reason)
      });
    }
  } catch (error) {
    paymentRequestsRedirect({
      paymentError: paymentRequestErrorMessage(error)
    });
  }

  paymentRequestsRedirect({ paymentNotice: "Payment request resubmitted successfully." });
}
