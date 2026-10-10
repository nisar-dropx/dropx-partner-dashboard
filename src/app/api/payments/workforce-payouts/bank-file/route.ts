import { createHash } from "node:crypto";

import { currentAdminAccessSurface } from "@/lib/access-surface";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { buildWorkforceFedOneWorkbook } from "@/lib/workforce-payout-bank-file";
import { refreshWorkforcePayoutPublicationJobs } from "@/lib/workforce-payout-publication-refresh";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const noStore = { "Cache-Control": "private, no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// A user action may include every eligible row. Keep a transport guard so an
// unbounded/chunked request still cannot consume arbitrary memory; the RPC
// validates company ownership and eligibility transactionally.
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

type PaymentInstruction = {
  reference_no: string;
  instruction_amount: number | string;
  bank_account_no: string;
  ifsc: string;
  beneficiary_name: string;
  beneficiary_email?: string | null;
  credit_remarks: string;
  debit_account_no: string;
  value_date: string;
};

function errorResponse(error: string, status: number) {
  return Response.json({ error }, { status, headers: noStore });
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

function validDate(value: string) {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function completeCalendarMonth(periodStart: string, periodEnd: string) {
  if (!validDate(periodStart) || !validDate(periodEnd) || !periodStart.endsWith("-01")) return false;
  const end = new Date(`${periodStart}T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(0);
  return end.toISOString().slice(0, 10) === periodEnd;
}

function uniqueWorkforceIds(value: unknown) {
  if (!Array.isArray(value)) return null;
  const ids = value.map((item) => String(item ?? "").trim().toLowerCase());
  if (!ids.length || ids.some((id) => !UUID.test(id)) || new Set(ids).size !== ids.length) return null;
  return ids.sort();
}

async function jsonBody(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new Error("REQUEST_TOO_LARGE");
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) {
    throw new Error("REQUEST_TOO_LARGE");
  }
  return JSON.parse(raw) as unknown;
}

function paise(value: number | string) {
  const amount = Number(value);
  const result = Math.round((amount + Number.EPSILON) * 100);
  if (!Number.isSafeInteger(result) || result <= 0 || Math.abs(amount - result / 100) > 1e-9) {
    throw new Error("A generated payment amount is invalid. No bank file was created.");
  }
  return result;
}

function resultRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function databaseStatus(message: string) {
  return /processing|changed|refresh|mapping|published|balance|payable|bank detail|operation|already|current payout|review/i.test(message) ? 409 : 400;
}

async function authorize() {
  const authorization = await getAuthorization();
  if (!authorization) return { error: errorResponse("Sign in to process Workforce payments.", 401) } as const;
  const payoutPageCode = currentAdminAccessSurface() === "ops" ? "ops_workforce_payouts" : "workforce_payouts";
  if (authorization.readOnly || !hasPermission(authorization, payoutPageCode, "edit") || !hasPermission(authorization, "payment_process", "edit")) {
    return { error: errorResponse("Edit access to Workforce Payouts and Payment Process is required.", 403) } as const;
  }
  if (!authorization.hasAllLocationAccess) {
    return { error: errorResponse("Workforce bank processing requires all-location access.", 403) } as const;
  }
  if (!supabaseAdmin) return { error: errorResponse("Database configuration is unavailable.", 503) } as const;
  return { authorization, companyId: requireCompanyId(authorization) } as const;
}

function workbookResponse(result: Record<string, unknown>) {
  const items = Array.isArray(result.items) ? result.items.map(resultRecord) as PaymentInstruction[] : [];
  if (!items.length) return errorResponse("No positive Workforce balance is available for this bank file.", 409);
  const debitAccountNumber = String(items[0]?.debit_account_no ?? "").trim();
  if (!debitAccountNumber || items.some((item) => String(item.debit_account_no ?? "").trim() !== debitAccountNumber)) {
    return errorResponse("The generated bank batch has inconsistent debit account details.", 409);
  }
  const valueDate = String(result.value_date ?? items[0]?.value_date ?? "").trim();
  const batchId = String(result.batch_id ?? "").trim().toLowerCase();
  const payloadSha256 = createHash("sha256").update(JSON.stringify({
    batchId,
    valueDate,
    instructions: items.map((item) => ({
      referenceNo: String(item.reference_no ?? ""),
      amountPaise: paise(item.instruction_amount),
      beneficiaryAccountNumber: String(item.bank_account_no ?? ""),
      beneficiaryIfsc: String(item.ifsc ?? ""),
      creditRemarks: String(item.credit_remarks ?? ""),
      debitRemarks: "NET PAY"
    }))
  })).digest("hex");
  const workbook = buildWorkforceFedOneWorkbook({
    debitAccountNumber,
    valueDate,
    instructions: items.map((item) => ({
      amountPaise: paise(item.instruction_amount),
      beneficiaryAccountNumber: String(item.bank_account_no ?? ""),
      beneficiaryEmail: String(item.beneficiary_email ?? "") || null,
      beneficiaryIfsc: String(item.ifsc ?? ""),
      beneficiaryName: String(item.beneficiary_name ?? ""),
      locationCode: String(item.credit_remarks ?? ""),
      referenceNo: String(item.reference_no ?? "")
    }))
  });
  const periodStart = String(result.period_start ?? "workforce-payout");
  const batchSuffix = UUID.test(batchId) ? `-${batchId.slice(0, 8)}` : "";
  const filename = `workforce-payouts-${periodStart.slice(0, 7)}-${valueDate.replaceAll("-", "")}${batchSuffix}.xlsx`;
  return new Response(Buffer.from(workbook), {
    headers: {
      ...noStore,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "X-Workforce-Payout-Batch-Id": batchId,
      "X-Workforce-Payout-Format-Version": "fedone-v1",
      "X-Workforce-Payout-Payload-SHA256": payloadSha256,
      "X-Workforce-Payout-Batch-Replayed": result.replayed === true ? "true" : "false"
    }
  });
}

export async function GET(request: Request) {
  try {
    const access = await authorize();
    if ("error" in access) return access.error;
    const batchId = new URL(request.url).searchParams.get("batch_id")?.trim().toLowerCase() ?? "";
    if (!UUID.test(batchId)) return errorResponse("A valid Workforce payment batch is required.", 400);
    const [batchResult, itemsResult] = await Promise.all([
      supabaseAdmin!
        .from("workforce_payout_payment_batches")
        .select("id,status,period_start,period_end,value_date,debit_account_no_snapshot")
        .eq("company_id", access.companyId)
        .eq("id", batchId)
        .maybeSingle(),
      supabaseAdmin!
        .from("workforce_payout_payment_items")
        .select("batch_id,status,dropx_id_snapshot,reference_no,instruction_amount,bank_account_no_snapshot,ifsc_snapshot,beneficiary_name_snapshot,beneficiary_email_snapshot,credit_remarks_snapshot")
        .eq("company_id", access.companyId)
        .eq("batch_id", batchId)
        .order("dropx_id_snapshot")
        .order("reference_no")
    ]);
    if (batchResult.error) return errorResponse(batchResult.error.message, 400);
    if (itemsResult.error) return errorResponse(itemsResult.error.message, 400);
    if (!batchResult.data) return errorResponse("Workforce payment batch was not found.", 404);
    const batch = batchResult.data;
    const items = itemsResult.data ?? [];
    if (String(batch.status) !== "processing" || !items.length || items.some((item) => String(item.status) !== "processing")) {
      return errorResponse("Only an entirely unfinalized Payment Processing batch can be downloaded again.", 409);
    }
    return workbookResponse({
      batch_id: batch.id,
      period_start: batch.period_start,
      period_end: batch.period_end,
      value_date: batch.value_date,
      replayed: true,
      items: items.map((item) => ({
        reference_no: item.reference_no,
        instruction_amount: item.instruction_amount,
        bank_account_no: item.bank_account_no_snapshot,
        ifsc: item.ifsc_snapshot,
        beneficiary_name: item.beneficiary_name_snapshot,
        beneficiary_email: item.beneficiary_email_snapshot,
        credit_remarks: item.credit_remarks_snapshot,
        debit_account_no: batch.debit_account_no_snapshot,
        value_date: batch.value_date
      }))
    });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to download the Workforce bank file.", 500);
  }
}

export async function POST(request: Request) {
  try {
    if (!sameOrigin(request)) return errorResponse("Invalid request origin.", 403);
    const access = await authorize();
    if ("error" in access) return access.error;

    let body: Record<string, unknown>;
    try {
      const parsed = await jsonBody(request);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return errorResponse("Submit a valid bank-file request.", 400);
      body = parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof Error && error.message === "REQUEST_TOO_LARGE") {
        return errorResponse("The bank-file request is too large.", 413);
      }
      return errorResponse("Submit a valid bank-file request.", 400);
    }
    const operationId = String(body.operationId ?? "").trim().toLowerCase();
    const bankId = String(body.bankId ?? "").trim().toLowerCase();
    const periodStart = String(body.periodStart ?? "").trim();
    const periodEnd = String(body.periodEnd ?? "").trim();
    const valueDate = String(body.valueDate ?? "").trim();
    const workforceIds = uniqueWorkforceIds(body.workforceIds);
    if (!UUID.test(operationId) || !UUID.test(bankId)) return errorResponse("A valid operation and bank are required.", 400);
    if (!completeCalendarMonth(periodStart, periodEnd)) return errorResponse("Bank processing is available only for one complete calendar month.", 400);
    if (!validDate(valueDate)) return errorResponse("Choose a valid bank value date.", 400);
    if (!workforceIds) return errorResponse("Select at least one unique Workforce profile.", 400);

    let refreshResult;
    try {
      refreshResult = await refreshWorkforcePayoutPublicationJobs({
        authorization: access.authorization,
        companyId: access.companyId,
        workforceIds,
        periodStart,
        periodEnd,
        deadlineAtMs: Date.now() + 240_000,
        // One Workforce profile can own several station refresh jobs.
        limit: 100
      });
    } catch (error) {
      return errorResponse(
        `The selected payout publications could not be refreshed before bank-file generation. No payment batch was created. ${error instanceof Error ? error.message : "Retry after the publication refresh worker is available."}`,
        409
      );
    }
    const blockingRefreshWarning = refreshResult.warnings.find((warning) => warning.code !== "queue_status_failed");
    if (blockingRefreshWarning || refreshResult.failed > 0 || refreshResult.retrying > 0 || refreshResult.staleClaims > 0) {
      const detail = blockingRefreshWarning?.message
        ?? "One or more selected publication refreshes did not complete.";
      return errorResponse(
        `The selected payout publications are not ready for bank-file generation. No payment batch was created. ${detail}`,
        409
      );
    }

    const requestFingerprint = createHash("sha256").update(JSON.stringify({ bankId, periodStart, periodEnd, valueDate, workforceIds })).digest("hex");
    // This transactional RPC is the authoritative second gate. Queue counts
    // above are diagnostic only: this gate recalculates every selected payment
    // candidate under lock and rejects unfinished or stale publications, as
    // well as any non-refresh payment blocker.
    const created = await supabaseAdmin!.rpc("workforce_create_payout_payment_batch", {
      p_company_id: access.companyId,
      p_actor_user_id: access.authorization.userId,
      p_operation_id: operationId,
      p_request_fingerprint: requestFingerprint,
      p_bank_id: bankId,
      p_period_start: periodStart,
      p_period_end: periodEnd,
      p_value_date: valueDate,
      p_workforce_ids: workforceIds
    });
    if (created.error) return errorResponse(created.error.message, databaseStatus(created.error.message));
    return workbookResponse(resultRecord(created.data));
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to create the Workforce bank file.", 500);
  }
}
