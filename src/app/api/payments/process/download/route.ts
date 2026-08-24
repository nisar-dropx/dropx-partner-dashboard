import * as XLSX from "xlsx";
import { getAuthorization, hasPermission, isCompanyOwner } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { insertPaymentApprovalLog } from "@/app/payments/approvals/actions";

type PaymentBankRow = {
  id: string;
  bank_code: string;
  display_name: string;
  account_no: string;
  is_active: boolean;
};

type RequestRow = {
  id: string;
  request_no: string;
  location_code: string;
  amount: number | null;
  amount_requested: number | null;
  payment_mode: string | null;
  bank_account_no: string | null;
  beneficiary_account_no: string | null;
  beneficiary_account_number: string | null;
  ifsc: string | null;
  beneficiary_ifsc: string | null;
  account_holder_name: string | null;
  beneficiary_account_holder: string | null;
  email: string | null;
  status: string | null;
  approval_status: string | null;
  current_approver_user_id: string | null;
  current_approver_role_id: string | null;
  payment_process_role_ids: string[] | null;
  payment_heads?: { name: string; code: string; external_id: string | null } | null;
};

function firstRelation<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function formatValueDate(value: string | null) {
  const raw = String(value ?? "").trim();
  const parts = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!parts) throw new Error("Select a valid value date.");
  return `${parts[3]}/${parts[2]}/${parts[1]}`;
}

function safe(value: unknown) {
  return value == null ? "" : String(value);
}

function isReadyForPaymentProcess(request: RequestRow) {
  const status = String(request.status ?? "").toUpperCase();
  const approvalStatus = String(request.approval_status ?? "").toUpperCase();
  const hasCurrentApprover = Boolean(request.current_approver_user_id || request.current_approver_role_id);
  return status === "APPROVED" ||
    status === "PROCESSING" ||
    status === "OWNER_APPROVED" ||
    approvalStatus === "PROCESSING" ||
    approvalStatus === "OWNER_APPROVED" ||
    approvalStatus === "RE_APPROVED" ||
    (approvalStatus.endsWith("_APPROVED") && !hasCurrentApprover);
}

function fedOneRows(requests: RequestRow[], debitAccountNumber: string, valueDate: string) {
  return requests.map((request) => {
    const beneficiaryIfsc = safe(request.beneficiary_ifsc || request.ifsc).trim().toUpperCase();
    const paymentHeadExternalId = request.payment_heads?.external_id ?? "";
    return {
      "Transaction Type": beneficiaryIfsc.startsWith("FDRL") ? "IFT" : "NEFT",
      "Debit Account Number": debitAccountNumber,
      "Transaction Amount": Number(request.amount ?? request.amount_requested ?? 0),
      "Value Date": valueDate,
      "Beneficiary Account Number": safe(request.beneficiary_account_number || request.beneficiary_account_no || request.bank_account_no),
      "Beneficiary Name": safe(request.beneficiary_account_holder || request.account_holder_name),
      "IFSC Code": beneficiaryIfsc,
      "Beneficiary Email ID": safe(request.email),
      "Beneficiary ID": "",
      "Credit Remarks": request.location_code,
      "Debit Remarks": paymentHeadExternalId,
      "Unique Customer Reference Number": request.request_no
    };
  });
}

function parseRequestIds(value: string | null) {
  return Array.from(new Set(String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)));
}

async function markRequestsProcessing(companyId: string, requestIds: string[], actorUserId: string | null) {
  if (!requestIds.length || !supabaseAdmin) return;
  const now = new Date().toISOString();
  const payload = {
    status: "processing",
    approval_status: "PROCESSING",
    processing_started_at: now,
    updated_at: now
  };
  const { error } = await supabaseAdmin
    .from("payment_requests")
    .update(payload)
    .eq("company_id", companyId)
    .in("id", requestIds);
  if (error) {
    const fallback = await supabaseAdmin
      .from("payment_requests")
      .update({
        approval_status: "PROCESSING",
        updated_at: payload.updated_at
      })
      .eq("company_id", companyId)
      .in("id", requestIds);
    if (fallback.error) throw new Error(fallback.error.message);
  }

  await Promise.all(requestIds.map((requestId) => insertPaymentApprovalLog({
    company_id: companyId,
    payment_request_id: requestId,
    request_id: requestId,
    approver_user_id: actorUserId,
    action: "processing",
    comments: "Bank transfer file generated; payment moved to processing."
  }, companyId)));
}

export async function GET(request: Request) {
  try {
    const authorization = await getAuthorization();
    if (!authorization) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (!hasPermission(authorization, "payment_process", "access")) {
      return Response.json({ error: "Permission required" }, { status: 403 });
    }
    const companyId = requireCompanyId(authorization);
    if (!supabaseAdmin) return Response.json({ error: "Supabase service role key is not configured" }, { status: 500 });
    const canSeeAllFinalApproved = isCompanyOwner(authorization);
    if (!authorization.roleId && !canSeeAllFinalApproved) return Response.json({ error: "Payment process role not available." }, { status: 403 });

    const params = new URL(request.url).searchParams;
    const bankId = params.get("bank_id");
    const fileType = String(params.get("file_type") ?? "").trim();
    const valueDate = formatValueDate(params.get("value_date"));
    const requestIds = parseRequestIds(params.get("request_ids"));
    if (!bankId) return Response.json({ error: "Select bank." }, { status: 400 });
    if (!fileType) return Response.json({ error: "Select file type." }, { status: 400 });
    if (fileType !== "fedone") return Response.json({ error: "Unsupported bank file type." }, { status: 400 });
    if (!requestIds.length) return Response.json({ error: "Select at least one approved payment request." }, { status: 400 });

    const { data: bank, error: bankError } = await supabaseAdmin
      .from("payment_banks")
      .select("id, bank_code, display_name, account_no, is_active")
      .eq("company_id", companyId)
      .eq("id", bankId)
      .maybeSingle();
    if (bankError) throw new Error(bankError.message);
    const paymentBank = bank as PaymentBankRow | null;
    if (!paymentBank?.is_active) return Response.json({ error: "Selected bank is not active." }, { status: 400 });
    if (fileType === "fedone" && paymentBank.bank_code !== "FEDERAL_BANK") {
      return Response.json({ error: "Selected file type is not available for this bank." }, { status: 400 });
    }

    let requestsQuery = supabaseAdmin
      .from("payment_requests")
      .select(`
        id,
        request_no,
        location_code,
        amount,
        amount_requested,
        payment_mode,
        bank_account_no,
        beneficiary_account_no,
        beneficiary_account_number,
        ifsc,
        beneficiary_ifsc,
        account_holder_name,
        beneficiary_account_holder,
        email,
        status,
        approval_status,
        current_approver_user_id,
        current_approver_role_id,
        payment_process_role_ids,
        payment_heads ( name, code, external_id )
      `)
      .eq("company_id", companyId)
      .in("id", requestIds)
      .order("created_at", { ascending: true });

    if (!canSeeAllFinalApproved && authorization.roleId) {
      requestsQuery = requestsQuery.contains("payment_process_role_ids", [authorization.roleId]);
    }

    const { data, error } = await requestsQuery;
    if (error) throw new Error(error.message);

    const requests = ((data ?? []) as unknown as RequestRow[])
      .filter(isReadyForPaymentProcess)
      .filter((item) => String(item.approval_status ?? "").toUpperCase() !== "RE_APPROVED" || item.current_approver_user_id === authorization.userId)
      .map((row) => ({
        ...row,
        payment_heads: firstRelation(row.payment_heads)
      }));
    if (!requests.length) return Response.json({ error: "No approved payments available for processing." }, { status: 404 });
    if (requests.length !== requestIds.length) return Response.json({ error: "Some selected payments are no longer ready for processing." }, { status: 409 });
    const incompatibleRequests = requests.filter((item) => (item.payment_mode ?? "account_transfer") !== "account_transfer");
    if (incompatibleRequests.length) {
      return Response.json({ error: "Only account transfer requests can be included in a bank transfer file." }, { status: 409 });
    }

    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet(fedOneRows(requests, paymentBank.account_no, valueDate), {
      header: [
        "Transaction Type",
        "Debit Account Number",
        "Transaction Amount",
        "Value Date",
        "Beneficiary Account Number",
        "Beneficiary Name",
        "IFSC Code",
        "Beneficiary Email ID",
        "Beneficiary ID",
        "Credit Remarks",
        "Debit Remarks",
        "Unique Customer Reference Number"
      ]
    });
    XLSX.utils.book_append_sheet(workbook, sheet, "Sheet1");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const fileDate = valueDate.replace(/\//g, "");
    await markRequestsProcessing(companyId, requests.map((item) => item.id), authorization.userId);

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Disposition": `attachment; filename="fedone-payment-upload-${fileDate}.xlsx"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      }
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to download bank file." }, { status: 500 });
  }
}
