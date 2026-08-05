"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId, withCompany } from "@/lib/company-scope";
import { serializePaymentFileGroups } from "@/lib/payment-file-types";
import { normalizePaymentModes } from "@/lib/payment-modes";
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

function parseRoleIds(formData: FormData, key: string) {
  const raw = clean(formData.get(key));
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return Array.from(new Set(parsed.map((value) => String(value)).filter(Boolean)));
}

function parsePaymentModes(formData: FormData) {
  const raw = clean(formData.get("supported_payment_modes"));
  const modes = normalizePaymentModes(raw ? JSON.parse(raw) : []);
  if (!modes.length) throw new Error("Select at least one supported payment method.");
  return modes;
}

function parseOptionalAmount(value: FormDataEntryValue | null, field: string) {
  const text = clean(value);
  if (!text) return null;
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`${field} must be zero or more.`);
  return amount;
}

function isRedirectError(error: unknown) {
  const digest = (error as { digest?: unknown })?.digest;
  return typeof digest === "string" && digest.startsWith("NEXT_REDIRECT");
}

function paymentHeadErrorUrl(message: string, editId?: string | null) {
  const params = new URLSearchParams();
  params.set("error", message);
  if (editId) params.set("edit", editId);
  return `/master/payment-heads?${params.toString()}`;
}

async function validateRoleIds(roleIds: string[], companyId: string, field: string) {
  if (!roleIds.length) throw new Error(`${field} is required.`);
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("id")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .in("id", roleIds);
  if (error) throw new Error(error.message);
  if ((data ?? []).length !== roleIds.length) throw new Error(`Select active roles for ${field}.`);
}

function parseQuestions(formData: FormData) {
  const count = Number(formData.get("question_count") ?? 0);
  return Array.from({ length: count }, (_, index) => {
    const id = clean(formData.get(`questions[${index}][id]`));
    const questionText = clean(formData.get(`questions[${index}][question_text]`));
    const answerType = clean(formData.get(`questions[${index}][answer_type]`)) ?? "text";
    const dropdownOptions = clean(formData.get(`questions[${index}][dropdown_options]`));
    const allowedFileTypes = formData
      .getAll(`questions[${index}][allowed_file_types]`)
      .map((value) => String(value))
      .filter((value) => ["image", "video", "document"].includes(value));
    const fieldStage = clean(formData.get(`questions[${index}][field_stage]`)) === "payment" ? "payment" : "expense";
    const isRequired = formData.get(`questions[${index}][is_required]`) === "yes";
    if (!questionText) return null;
    if (!["text", "number", "date", "dropdown", "textarea", "yes_no", "file"].includes(answerType)) {
      throw new Error("Field type is invalid.");
    }
    if (answerType === "dropdown" && !dropdownOptions) {
      throw new Error("Dropdown options are required.");
    }
    if (answerType === "file" && !allowedFileTypes.length) {
      throw new Error(`${questionText}: select at least one supported file type.`);
    }
    return {
      id,
      question_text: questionText,
      answer_type: answerType,
      dropdown_options: answerType === "dropdown"
        ? dropdownOptions
        : answerType === "file"
          ? serializePaymentFileGroups(allowedFileTypes)
          : null,
      field_stage: fieldStage,
      is_required: isRequired,
      sort_order: index + 1
    };
  }).filter(Boolean) as Array<{
    id: string | null;
    question_text: string;
    answer_type: string;
    dropdown_options: string | null;
    field_stage: "expense" | "payment";
    is_required: boolean;
    sort_order: number;
  }>;
}

async function createPaymentHeadUnsafe(formData: FormData) {
  const authorization = await requirePagePermission("master_payment_heads", "add");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");

  const code = required(formData.get("code"), "Payment Head Code").toUpperCase();
  const name = required(formData.get("name"), "Payment Head Name");
  const externalId = clean(formData.get("external_id"));
  const initialApprovalRoleIds = parseRoleIds(formData, "initial_approval_role_ids");
  const finalApprovalRoleIds = parseRoleIds(formData, "final_approval_role_ids");
  const paymentProcessRoleIds = parseRoleIds(formData, "payment_process_role_ids");
  const supportedPaymentModes = parsePaymentModes(formData);
  const requestExpenseApproval = formData.get("request_expense_approval") === "yes";
  const expenseApprovalThreshold = parseOptionalAmount(formData.get("expense_approval_threshold"), "Threshold Limit");
  const questions = parseQuestions(formData);
  if (initialApprovalRoleIds.length) {
    await validateRoleIds(initialApprovalRoleIds, companyId, "Initial Approver Role");
  }
  await validateRoleIds(finalApprovalRoleIds, companyId, "Final Approval User Role");
  await validateRoleIds(paymentProcessRoleIds, companyId, "Payment Process User Role");
  if (initialApprovalRoleIds.some((roleId) => finalApprovalRoleIds.includes(roleId))) {
    throw new Error("Initial and final approver roles must be different.");
  }

  const { data: head, error } = await supabaseAdmin
    .from("payment_heads")
    .insert(withCompany({
      code,
      name,
      external_id: externalId,
      initial_approval_role_id: initialApprovalRoleIds[0] ?? null,
      initial_approval_role_ids: initialApprovalRoleIds,
      final_approval_role_id: finalApprovalRoleIds[0],
      final_approval_role_ids: finalApprovalRoleIds,
      payment_process_role_ids: paymentProcessRoleIds,
      supported_payment_modes: supportedPaymentModes,
      requires_supporting_document: questions.some((question) => question.answer_type === "file"),
      request_expense_approval: requestExpenseApproval,
      expense_approval_threshold: requestExpenseApproval ? expenseApprovalThreshold : null,
      is_active: true
    }, companyId))
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  if (questions.length) {
    const { error: questionError } = await supabaseAdmin.from("payment_head_questions").insert(
      questions.map((question) => {
        const { id: _id, ...questionPayload } = question;
        return withCompany({ ...questionPayload, payment_head_id: head.id }, companyId);
      })
    );
    if (questionError) throw new Error(questionError.message);
  }

  revalidatePath("/master/payment-heads");
}

export async function createPaymentHead(formData: FormData) {
  try {
    await createPaymentHeadUnsafe(formData);
  } catch (error) {
    if (isRedirectError(error)) throw error;
    redirect(paymentHeadErrorUrl(error instanceof Error ? error.message : "Payment head was not saved."));
  }
  redirect("/master/payment-heads?saved=1");
}

async function updatePaymentHeadUnsafe(formData: FormData) {
  const authorization = await requirePagePermission("master_payment_heads", "edit");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");
  const admin = supabaseAdmin;

  const id = required(formData.get("id"), "Payment head");
  const code = required(formData.get("code"), "Payment Head Code").toUpperCase();
  const name = required(formData.get("name"), "Payment Head Name");
  const externalId = clean(formData.get("external_id"));
  const initialApprovalRoleIds = parseRoleIds(formData, "initial_approval_role_ids");
  const finalApprovalRoleIds = parseRoleIds(formData, "final_approval_role_ids");
  const paymentProcessRoleIds = parseRoleIds(formData, "payment_process_role_ids");
  const supportedPaymentModes = parsePaymentModes(formData);
  const requestExpenseApproval = formData.get("request_expense_approval") === "yes";
  const expenseApprovalThreshold = parseOptionalAmount(formData.get("expense_approval_threshold"), "Threshold Limit");
  const isActive = formData.get("is_active") !== "false";
  const questions = parseQuestions(formData);
  if (initialApprovalRoleIds.length) {
    await validateRoleIds(initialApprovalRoleIds, companyId, "Initial Approver Role");
  }
  await validateRoleIds(finalApprovalRoleIds, companyId, "Final Approval User Role");
  await validateRoleIds(paymentProcessRoleIds, companyId, "Payment Process User Role");
  if (initialApprovalRoleIds.some((roleId) => finalApprovalRoleIds.includes(roleId))) {
    throw new Error("Initial and final approver roles must be different.");
  }

  const { error } = await admin
    .from("payment_heads")
    .update({
      code,
      name,
      external_id: externalId,
      initial_approval_role_id: initialApprovalRoleIds[0] ?? null,
      initial_approval_role_ids: initialApprovalRoleIds,
      final_approval_role_id: finalApprovalRoleIds[0],
      final_approval_role_ids: finalApprovalRoleIds,
      payment_process_role_ids: paymentProcessRoleIds,
      supported_payment_modes: supportedPaymentModes,
      requires_supporting_document: questions.some((question) => question.answer_type === "file"),
      request_expense_approval: requestExpenseApproval,
      expense_approval_threshold: requestExpenseApproval ? expenseApprovalThreshold : null,
      is_active: isActive,
      updated_at: new Date().toISOString()
    })
    .eq("id", id)
    .eq("company_id", companyId);
  if (error) throw new Error(error.message);

  const retainedIds = await Promise.all(questions.map(async (question) => {
    const payload = {
      question_text: question.question_text,
      answer_type: question.answer_type,
      dropdown_options: question.dropdown_options,
      field_stage: question.field_stage,
      is_required: question.is_required,
      sort_order: question.sort_order,
      updated_at: new Date().toISOString()
    };
    if (question.id) {
      const { error: updateError } = await admin
        .from("payment_head_questions")
        .update(payload)
        .eq("id", question.id)
        .eq("payment_head_id", id)
        .eq("company_id", companyId);
      if (updateError) throw new Error(updateError.message);
      return question.id;
    }
    const { data, error: insertError } = await admin
      .from("payment_head_questions")
      .insert(withCompany({ ...payload, payment_head_id: id }, companyId))
      .select("id")
      .single();
    if (insertError) throw new Error(insertError.message);
    return data.id as string;
  }));

  const existing = await admin
    .from("payment_head_questions")
    .select("id")
    .eq("payment_head_id", id)
    .eq("company_id", companyId)
    .gt("sort_order", 0);
  if (existing.error) throw new Error(existing.error.message);
  const removed = (existing.data ?? []).map((row) => row.id).filter((questionId) => !retainedIds.includes(questionId));
  if (removed.length) {
    const { error: archiveError } = await admin
      .from("payment_head_questions")
      .update({ sort_order: -1, updated_at: new Date().toISOString() })
      .in("id", removed)
      .eq("company_id", companyId);
    if (archiveError) throw new Error(archiveError.message);
  }

  revalidatePath("/master/payment-heads");
  redirect("/master/payment-heads");
}

export async function updatePaymentHead(formData: FormData) {
  const id = clean(formData.get("id"));
  try {
    await updatePaymentHeadUnsafe(formData);
  } catch (error) {
    if (isRedirectError(error)) throw error;
    redirect(paymentHeadErrorUrl(error instanceof Error ? error.message : "Payment head was not saved.", id));
  }
}
