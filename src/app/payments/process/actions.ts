"use server";

import * as XLSX from "xlsx";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { sendPaymentNotification } from "@/lib/payment-email-notifications";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { insertPaymentApprovalLog } from "../approvals/actions";

type BankFinalizeRow = {
  requestNo: string;
  creditAccount: string;
  ifsc: string;
  debitAmount: number;
  status: string;
  utrCin: string;
  remarks: string;
};

type PaymentRequestFinalizeRow = {
  id: string;
  request_no: string;
  amount: number | null;
  amount_requested: number | null;
  payment_mode: string | null;
  bank_account_no: string | null;
  beneficiary_account_no: string | null;
  beneficiary_account_number: string | null;
  ifsc: string | null;
  beneficiary_ifsc: string | null;
  approval_status?: string | null;
  current_approver_user_id?: string | null;
  current_approver_role_id: string | null;
  approval_cycle?: number | null;
};

type PaymentProcessAction = "processing" | "processed" | "returned";

function cleanCell(value: unknown) {
  return String(value ?? "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMatch(value: unknown) {
  return cleanCell(value).replace(/\s+/g, "").toUpperCase();
}

function numberValue(value: unknown) {
  if (typeof value === "number") return value;
  const parsed = Number(cleanCell(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function amountMatches(left: unknown, right: unknown) {
  return Math.round(numberValue(left) * 100) === Math.round(numberValue(right) * 100);
}

function requiredHeader(row: Record<string, unknown>, header: string) {
  return cleanCell(row[header]);
}

function parseBankFinalizeRows(file: File) {
  return file.arrayBuffer().then((buffer) => {
    const workbook = XLSX.read(Buffer.from(buffer), { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) throw new Error("No worksheet found in the uploaded bank file.");

    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, defval: "" });
    const headers = ["Customer Ref. No.", "Credit Account", "IFSC Code", "Debit Amount", "Status", "UTR/CIN", "System Processing Remarks"];
    const headerIndex = rows.findIndex((row) => headers.every((header) => row.map(cleanCell).includes(header)));
    if (headerIndex < 0) throw new Error("Bank file headers were not found. Upload the Transaction Enquiry file downloaded from the bank.");

    const headerRow = rows[headerIndex].map(cleanCell);
    return rows.slice(headerIndex + 1).map((row) => {
      const record = headerRow.reduce<Record<string, unknown>>((acc, header, index) => {
        if (header) acc[header] = row[index] ?? "";
        return acc;
      }, {});
      return {
        requestNo: requiredHeader(record, "Customer Ref. No."),
        creditAccount: requiredHeader(record, "Credit Account"),
        ifsc: requiredHeader(record, "IFSC Code"),
        debitAmount: numberValue(record["Debit Amount"]),
        status: requiredHeader(record, "Status"),
        utrCin: requiredHeader(record, "UTR/CIN"),
        remarks: requiredHeader(record, "System Processing Remarks")
      };
    }).filter((row) => row.requestNo);
  });
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const payload = error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    return [payload.message, payload.details, payload.hint, payload.code]
      .map((part) => String(part ?? "").trim())
      .filter(Boolean)
      .join(" ") || "Unable to finalize payment requests.";
  }
  return String(error || "Unable to finalize payment requests.");
}

function isNextRedirect(error: unknown) {
  return String((error as { digest?: unknown })?.digest ?? error).includes("NEXT_REDIRECT");
}

function processRedirect(params: Record<string, string>): never {
  redirect(`/payments/process?${new URLSearchParams(params).toString()}`);
}

function isMissingColumn(error: unknown, column: string) {
  return String((error as { message?: unknown })?.message ?? "").toLowerCase().includes(`column "${column.toLowerCase()}"`);
}

async function updatePaymentRequest(companyId: string, requestId: string, payload: Record<string, unknown>) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");
  let update = await supabaseAdmin
    .from("payment_requests")
    .update(payload)
    .eq("company_id", companyId)
    .eq("id", requestId);
  if (!update.error) return;

  const fallbackPayload = { ...payload };
  for (const column of ["utr_cin", "bank_status", "bank_processing_remarks", "processed_at"]) {
    if (isMissingColumn(update.error, column)) delete fallbackPayload[column];
  }
  update = await supabaseAdmin
    .from("payment_requests")
    .update(fallbackPayload)
    .eq("company_id", companyId)
    .eq("id", requestId);
  if (update.error) throw new Error(update.error.message);
}

async function nextApprovalSequence(companyId: string, requestId: string) {
  if (!supabaseAdmin) return 1;
  const { data } = await supabaseAdmin
    .from("payment_request_approvals")
    .select("sequence_no")
    .eq("company_id", companyId)
    .or(`payment_request_id.eq.${requestId},request_id.eq.${requestId}`);
  return Math.max(0, ...(data ?? []).map((row) => Number((row as { sequence_no?: unknown }).sequence_no) || 0)) + 1;
}

async function insertBankReturnLog(
  companyId: string,
  request: Pick<PaymentRequestFinalizeRow, "id" | "current_approver_role_id" | "approval_cycle">,
  comments: string,
  actorUserId: string | null,
  actorRoleId: string | null
) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");
  const payload: Record<string, unknown> = {
    company_id: companyId,
    payment_request_id: request.id,
    request_id: request.id,
    approver_user_id: actorUserId,
    approver_role_id: actorRoleId ?? request.current_approver_role_id,
    role_code: "BANK",
    action: "returned",
    comments,
    approval_cycle: request.approval_cycle ?? 1,
    sequence_no: await nextApprovalSequence(companyId, request.id)
  };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { error } = await supabaseAdmin.from("payment_request_approvals").insert(payload);
    if (!error) return;
    const message = errorMessage(error).toLowerCase();
    if (message.includes("column \"request_id\"")) delete payload.request_id;
    else if (message.includes("column \"role_code\"")) delete payload.role_code;
    else if (message.includes("column \"sequence_no\"")) delete payload.sequence_no;
    else if (message.includes("duplicate") && message.includes("sequence_no")) payload.sequence_no = await nextApprovalSequence(companyId, request.id);
    else throw new Error(`Payment approval log was not saved: ${errorMessage(error)}`);
  }
}

function expectedAccount(request: PaymentRequestFinalizeRow) {
  return request.beneficiary_account_number || request.beneficiary_account_no || request.bank_account_no || "";
}

function expectedIfsc(request: PaymentRequestFinalizeRow) {
  return request.beneficiary_ifsc || request.ifsc || "";
}

function expectedAmount(request: PaymentRequestFinalizeRow) {
  return Number(request.amount ?? request.amount_requested ?? 0);
}

function cleanFormText(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

export async function updatePaymentProcessStatus(formData: FormData) {
  try {
    const authorization = await requirePagePermission("payment_process", "edit");
    const companyId = requireCompanyId(authorization);
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");

    const requestId = cleanFormText(formData.get("request_id"));
    const action = cleanFormText(formData.get("process_action")).toLowerCase() as PaymentProcessAction;
    const remarks = cleanFormText(formData.get("process_remarks"));
    if (!requestId) throw new Error("Payment request is missing.");
    if (!["processing", "processed", "returned"].includes(action)) throw new Error("Select a valid process action.");
    if (action === "processed" && !remarks) throw new Error("Enter UTR No to mark this request as processed.");
    if (action === "returned" && !remarks) throw new Error("Enter error remarks to return this request.");

    const { data: request, error } = await supabaseAdmin
      .from("payment_requests")
      .select("id, request_no, approval_status, current_approver_user_id, current_approver_role_id, approval_cycle")
      .eq("company_id", companyId)
      .eq("id", requestId)
      .single();
    if (error || !request) throw new Error("Payment request was not found.");
    if (["RE_APPROVED", "RE_PROCESSING_PENDING"].includes(String(request.approval_status ?? "").toUpperCase()) && request.current_approver_user_id !== authorization.userId) {
      throw new Error("This returned request is assigned to another processor.");
    }

    const now = new Date().toISOString();
    if (action === "processing") {
      await updatePaymentRequest(companyId, requestId, {
        status: "processing",
        approval_status: "PROCESSING",
        updated_at: now
      });
      await insertPaymentApprovalLog({
        company_id: companyId,
        payment_request_id: request.id,
        request_id: request.id,
        approver_user_id: authorization.userId,
        approver_role_id: request.current_approver_role_id,
        approval_cycle: request.approval_cycle ?? 1,
        action: "processing",
        comments: remarks || "Payment processing started."
      }, companyId);
      revalidatePath("/payments/process");
      revalidatePath("/payments/report");
      processRedirect({ processNotice: `${request.request_no} marked as processing.` });
    }

    if (action === "processed") {
      await updatePaymentRequest(companyId, requestId, {
        status: "processed",
        approval_status: "PROCESSED",
        utr_cin: remarks,
        bank_status: "Paid",
        bank_processing_remarks: remarks,
        processed_at: now,
        updated_at: now
      });
      await insertPaymentApprovalLog({
        company_id: companyId,
        payment_request_id: request.id,
        request_id: request.id,
        approver_user_id: authorization.userId,
        approver_role_id: request.current_approver_role_id,
        approval_cycle: request.approval_cycle ?? 1,
        action: "processed",
        comments: `Processed. UTR/CIN: ${remarks}`
      }, companyId);
      revalidatePath("/payments/process");
      revalidatePath("/payments/report");
      processRedirect({ processNotice: `${request.request_no} marked as processed.` });
    }

    await updatePaymentRequest(companyId, requestId, {
      status: "returned",
      approval_status: "RETURNED",
      current_step_order: 3,
      bank_status: "Returned",
      bank_processing_remarks: remarks,
      current_approver_user_id: null,
      current_approver_role_id: null,
      updated_at: now
    });
    await insertBankReturnLog(companyId, request, `Returned: ${remarks}`, authorization.userId, authorization.roleId);
    await sendPaymentNotification({
      actorUserId: authorization.userId,
      companyId,
      eventType: "payment_return",
      remarks,
      requestId
    });
    revalidatePath("/payments/process");
    revalidatePath("/payments/requests");
    revalidatePath("/payments/report");
    processRedirect({ processNotice: `${request.request_no} returned to requester.` });
  } catch (error) {
    if (isNextRedirect(error)) throw error;
    processRedirect({ processError: errorMessage(error) });
  }
}

export async function finalizePaymentProcess(formData: FormData) {
  try {
    const authorization = await requirePagePermission("payment_process", "edit");
    const companyId = requireCompanyId(authorization);
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");

    const file = formData.get("bank_response_file");
    if (!(file instanceof File) || file.size === 0) throw new Error("Upload the bank response Excel file.");

    const bankRows = await parseBankFinalizeRows(file);
    if (!bankRows.length) throw new Error("No payment rows found in the uploaded bank file.");

    const requestNos = Array.from(new Set(bankRows.map((row) => row.requestNo).filter(Boolean)));
    const { data, error } = await supabaseAdmin
      .from("payment_requests")
      .select("id, request_no, amount, amount_requested, payment_mode, bank_account_no, beneficiary_account_no, beneficiary_account_number, ifsc, beneficiary_ifsc, approval_status, current_approver_user_id, current_approver_role_id, approval_cycle")
      .eq("company_id", companyId)
      .in("request_no", requestNos);
    if (error) throw new Error(error.message);

    const requestByNo = new Map(((data ?? []) as PaymentRequestFinalizeRow[])
      .filter((request) => (request.payment_mode ?? "account_transfer") === "account_transfer")
      .map((request) => [normalizeMatch(request.request_no), request]));
    let paidCount = 0;
    let returnedCount = 0;
    let skippedCount = 0;
    const now = new Date().toISOString();

    for (const row of bankRows) {
      const request = requestByNo.get(normalizeMatch(row.requestNo));
      if (!request) {
        skippedCount += 1;
        continue;
      }
      if (["RE_APPROVED", "RE_PROCESSING_PENDING"].includes(String(request.approval_status ?? "").toUpperCase()) && request.current_approver_user_id !== authorization.userId) {
        skippedCount += 1;
        continue;
      }
      const isMatch = normalizeMatch(row.creditAccount) === normalizeMatch(expectedAccount(request)) &&
        normalizeMatch(row.ifsc) === normalizeMatch(expectedIfsc(request)) &&
        amountMatches(row.debitAmount, expectedAmount(request));
      if (!isMatch) {
        skippedCount += 1;
        continue;
      }

      const status = normalizeMatch(row.status);
      if (status === "PAID") {
        await updatePaymentRequest(companyId, request.id, {
          status: "processed",
          approval_status: "PROCESSED",
          utr_cin: row.utrCin || null,
          bank_status: "Paid",
          bank_processing_remarks: row.remarks || null,
          processed_at: now,
          updated_at: now
        });
        await insertPaymentApprovalLog({
          company_id: companyId,
          payment_request_id: request.id,
          request_id: request.id,
          approver_user_id: authorization.userId,
          approver_role_id: request.current_approver_role_id,
          approval_cycle: request.approval_cycle ?? 1,
          action: "processed",
          comments: row.utrCin ? `Processed by bank. UTR/CIN: ${row.utrCin}` : "Processed by bank."
        }, companyId);
        paidCount += 1;
      } else if (status === "CANCELLED" || status === "CANCELED") {
        const remarks = `Payment Failed - ${row.remarks || "Cancelled by bank"}`;
        await updatePaymentRequest(companyId, request.id, {
          status: "returned",
          approval_status: "RETURNED",
          current_step_order: 3,
          bank_status: "Cancelled",
          bank_processing_remarks: row.remarks || null,
          current_approver_user_id: null,
          current_approver_role_id: null,
          updated_at: now
        });
        await insertBankReturnLog(companyId, request, remarks, authorization.userId, authorization.roleId);
        await sendPaymentNotification({
          actorUserId: authorization.userId,
          companyId,
          eventType: "payment_return",
          remarks,
          requestId: request.id
        });
        returnedCount += 1;
      } else {
        skippedCount += 1;
      }
    }

    revalidatePath("/payments/process");
    revalidatePath("/payments/requests");
    revalidatePath("/payments/approvals");
    revalidatePath("/payments/report");
    processRedirect({
      processNotice: `Finalized ${paidCount} paid and ${returnedCount} cancelled payments.${skippedCount ? ` ${skippedCount} rows skipped.` : ""}`
    });
  } catch (error) {
    if (isNextRedirect(error)) throw error;
    processRedirect({ processError: errorMessage(error) });
  }
}
