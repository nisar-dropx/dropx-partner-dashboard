import { createHash } from "node:crypto";

import JSZip from "jszip";

import { currentAdminAccessSurface } from "@/lib/access-surface";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { buildWorkforceFedOneWorkbook } from "@/lib/workforce-payout-bank-file";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const noStore = { "Cache-Control": "private, no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

type RedownloadItem = {
  payment_item_id: string;
  batch_id: string;
  batch_status: string;
  generated_at: string;
  period_start: string;
  period_end: string;
  value_date: string;
  debit_account_no: string;
  bank_code: string;
  file_type: string;
  reference_no: string;
  instruction_amount: number | string;
  bank_account_no: string;
  ifsc: string;
  beneficiary_name: string;
  beneficiary_email?: string | null;
  location_id: string;
  location_code: string;
  credit_remarks: string;
  debit_remarks: string;
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
  const expectedEnd = new Date(`${periodStart}T00:00:00Z`);
  expectedEnd.setUTCMonth(expectedEnd.getUTCMonth() + 1);
  expectedEnd.setUTCDate(0);
  return expectedEnd.toISOString().slice(0, 10) === periodEnd;
}

function uniquePaymentItemIds(value: unknown) {
  if (!Array.isArray(value) || !value.length) return null;
  const ids = value.map((item) => String(item ?? "").trim().toLowerCase());
  if (ids.some((id) => !UUID.test(id)) || new Set(ids).size !== ids.length) return null;
  return ids.sort((left, right) => left.localeCompare(right));
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

function resultRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function paise(value: number | string) {
  const amount = Number(value);
  const result = Math.round((amount + Number.EPSILON) * 100);
  if (!Number.isSafeInteger(result) || result <= 0 || Math.abs(amount - result / 100) > 1e-9) {
    throw new Error("A stored payment amount is invalid. No bank file was downloaded.");
  }
  return result;
}

function databaseStatus(message: string) {
  return /processing|selected|company|month|legacy|download|changed/i.test(message) ? 409 : 400;
}

async function authorize() {
  const authorization = await getAuthorization();
  if (!authorization) return { error: errorResponse("Sign in to re-download Workforce bank files.", 401) } as const;
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

function buildBatchWorkbook(items: RedownloadItem[]) {
  const first = items[0];
  if (!first) throw new Error("No processing payments are available for re-download.");
  if (String(first.file_type).trim().toLowerCase() !== "fedone") {
    throw new Error("The selected bank-file format is not supported for re-download.");
  }
  const debitAccountNumber = String(first.debit_account_no ?? "").trim();
  const valueDate = String(first.value_date ?? "").trim();
  if (items.some((item) =>
    String(item.batch_id) !== String(first.batch_id)
    || String(item.debit_account_no ?? "").trim() !== debitAccountNumber
    || String(item.value_date ?? "").trim() !== valueDate
    || String(item.file_type ?? "").trim().toLowerCase() !== "fedone"
    || String(item.debit_remarks ?? "").trim().toUpperCase() !== "NET PAY"
  )) {
    throw new Error("The stored bank instructions are inconsistent. No bank file was downloaded.");
  }
  return buildWorkforceFedOneWorkbook({
    debitAccountNumber,
    valueDate,
    instructions: items.map((item) => ({
      amountPaise: paise(item.instruction_amount),
      beneficiaryAccountNumber: String(item.bank_account_no ?? ""),
      beneficiaryEmail: String(item.beneficiary_email ?? "") || null,
      beneficiaryIfsc: String(item.ifsc ?? ""),
      beneficiaryName: String(item.beneficiary_name ?? ""),
      locationCode: String(item.credit_remarks ?? item.location_code ?? ""),
      referenceNo: String(item.reference_no ?? "")
    }))
  });
}

function batchFilename(periodStart: string, item: RedownloadItem) {
  const valueDate = String(item.value_date ?? "").replaceAll("-", "");
  const batchId = String(item.batch_id ?? "").toLowerCase();
  const suffix = UUID.test(batchId) ? batchId : "batch";
  return `workforce-payouts-${periodStart.slice(0, 7)}-${valueDate}-${suffix}-redownload.xlsx`;
}

export async function POST(request: Request) {
  try {
    if (!sameOrigin(request)) return errorResponse("Invalid request origin.", 403);
    const access = await authorize();
    if ("error" in access) return access.error;

    let body: Record<string, unknown>;
    try {
      const parsed = await jsonBody(request);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return errorResponse("Submit a valid bank-file re-download request.", 400);
      }
      body = parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof Error && error.message === "REQUEST_TOO_LARGE") {
        return errorResponse("The bank-file re-download request is too large.", 413);
      }
      return errorResponse("Submit a valid bank-file re-download request.", 400);
    }

    const periodStart = String(body.periodStart ?? "").trim();
    const periodEnd = String(body.periodEnd ?? "").trim();
    const paymentItemIds = uniquePaymentItemIds(body.paymentItemIds);
    if (!completeCalendarMonth(periodStart, periodEnd)) {
      return errorResponse("Bank-file re-download is available only for one complete calendar month.", 400);
    }
    if (!paymentItemIds) return errorResponse("Select at least one unique Payment Processing item.", 400);

    const result = await supabaseAdmin!.rpc("workforce_get_payout_payment_redownload", {
      p_company_id: access.companyId,
      p_payment_item_ids: paymentItemIds,
      p_period_start: periodStart,
      p_period_end: periodEnd
    });
    if (result.error) return errorResponse(result.error.message, databaseStatus(result.error.message));
    const payload = resultRecord(result.data);
    const items = Array.isArray(payload.items) ? payload.items.map(resultRecord) as unknown as RedownloadItem[] : [];
    if (items.length !== paymentItemIds.length) {
      return errorResponse("The selected processing payments changed. Refresh and select them again.", 409);
    }
    const returnedIds = new Set(items.map((item) => String(item.payment_item_id ?? "").toLowerCase()));
    if (returnedIds.size !== paymentItemIds.length || paymentItemIds.some((id) => !returnedIds.has(id))) {
      return errorResponse("The bank file did not resolve the exact selected payments.", 409);
    }

    const groups = new Map<string, RedownloadItem[]>();
    items.forEach((item) => {
      const batchId = String(item.batch_id ?? "").trim().toLowerCase();
      if (!UUID.test(batchId) || !UUID.test(String(item.payment_item_id ?? ""))) {
        throw new Error("A stored processing payment identifier is invalid.");
      }
      const batchItems = groups.get(batchId) ?? [];
      batchItems.push(item);
      groups.set(batchId, batchItems);
    });
    const orderedGroups = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
    const responseHeaders = {
      ...noStore,
      "X-Workforce-Payout-Batch-Count": String(orderedGroups.length),
      "X-Workforce-Payout-Format-Version": "fedone-v1",
      "X-Workforce-Payout-Payment-Count": String(items.length),
      "X-Workforce-Payout-Redownload": "true"
    };

    if (orderedGroups.length === 1) {
      const batchItems = orderedGroups[0][1];
      const workbook = buildBatchWorkbook(batchItems);
      const filename = batchFilename(periodStart, batchItems[0]);
      return new Response(Buffer.from(workbook), {
        headers: {
          ...responseHeaders,
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "X-Workforce-Payout-Batch-Id": orderedGroups[0][0],
          "X-Workforce-Payout-Payload-SHA256": createHash("sha256").update(workbook).digest("hex")
        }
      });
    }

    const archive = new JSZip();
    for (const [, batchItems] of orderedGroups) {
      archive.file(batchFilename(periodStart, batchItems[0]), buildBatchWorkbook(batchItems));
    }
    const zip = await archive.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      compressionOptions: { level: 6 }
    });
    const filename = `workforce-payouts-${periodStart.slice(0, 7)}-${orderedGroups.length}-bank-files-redownload.zip`;
    return new Response(Buffer.from(zip), {
      headers: {
        ...responseHeaders,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Type": "application/zip",
        "X-Workforce-Payout-Payload-SHA256": createHash("sha256").update(zip).digest("hex")
      }
    });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to re-download the Workforce bank file.", 500);
  }
}
