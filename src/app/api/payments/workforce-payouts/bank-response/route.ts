import { createHash } from "node:crypto";

import { currentAdminAccessSurface } from "@/lib/access-surface";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { parseWorkforceFedOneResponse } from "@/lib/workforce-payout-bank-file";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const noStore = { "Cache-Control": "private, no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

type PayoutAudience = "workforce" | "helpers";

function payoutAudience(value: FormDataEntryValue | null): PayoutAudience | null {
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

function databaseStatus(message: string) {
  return /mismatch|conflict|processing|already|duplicate|unknown|utr|amount|account|ifsc|operation|response/i.test(message) ? 409 : 400;
}

function resultRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function POST(request: Request) {
  try {
    if (!sameOrigin(request)) return errorResponse("Invalid request origin.", 403);
    const authorization = await getAuthorization();
    if (!authorization) return errorResponse("Sign in to finalize Workforce payments.", 401);
    const payoutPageCode = currentAdminAccessSurface() === "ops" ? "ops_workforce_payouts" : "workforce_payouts";
    if (authorization.readOnly || !hasPermission(authorization, payoutPageCode, "edit") || !hasPermission(authorization, "payment_process", "edit")) {
      return errorResponse("Edit access to Workforce Payouts and Payment Process is required.", 403);
    }
    if (!authorization.hasAllLocationAccess) return errorResponse("Workforce bank finalization requires all-location access.", 403);
    if (!supabaseAdmin) return errorResponse("Database configuration is unavailable.", 503);
    const companyId = requireCompanyId(authorization);

    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_FILE_BYTES + 128 * 1024) return errorResponse("The bank response file is too large.", 413);
    const form = await request.formData();
    const audience = payoutAudience(form.get("audience"));
    if (!audience) return errorResponse("Choose a valid payout audience.", 400);
    const file = form.get("bank_response_file");
    const operationId = String(form.get("operation_id") ?? "").trim().toLowerCase();
    if (!(file instanceof File) || file.size <= 0) return errorResponse("Upload the bank response Excel file.", 400);
    if (file.size > MAX_FILE_BYTES) return errorResponse("The bank response file must be 10 MB or smaller.", 413);
    if (!UUID.test(operationId)) return errorResponse("A valid response operation ID is required.", 400);
    if (!/\.xlsx?$/i.test(file.name)) return errorResponse("Upload an .xlsx or .xls bank response file.", 400);

    const bytes = new Uint8Array(await file.arrayBuffer());
    const rows = parseWorkforceFedOneResponse(bytes, {
      referencePrefix: audience === "helpers" ? "HP" : "WP"
    });
    const fileSha256 = createHash("sha256").update(bytes).digest("hex");
    const rpcParameters = {
      p_company_id: companyId,
      p_actor_user_id: authorization.userId,
      p_operation_id: operationId,
      p_file_sha256: fileSha256,
      p_file_name: file.name.slice(0, 240),
      p_rows: rows.map((row) => ({
        row_number: row.rowNumber,
        reference_no: row.referenceNo,
        credit_account: row.creditAccount,
        ifsc: row.ifsc,
        debit_amount_paise: row.debitAmountPaise,
        status: row.status === "CANCELED" ? "CANCELLED" : row.status,
        utr_cin: row.utrCin,
        remarks: row.remarks
      }))
    };
    const finalized = audience === "helpers"
      ? await supabaseAdmin.rpc("helper_finalize_payout_payment_response", rpcParameters)
      : await supabaseAdmin.rpc("workforce_finalize_payout_payment_response", rpcParameters);
    if (finalized.error) return errorResponse(finalized.error.message, databaseStatus(finalized.error.message));
    const result = resultRecord(finalized.data);
    return Response.json(result, { headers: noStore });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to finalize the Workforce bank response.";
    return errorResponse(message, /cannot be processed|headers|worksheet|response rows|duplicate/i.test(message) ? 400 : 500);
  }
}
