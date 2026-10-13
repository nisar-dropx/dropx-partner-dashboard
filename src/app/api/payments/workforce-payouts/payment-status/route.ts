import { createHash } from "node:crypto";
import { currentAdminAccessSurface } from "@/lib/access-surface";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const noStore = { "Cache-Control": "private, no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const actions = new Set(["failed", "cancelled", "finalize", "hold", "release_hold"]);
const MEANINGLESS_BANK_REFERENCES = new Set(["", "0", "NA", "NIL", "NONE", "NULL", "NOTAVAILABLE", "NOTAPPLICABLE"]);

type PayoutAudience = "workforce" | "helpers";

function payoutAudience(value: unknown): PayoutAudience | null {
  const normalized = String(value ?? "workforce").trim().toLowerCase();
  return normalized === "workforce" || normalized === "helpers" ? normalized : null;
}

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
  const expectedEnd = new Date(`${periodStart}T00:00:00Z`);
  expectedEnd.setUTCMonth(expectedEnd.getUTCMonth() + 1);
  expectedEnd.setUTCDate(0);
  return expectedEnd.toISOString().slice(0, 10) === periodEnd;
}

function boundedText(value: unknown, maximum: number) {
  const normalized = String(value ?? "").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
  return normalized && normalized.length <= maximum ? normalized : null;
}

function positiveMoney(value: unknown) {
  const match = String(value ?? "").trim().match(/^(\d{1,12})(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const whole = match[1].replace(/^0+(?=\d)/, "");
  const fraction = (match[2] ?? "").padEnd(2, "0");
  if (!/[1-9]/.test(`${whole}${fraction}`)) return null;
  return `${whole}.${fraction}`;
}

function meaningfulBankReference(value: unknown) {
  const raw = boundedText(value, 200);
  if (!raw) return null;
  const normalized = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return MEANINGLESS_BANK_REFERENCES.has(normalized) ? null : raw;
}

function databaseStatus(message: string) {
  return /processing|terminal|already|different request|not found|hold state|still be|no payments were cancelled/i.test(message) ? 409 : 400;
}

function resultRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function bulkHoldOperationId(operationId: string, workforceId: string, action: string) {
  const digest = createHash("sha256")
    .update(`${operationId}:${workforceId}:${action}`)
    .digest("hex");
  const variant = ((Number.parseInt(digest[16], 16) & 0x3) | 0x8).toString(16);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

async function processingPayoutSubjectIds({
  audience,
  companyId,
  periodEnd,
  periodStart,
  workforceIds
}: {
  audience: PayoutAudience;
  companyId: string;
  periodEnd: string;
  periodStart: string;
  workforceIds: string[];
}) {
  const table = audience === "helpers" ? "helper_payout_payment_items" : "workforce_payout_payment_items";
  const subjectColumn = audience === "helpers" ? "helper_id" : "workforce_id";
  const processing = new Set<string>();
  for (let offset = 0; offset < workforceIds.length; offset += 200) {
    const ids = workforceIds.slice(offset, offset + 200);
    const result = await supabaseAdmin!
      .from(table)
      .select(subjectColumn)
      .eq("company_id", companyId)
      .eq("period_start", periodStart)
      .eq("period_end", periodEnd)
      .eq("status", "processing")
      .in(subjectColumn, ids);
    if (result.error) throw new Error(result.error.message);
    (result.data ?? []).forEach((row) => {
      const workforceId = String((row as Record<string, unknown>)[subjectColumn] ?? "").trim().toLowerCase();
      if (UUID.test(workforceId)) processing.add(workforceId);
    });
  }
  return processing;
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

export async function POST(request: Request) {
  try {
    if (!sameOrigin(request)) return errorResponse("Invalid request origin.", 403);

    const authorization = await getAuthorization();
    if (!authorization) return errorResponse("Sign in to manage Workforce payment status.", 401);
    const accessSurface = currentAdminAccessSurface();
    const pageCode = accessSurface === "ops" ? "ops_workforce_payouts" : "workforce_payouts";
    const canUsePaymentActions = accessSurface === "ops" || hasPermission(authorization, "payment_process", "edit");
    if (authorization.readOnly || !hasPermission(authorization, pageCode, "edit") || !canUsePaymentActions) {
      return errorResponse("Edit access to Workforce Payouts and Payment Process is required.", 403);
    }
    if (!authorization.hasAllLocationAccess) {
      return errorResponse("Workforce payment status changes require all-location access.", 403);
    }
    if (!supabaseAdmin) return errorResponse("Database configuration is unavailable.", 503);

    let body: Record<string, unknown>;
    try {
      const parsed = await jsonBody(request);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return errorResponse("Submit a valid payment status request.", 400);
      }
      body = parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof Error && error.message === "REQUEST_TOO_LARGE") {
        return errorResponse("The payment status request is too large.", 413);
      }
      return errorResponse("Submit a valid payment status request.", 400);
    }

    const action = String(body.action ?? "").trim().toLowerCase();
    const audience = payoutAudience(body.audience);
    if (!audience) return errorResponse("Choose a valid payout audience.", 400);
    const operationId = String(body.operationId ?? "").trim().toLowerCase();
    const remarks = String(body.remarks ?? "").trim();
    if (!actions.has(action)) return errorResponse("Choose a valid payment status action.", 400);
    if (!UUID.test(operationId)) return errorResponse("A valid operation ID is required.", 400);
    if (remarks.length < 3 || remarks.length > 1000) {
      return errorResponse("Enter a remark between 3 and 1000 characters.", 400);
    }

    const companyId = requireCompanyId(authorization);
    if (action === "finalize") {
      const paymentItemId = String(body.paymentItemId ?? "").trim().toLowerCase();
      const paidAmount = positiveMoney(body.amount);
      const debitAccountNo = boundedText(body.debitAccount, 128);
      const creditAccountNo = boundedText(body.creditAccount, 128);
      const creditIfsc = boundedText(body.creditIfsc, 64);
      const valueDate = String(body.valueDate ?? "").trim();
      const utrCin = meaningfulBankReference(body.utrCin);
      const bankRemarks = boundedText(body.bankRemarks, 1000);
      if (!UUID.test(paymentItemId)) return errorResponse("A valid processing payment is required.", 400);
      if (!paidAmount) return errorResponse("Enter a positive paid amount with at most two decimal places.", 400);
      if (!debitAccountNo) return errorResponse("Enter the debit account used for this payment.", 400);
      if (!creditAccountNo) return errorResponse("Enter the credit account that received this payment.", 400);
      if (!creditIfsc) return errorResponse("Enter the credit account IFSC.", 400);
      if (!validDate(valueDate)) return errorResponse("Enter a valid payment value date.", 400);
      if (!utrCin) return errorResponse("Enter a meaningful UTR/CIN for this payment.", 400);
      if (!bankRemarks || bankRemarks.length < 3) return errorResponse("Enter bank processing remarks of at least 3 characters.", 400);
      const rpcParameters = {
        p_company_id: companyId,
        p_actor_user_id: authorization.userId,
        p_operation_id: operationId,
        p_payment_item_id: paymentItemId,
        p_paid_amount: paidAmount,
        p_debit_account_no: debitAccountNo,
        p_credit_account_no: creditAccountNo,
        p_credit_ifsc: creditIfsc,
        p_value_date: valueDate,
        p_utr_cin: utrCin,
        p_bank_remarks: bankRemarks,
        p_remarks: remarks
      };
      const result = audience === "helpers"
        ? await supabaseAdmin.rpc("helper_finalize_payout_payment_item_manually", rpcParameters)
        : await supabaseAdmin.rpc("workforce_finalize_payout_payment_item_manually", rpcParameters);
      if (result.error) return errorResponse(result.error.message, databaseStatus(result.error.message));
      return Response.json(resultRecord(result.data), { headers: noStore });
    }

    if (action === "failed" || action === "cancelled") {
      if (Array.isArray(body.paymentItemIds)) {
        if (action !== "cancelled") return errorResponse("Bulk status changes support cancellation only.", 400);
        const periodStart = String(body.periodStart ?? "").trim();
        const periodEnd = String(body.periodEnd ?? "").trim();
        if (!completeCalendarMonth(periodStart, periodEnd)) return errorResponse("Choose one complete payout month.", 400);
        const paymentItemIds = body.paymentItemIds.map((value) => String(value ?? "").trim().toLowerCase());
        if (!paymentItemIds.length || paymentItemIds.some((value) => !UUID.test(value))) {
          return errorResponse("Select at least one valid processing payment.", 400);
        }
        if (new Set(paymentItemIds).size !== paymentItemIds.length) {
          return errorResponse("Each processing payment may be selected only once.", 400);
        }
        const rpcParameters = {
          p_company_id: companyId,
          p_actor_user_id: authorization.userId,
          p_operation_id: operationId,
          p_payment_item_ids: paymentItemIds,
          p_period_start: periodStart,
          p_period_end: periodEnd,
          p_remarks: remarks
        };
        const result = audience === "helpers"
          ? await supabaseAdmin.rpc("helper_cancel_payout_payment_items", rpcParameters)
          : await supabaseAdmin.rpc("workforce_cancel_payout_payment_items", rpcParameters);
        if (result.error) return errorResponse(result.error.message, databaseStatus(result.error.message));
        return Response.json(resultRecord(result.data), { headers: noStore });
      }
      const paymentItemId = String(body.paymentItemId ?? "").trim().toLowerCase();
      if (!UUID.test(paymentItemId)) return errorResponse("A valid processing payment is required.", 400);
      const rpcParameters = {
        p_company_id: companyId,
        p_actor_user_id: authorization.userId,
        p_operation_id: operationId,
        p_payment_item_id: paymentItemId,
        p_outcome: action,
        p_remarks: remarks
      };
      const result = audience === "helpers"
        ? await supabaseAdmin.rpc("helper_transition_payout_payment_item", rpcParameters)
        : await supabaseAdmin.rpc("workforce_transition_payout_payment_item", rpcParameters);
      if (result.error) return errorResponse(result.error.message, databaseStatus(result.error.message));
      return Response.json(resultRecord(result.data), { headers: noStore });
    }

    const periodStart = String(body.periodStart ?? "").trim();
    const periodEnd = String(body.periodEnd ?? "").trim();
    if (!completeCalendarMonth(periodStart, periodEnd)) return errorResponse("Choose one complete payout month.", 400);
    const submittedWorkforceIds = Array.isArray(body.workforceIds)
      ? body.workforceIds.map((value) => String(value ?? "").trim().toLowerCase())
      : [String(body.workforceId ?? "").trim().toLowerCase()];
    const workforceIds = [...new Set(submittedWorkforceIds.filter(Boolean))];
    if (workforceIds.some((value) => !UUID.test(value))) {
      return errorResponse("Every selected Workforce profile must be valid.", 400);
    }
    const submittedSourceTargets = Array.isArray(body.sourceTargets) ? body.sourceTargets : [];
    const sourceTargets = submittedSourceTargets.map((value) => {
      const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
      return {
        station_id: String(source.stationId ?? "").trim().toLowerCase(),
        provider_identity: String(source.providerIdentity ?? "").trim(),
        provider_member_id: String(source.providerMemberId ?? "").trim()
      };
    });
    if (sourceTargets.some((source) => !UUID.test(source.station_id)
      || !source.provider_identity || !source.provider_member_id)) {
      return errorResponse("Every provider payout source requires a valid station, provider and provider member ID.", 400);
    }
    if (!workforceIds.length && !sourceTargets.length) {
      return errorResponse("Select at least one Workforce profile or provider payout source.", 400);
    }
    if (sourceTargets.length && audience !== "workforce") {
      return errorResponse("Provider payout source holds are available only for Workforce payments.", 400);
    }
    const processingIds = workforceIds.length
      ? await processingPayoutSubjectIds({ audience, companyId, periodEnd, periodStart, workforceIds })
      : new Set<string>();
    if (processingIds.size) {
      return errorResponse(
        `${processingIds.size} selected profile${processingIds.size === 1 ? " is" : "s are"} currently Payment Processing. Cancel or finalize processing before changing the hold.`,
        409
      );
    }

    if ((Array.isArray(body.workforceIds) || sourceTargets.length) && audience === "workforce") {
      const result = await supabaseAdmin.rpc("workforce_set_payout_combined_payment_holds", {
        p_company_id: companyId,
        p_actor_user_id: authorization.userId,
        p_operation_id: operationId,
        p_workforce_ids: workforceIds,
        p_sources: sourceTargets,
        p_period_start: periodStart,
        p_period_end: periodEnd,
        p_hold: action === "hold",
        p_remarks: remarks
      });
      if (result.error) return errorResponse(result.error.message, databaseStatus(result.error.message));
      const record = resultRecord(result.data);
      return Response.json({
        ...record,
        changed: Number(record.changed ?? record.changed_count ?? 0),
        onHold: action === "hold",
        processed: Number(record.processed ?? record.selected_count ?? record.total ?? workforceIds.length),
        replayed: record.replayed === true
      }, { headers: noStore });
    }

    let changed = 0;
    let replayed = 0;
    for (const workforceId of workforceIds) {
      const rpcParameters = {
        p_company_id: companyId,
        p_actor_user_id: authorization.userId,
        p_operation_id: Array.isArray(body.workforceIds)
          ? bulkHoldOperationId(operationId, workforceId, action)
          : operationId,
        p_workforce_id: workforceId,
        p_period_start: periodStart,
        p_period_end: periodEnd,
        p_hold: action === "hold",
        p_remarks: remarks
      };
      const result = audience === "helpers"
        ? await supabaseAdmin.rpc("helper_set_payout_payment_hold", rpcParameters)
        : await supabaseAdmin.rpc("workforce_set_payout_payment_hold", rpcParameters);
      if (result.error) return errorResponse(result.error.message, databaseStatus(result.error.message));
      const record = resultRecord(result.data);
      if (record.changed === true) changed += 1;
      if (record.replayed === true) replayed += 1;
    }
    return Response.json({
      changed,
      onHold: action === "hold",
      processed: workforceIds.length,
      replayed
    }, { headers: noStore });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to update Workforce payment status.", 500);
  }
}
