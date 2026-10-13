import { createHash } from "node:crypto";

import { currentAdminAccessSurface } from "@/lib/access-surface";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { chunkedValues, mapWithConcurrency } from "@/lib/bounded-concurrency";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  isValidWorkforceBankReference,
  normalizeWorkforceBankReference,
  parsePreparedDropxFedOneResponse,
  prepareDropxFedOneResponse,
  type LegacyDropxFedOneReferenceCandidate,
  type WorkforceFedOneResponseRow
} from "@/lib/workforce-payout-bank-file";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const noStore = { "Cache-Control": "private, no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE_ROWS = 5000;
const MAX_REFERENCE_CANDIDATES = 5000;
const REFERENCE_LOOKUP_CHUNK_SIZE = 50;
const REFERENCE_LOOKUP_CONCURRENCY = 4;

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

function normalizedRows(rows: WorkforceFedOneResponseRow[]) {
  return rows.map((row) => ({
    row_number: row.rowNumber,
    reference_no: row.referenceNo,
    debit_account: row.debitAccount ?? "",
    credit_account: row.creditAccount,
    ifsc: row.ifsc,
    value_date: row.valueDate ?? "",
    debit_amount_paise: row.debitAmountPaise,
    status: row.status === "CANCELED" ? "CANCELLED" : row.status,
    utr_cin: row.utrCin,
    remarks: row.remarks
  }));
}

async function loadOwnedPaymentReferences(companyId: string, candidates: string[]) {
  const database = supabaseAdmin;
  if (!database) throw new Error("Database configuration is unavailable.");
  const chunks = chunkedValues(candidates, REFERENCE_LOOKUP_CHUNK_SIZE);
  const lookups = ([
    { audience: "workforce" as const, table: "workforce_payout_payment_items" as const },
    { audience: "helpers" as const, table: "helper_payout_payment_items" as const }
  ]).flatMap((ledger) => chunks.map((references) => ({ ...ledger, references })));
  const results = await mapWithConcurrency(lookups, REFERENCE_LOOKUP_CONCURRENCY, async (lookup) => {
    const result = await database
      .from(lookup.table)
      .select("reference_no")
      .eq("company_id", companyId)
      .in("reference_no", lookup.references);
    if (result.error) {
      throw new Error(`Unable to verify ${lookup.audience === "helpers" ? "Helper" : "Workforce"} payment references: ${result.error.message}`);
    }
    return (result.data ?? []).map((row) => String(row.reference_no ?? "").trim().toUpperCase()).filter(Boolean);
  });
  return new Set(results.flat());
}

type LegacyReferenceResolution = {
  audience?: unknown;
  message?: unknown;
  reference_no?: unknown;
  resolution_state?: unknown;
  row_number?: unknown;
};

async function resolveLegacyPaymentReferences(
  companyId: string,
  candidates: LegacyDropxFedOneReferenceCandidate[]
) {
  const aliases = new Map<number, string>();
  if (!candidates.length) return aliases;
  const database = supabaseAdmin;
  if (!database) throw new Error("Database configuration is unavailable.");

  const resolved = await database.rpc("resolve_owned_payout_legacy_response_references", {
    p_company_id: companyId,
    p_rows: candidates.map((candidate) => ({
      amount_error: candidate.amountError ?? "",
      credit_account: candidate.creditAccount,
      debit_amount_paise: candidate.debitAmountPaise,
      dropx_id: candidate.dropxId,
      ifsc: candidate.ifsc,
      row_number: candidate.rowNumber,
      status: candidate.status,
      utr_cin: candidate.utrCin
    }))
  });
  if (resolved.error) {
    throw new Error(`Unable to safely resolve bare DropX payment references: ${resolved.error.message}`);
  }

  const byRow = new Map<number, LegacyReferenceResolution>();
  for (const raw of Array.isArray(resolved.data) ? resolved.data as LegacyReferenceResolution[] : []) {
    const rowNumber = Number(raw.row_number);
    if (!Number.isSafeInteger(rowNumber) || rowNumber <= 0 || byRow.has(rowNumber)) {
      throw new Error("The bare DropX payment reference resolver returned invalid or duplicate row evidence.");
    }
    byRow.set(rowNumber, raw);
  }

  const errors: string[] = [];
  for (const candidate of candidates) {
    const resolution = byRow.get(candidate.rowNumber);
    if (!resolution) {
      errors.push(`Row ${candidate.rowNumber}: no ownership resolution was returned for bare DropX ID “${candidate.dropxId}”.`);
      continue;
    }
    const state = String(resolution.resolution_state ?? "").trim().toLowerCase();
    if (state === "unrelated") continue;
    if (state === "error") {
      errors.push(String(resolution.message ?? `Row ${candidate.rowNumber}: the bare DropX payment reference is ambiguous.`));
      continue;
    }
    const referenceNo = normalizeWorkforceBankReference(resolution.reference_no);
    const audience = String(resolution.audience ?? "").trim().toLowerCase();
    const expectedPrefix = audience === "helpers" ? "HP" : audience === "workforce" ? "WF" : null;
    if (!expectedPrefix || !isValidWorkforceBankReference(referenceNo, expectedPrefix)) {
      errors.push(`Row ${candidate.rowNumber}: the bare DropX resolver returned an invalid canonical payment reference.`);
      continue;
    }
    aliases.set(candidate.rowNumber, referenceNo);
  }

  if (errors.length) {
    const shown = errors.slice(0, 25);
    if (errors.length > shown.length) shown.push(`${errors.length - shown.length} more issue(s) were found.`);
    throw new Error(`The bank response file cannot be processed:\n${shown.map((error) => `- ${error}`).join("\n")}`);
  }
  return aliases;
}

export async function POST(request: Request) {
  try {
    if (!sameOrigin(request)) return errorResponse("Invalid request origin.", 403);
    const authorization = await getAuthorization();
    if (!authorization) return errorResponse("Sign in to finalize Workforce payments.", 401);
    const accessSurface = currentAdminAccessSurface();
    const payoutPageCode = accessSurface === "ops" ? "ops_workforce_payouts" : "workforce_payouts";
    const canUsePaymentActions = accessSurface === "ops" || hasPermission(authorization, "payment_process", "edit");
    if (authorization.readOnly || !hasPermission(authorization, payoutPageCode, "edit") || !canUsePaymentActions) {
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
    // Read and materialize the workbook once. Candidate discovery, row limits and
    // owned-row validation all reuse this prepared response.
    const prepared = prepareDropxFedOneResponse(bytes);
    const responseRowCount = prepared.dataRowCount;
    if (responseRowCount > MAX_RESPONSE_ROWS) {
      return errorResponse(`The bank response can contain at most ${MAX_RESPONSE_ROWS} data rows.`, 400);
    }
    const candidates = prepared.referenceCandidates;
    const legacyCandidates = prepared.legacyReferenceCandidates;
    if (candidates.length + legacyCandidates.length > MAX_REFERENCE_CANDIDATES) {
      return errorResponse(`The bank response can contain at most ${MAX_REFERENCE_CANDIDATES} distinct DropX-looking references.`, 400);
    }
    const rowReferenceAliases = await resolveLegacyPaymentReferences(companyId, legacyCandidates);
    const ownedReferences = await loadOwnedPaymentReferences(companyId, [
      ...new Set([...candidates, ...rowReferenceAliases.values()])
    ]);
    for (const [rowNumber, referenceNo] of rowReferenceAliases) {
      if (!ownedReferences.has(referenceNo)) {
        throw new Error(`The bank response file cannot be processed:\n- Row ${rowNumber}: the resolved payment reference no longer belongs to this company.`);
      }
    }
    if (!ownedReferences.size) {
      return Response.json({
        paid: 0,
        cancelled: 0,
        rejected: 0,
        unknown: 0,
        rows: [],
        skipped: responseRowCount
      }, { headers: noStore });
    }
    const parsed = parsePreparedDropxFedOneResponse(prepared, ownedReferences, rowReferenceAliases);
    if (parsed.workforceRows.length + parsed.helperRows.length > MAX_RESPONSE_ROWS) {
      return errorResponse(`The bank response can contain at most ${MAX_RESPONSE_ROWS} DropX payment rows.`, 400);
    }
    const fileSha256 = createHash("sha256").update(bytes).digest("hex");
    const rpcBase = {
      p_company_id: companyId,
      p_actor_user_id: authorization.userId,
      p_operation_id: operationId,
      p_file_sha256: fileSha256,
      p_file_name: file.name.slice(0, 240)
    };
    // The same Federal Bank response can contain Workforce, Helper and unrelated
    // company payments. One database transaction finalizes both owned ledgers,
    // regardless of which payout tab opened the dialog.
    const finalized = await supabaseAdmin.rpc("finalize_owned_payout_payment_response", {
      ...rpcBase,
      p_workforce_rows: normalizedRows(parsed.workforceRows),
      p_helper_rows: normalizedRows(parsed.helperRows)
    });
    if (finalized.error) return errorResponse(finalized.error.message, databaseStatus(finalized.error.message));
    return Response.json({
      ...resultRecord(finalized.data),
      skipped: parsed.skippedRows.length
    }, { headers: noStore });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to finalize the Workforce bank response.";
    return errorResponse(message, /cannot be processed|headers|worksheet|response rows|payment references|duplicate/i.test(message) ? 400 : 500);
  }
}
