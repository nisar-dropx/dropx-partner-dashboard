import { finalizeBankResponseBatches } from "@/lib/bank-response-batches";
import { bankResponseGuidance, bankResponseFileError } from "@/lib/bank-response-guidance";
import { refreshLossPayroll } from "@/lib/ops-pulse/loss-payroll-refresh";
import { refreshWorkforcePayoutPublicationJobs } from "@/lib/workforce-payout-publication-refresh";
import { createHash } from "node:crypto";

import { revalidatePath } from "next/cache";

import { getAuthorization, hasPermission, isCompanyOwner, type AuthorizationContext } from "@/lib/authorization";
import { centralBankRpcRow, resolveCentralBankRowOwner, type CentralBankLedger } from "@/lib/central-bank-response";
import {
  summarizeCentralBankResponseRows as summarizeRows,
  type CentralBankResponseIssue
} from "@/lib/central-bank-response-summary";
import { requireCompanyId } from "@/lib/company-scope";
import { sendPaymentLocationNotification, sendPaymentNotification } from "@/lib/payment-email-notifications";
import { canReconcilePayment } from "@/lib/payment-processing-policy";
import { notifyReimbursementPayment } from "@/lib/reimbursement-payment-notifications";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  isValidWorkforceBankReference,
  normalizeWorkforceBankReference,
  parsePreparedFedOneResponseRowsPartially,
  prepareDropxFedOneResponse,
  type LegacyDropxFedOneReferenceCandidate,
  type WorkforceFedOneResponseRow
} from "@/lib/workforce-payout-bank-file";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const noStore = { "Cache-Control": "private, no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILES = 20;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_RESPONSE_ROWS_PER_FILE = 5000;
const MAX_RESPONSE_ROWS_PER_REQUEST = 20_000;
const DATABASE_ROW_OUTCOMES = new Set(["paid", "cancelled", "failed", "replayed", "rejected", "unknown"]);

type PaymentRequestOwner = {
  approval_status: string | null;
  current_approver_role_ids: string[] | null;
  current_approver_user_id: string | null;
  id: string;
  location_id: string | null;
  payment_mode: string | null;
  payment_process_role_ids: string[] | null;
  request_no: string;
  status: string | null;
};

type PayoutOwner = {
  location_id_snapshot: string | null;
  reference_no: string;
};

type PayrollOwner = {
  location_id: string | null;
  reference_no: string;
  run_id: string;
  worker_id: string;
};

type ResolvedOwnerRow = {
  approval_status?: string | null;
  current_approver_role_ids?: string[] | null;
  current_approver_user_id?: string | null;
  id?: string | null;
  ledger?: string | null;
  location_id?: string | null;
  payment_mode?: string | null;
  payment_process_role_ids?: string[] | null;
  reference_no?: string | null;
  run_id?: string | null;
  status?: string | null;
  worker_id?: string | null;
};

type OwnerMaps = {
  helpers: Map<string, PayoutOwner[]>;
  paymentRequests: Map<string, PaymentRequestOwner[]>;
  payroll: Map<string, Array<PayrollOwner & { location_id: string | null }>>;
  workforce: Map<string, PayoutOwner[]>;
};

type LegacyReferenceResolution = {
  audience?: unknown;
  message?: unknown;
  reference_no?: unknown;
  resolution_state?: unknown;
  row_number?: unknown;
};

type PaymentRequestEvent = {
  event_type?: unknown;
  payment_request_id?: unknown;
  remarks?: unknown;
  request_no?: unknown;
  status?: unknown;
};

type BankResponseRowError = CentralBankResponseIssue;

function errorResponse(error: string, status: number) {
  return Response.json({ error }, { status, headers: noStore });
}
function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

function resultRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function resultCount(record: Record<string, unknown>, key: string) {
  const value = Number(record[key] ?? 0);
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const payload = error as { code?: unknown; details?: unknown; hint?: unknown; message?: unknown };
    return [payload.message, payload.details, payload.hint, payload.code]
      .map((part) => String(part ?? "").trim())
      .filter(Boolean)
      .join(" ") || "Unable to import the bank response.";
  }
  return String(error || "Unable to import the bank response.");
}

function databaseStatus(message: string) {
  return /mismatch|conflict|processing|already|duplicate|unknown|utr|amount|account|ifsc|operation|response|reference/i.test(message)
    ? 409
    : 400;
}

function normalizedReference(value: unknown) {
  return normalizeWorkforceBankReference(value);
}

function addRowError(
  errors: Map<number, BankResponseRowError>,
  rowNumber: number,
  referenceNo: unknown,
  message: unknown,
  category: BankResponseRowError["category"] = "exceptions"
) {
  const cleanedMessage = (String(message ?? "").trim()
    || "This bank response row could not be finalized safely.")
    .replace(new RegExp(`^Row\\s+${rowNumber}:\\s*`, "i"), "")
    .replace(/\s*Nothing from this file was finalized\.?$/i, "")
    .trim();
  const normalizedMessage = cleanedMessage || "This bank response row could not be finalized safely.";
  const existing = errors.get(rowNumber);
  if (existing) {
    if (existing.category === "skipped" && category === "exceptions") existing.category = "exceptions";
    if (!existing.message.includes(normalizedMessage)) {
      existing.message = `${existing.message} ${normalizedMessage}`;
    }
    return;
  }
  errors.set(rowNumber, {
    category,
    message: normalizedMessage,
    referenceNo: normalizedReference(referenceNo),
    rowNumber
  });
}

function sortedRowErrors(errors: Map<number, BankResponseRowError>) {
  return [...errors.values()].sort((left, right) => left.rowNumber - right.rowNumber);
}

function readDatabaseRowErrors(value: unknown) {
  const errors: BankResponseRowError[] = [];
  if (!Array.isArray(value)) return errors;
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const issue = raw as Record<string, unknown>;
    const rowNumber = Number(issue.row_number ?? issue.rowNumber);
    if (!Number.isSafeInteger(rowNumber) || rowNumber <= 0) continue;
    errors.push({
      category: "exceptions",
      message: String(issue.message ?? "").trim()
        || "This bank response row could not be finalized safely.",
      referenceNo: normalizedReference(issue.reference_no ?? issue.referenceNo),
      rowNumber
    });
  }
  return errors;
}

function readDatabaseResultRows(value: unknown, expectedRows: WorkforceFedOneResponseRow[]) {
  if (!Array.isArray(value)) {
    throw new Error("The bank finalizer returned an invalid row result.");
  }
  const expectedRowNumbers = new Set(expectedRows.map((row) => row.rowNumber));
  const seen = new Set<number>();
  const rows: Record<string, unknown>[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("The bank finalizer returned an invalid row result.");
    }
    const row = raw as Record<string, unknown>;
    const rowNumber = Number(row.row_number ?? row.rowNumber);
    const outcome = String(row.outcome ?? "").trim().toLowerCase();
    if (
      !Number.isSafeInteger(rowNumber)
      || rowNumber <= 0
      || !expectedRowNumbers.has(rowNumber)
      || seen.has(rowNumber)
      || !DATABASE_ROW_OUTCOMES.has(outcome)
    ) {
      throw new Error("The bank finalizer returned an invalid or duplicate row result.");
    }
    seen.add(rowNumber);
    rows.push(row);
  }
  if (seen.size !== expectedRowNumbers.size) {
    throw new Error("The bank finalizer returned an incomplete row result.");
  }
  return rows;
}

function addToMap<Row>(map: Map<string, Row[]>, key: unknown, row: Row) {
  const normalized = normalizedReference(key);
  if (!normalized) return;
  map.set(normalized, [...(map.get(normalized) ?? []), row]);
}

function inLocationScope(authorization: AuthorizationContext, locationId: string | null | undefined) {
  if (authorization.hasAllLocationAccess) return true;
  if (!locationId || !UUID.test(locationId)) return false;
  const normalized = locationId.toLowerCase();
  return authorization.locationScopeIds.some((id) => String(id).toLowerCase() === normalized);
}

async function lookupExactOwners(companyId: string, references: string[]): Promise<OwnerMaps> {
  const database = supabaseAdmin;
  if (!database) throw new Error("Database configuration is unavailable.");
  const normalized = [...new Set(references.map(normalizedReference).filter(Boolean))];
  const resolved = await database.rpc("resolve_central_bank_response_references", {
    p_company_id: companyId,
    p_references: normalized
  });
  if (resolved.error) throw new Error(`Unable to resolve bank references: ${resolved.error.message}`);

  const paymentRequests = new Map<string, PaymentRequestOwner[]>();
  const workforce = new Map<string, PayoutOwner[]>();
  const helpers = new Map<string, PayoutOwner[]>();
  const payroll = new Map<string, Array<PayrollOwner & { location_id: string | null }>>();
  for (const row of Array.isArray(resolved.data) ? resolved.data as ResolvedOwnerRow[] : []) {
    const referenceNo = normalizedReference(row.reference_no);
    if (!referenceNo) continue;
    if (row.ledger === "payment_requests" && row.id) {
      addToMap(paymentRequests, referenceNo, {
        approval_status: row.approval_status ?? null,
        current_approver_role_ids: row.current_approver_role_ids ?? null,
        current_approver_user_id: row.current_approver_user_id ?? null,
        id: row.id,
        location_id: row.location_id ?? null,
        payment_mode: row.payment_mode ?? null,
        payment_process_role_ids: row.payment_process_role_ids ?? null,
        request_no: referenceNo,
        status: row.status ?? null
      });
    } else if (row.ledger === "workforce") {
      addToMap(workforce, referenceNo, { location_id_snapshot: row.location_id ?? null, reference_no: referenceNo });
    } else if (row.ledger === "helpers") {
      addToMap(helpers, referenceNo, { location_id_snapshot: row.location_id ?? null, reference_no: referenceNo });
    } else if (row.ledger === "people_payroll" && row.run_id && row.worker_id) {
      addToMap(payroll, referenceNo, {
        location_id: row.location_id ?? null,
        reference_no: referenceNo,
        run_id: row.run_id,
        worker_id: row.worker_id
      });
    }
  }
  return { helpers, paymentRequests, payroll, workforce };
}

async function lookupPayoutAliases(companyId: string, references: string[], maps: OwnerMaps) {
  if (!references.length) return;
  const database = supabaseAdmin;
  if (!database) throw new Error("Database configuration is unavailable.");
  const resolved = await database.rpc("resolve_central_bank_response_references", {
    p_company_id: companyId,
    p_references: [...new Set(references)]
  });
  if (resolved.error) throw new Error(`Unable to resolve payout reference aliases: ${resolved.error.message}`);
  for (const row of Array.isArray(resolved.data) ? resolved.data as ResolvedOwnerRow[] : []) {
    const referenceNo = normalizedReference(row.reference_no);
    if (row.ledger === "workforce") addToMap(maps.workforce, referenceNo, { location_id_snapshot: row.location_id ?? null, reference_no: referenceNo });
    if (row.ledger === "helpers") addToMap(maps.helpers, referenceNo, { location_id_snapshot: row.location_id ?? null, reference_no: referenceNo });
  }
}

async function resolveLegacyPaymentReferences(
  companyId: string,
  candidates: LegacyDropxFedOneReferenceCandidate[],
  rowErrors: Map<number, BankResponseRowError>
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
  if (resolved.error) throw new Error(`Unable to safely resolve bare DropX payment references: ${resolved.error.message}`);

  const byRow = new Map<number, LegacyReferenceResolution>();
  for (const raw of Array.isArray(resolved.data) ? resolved.data as LegacyReferenceResolution[] : []) {
    const rowNumber = Number(raw.row_number);
    if (!Number.isSafeInteger(rowNumber) || rowNumber <= 0 || byRow.has(rowNumber)) {
      throw new Error("The bare DropX payment reference resolver returned invalid or duplicate row evidence.");
    }
    byRow.set(rowNumber, raw);
  }
  for (const candidate of candidates) {
    const resolution = byRow.get(candidate.rowNumber);
    if (!resolution) {
      throw new Error("The bare DropX payment reference resolver returned an incomplete result.");
    }
    const state = String(resolution.resolution_state ?? "").trim().toLowerCase();
    if (state === "unrelated") continue;
    if (state === "error") {
      addRowError(
        rowErrors,
        candidate.rowNumber,
        candidate.dropxId,
        resolution.message ?? "This known reference has mismatched or ambiguous payment data.",
        "exceptions"
      );
      continue;
    }
    if (state !== "resolved") {
      throw new Error("The bare DropX payment reference resolver returned an invalid result state.");
    }
    const referenceNo = normalizedReference(resolution.reference_no);
    const audience = String(resolution.audience ?? "").trim().toLowerCase();
    const expectedPrefix = audience === "helpers" ? "HP" : audience === "workforce" ? "WF" : null;
    if (!expectedPrefix || !isValidWorkforceBankReference(referenceNo, expectedPrefix)) {
      throw new Error("The bare DropX payment reference resolver returned an invalid canonical payment reference.");
    }
    aliases.set(candidate.rowNumber, referenceNo);
  }
  return aliases;
}

function uniqueOwner<Row>(rows: Row[] | undefined, ledger: CentralBankLedger, referenceNo: string, rowNumber: number) {
  if ((rows?.length ?? 0) > 1) {
    throw new Error(`Row ${rowNumber}: reference “${referenceNo}” resolves to multiple records in ${ledger}. Nothing from this file was finalized.`);
  }
  return rows?.[0] ?? null;
}

function validateOwnedBankRow(row: WorkforceFedOneResponseRow, ledger: CentralBankLedger) {
  if (!row.status) throw new Error(`Row ${row.rowNumber}: Status is required.`);
  if (ledger !== "payroll" && row.status !== "PAID" && row.status !== "CANCELLED" && row.status !== "CANCELED") {
    throw new Error(`Row ${row.rowNumber}: Status must be PAID or CANCELLED.`);
  }
  if (row.status === "PAID" && !row.utrCin) {
    throw new Error(`Row ${row.rowNumber}: UTR/CIN is required when Status is PAID.`);
  }
}

async function sendPaymentRequestSideEffects(input: {
  actorUserId: string;
  companyId: string;
  event: PaymentRequestEvent;
}) {
  const requestId = String(input.event.payment_request_id ?? "").trim();
  if (!requestId) return;
  const remarks = String(input.event.remarks ?? "").trim() || null;
  if (String(input.event.status ?? "").trim().toLowerCase() === "paid") {
    await Promise.allSettled([
      notifyReimbursementPayment({
        actorUserId: input.actorUserId,
        companyId: input.companyId,
        paymentRequestId: requestId,
        remarks,
        status: "paid"
      }),
      sendPaymentLocationNotification({
        companyId: input.companyId,
        eventType: "payment_processed",
        requestId
      })
    ]);
    return;
  }
  const returnedRemarks = remarks || "Payment Failed - Cancelled by bank";
  await Promise.allSettled([
    sendPaymentNotification({
      actorUserId: input.actorUserId,
      companyId: input.companyId,
      eventType: "payment_return",
      remarks: returnedRemarks,
      requestId
    }),
    notifyReimbursementPayment({
      actorUserId: input.actorUserId,
      companyId: input.companyId,
      paymentRequestId: requestId,
      remarks: returnedRemarks,
      status: "returned"
    })
  ]);
}

async function processFile(input: {
  authorization: AuthorizationContext;
  bytes: Uint8Array;
  companyId: string;
  file: File;
  prepared: ReturnType<typeof prepareDropxFedOneResponse>;
  deadlineAt?: number;
}) {
  const { bytes, prepared } = input;
  const deadlineAt = input.deadlineAt ?? Date.now() + 150_000;
  const summarizeCentralBankResponseRows = (value: Parameters<typeof summarizeRows>[0]) => {
    const groups = summarizeRows(value);
    const headers = prepared.responseSheet.rows[prepared.responseSheet.headerIndex];
    return Object.fromEntries(Object.entries(groups).map(([key, rows]) => [key, rows.map(row => {
      const guidance = bankResponseGuidance(row.message, row.outcome);
      const index = guidance.column ? headers.findIndex(header => String(header).trim().toLowerCase() === guidance.column.toLowerCase()) : -1;
      let columnLetter = "";
      for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) columnLetter = String.fromCharCode(65 + (n - 1) % 26) + columnLetter;
      return { ...row, ...guidance, cell: columnLetter ? `${columnLetter}${row.rowNumber}` : "" };
    })]));
  };
  if (prepared.dataRowCount === 0) {
    throw new Error("No payment response rows were found below the bank response headers.");
  }
  if (prepared.dataRowCount > MAX_RESPONSE_ROWS_PER_FILE) {
    throw new Error(`A bank response can contain at most ${MAX_RESPONSE_ROWS_PER_FILE} data rows.`);
  }

  const rowErrors = new Map<number, BankResponseRowError>();
  const rawReferences = [...new Set(prepared.allReferenceCandidates.map((candidate) => candidate.referenceNo))];
  const ownerMaps = rawReferences.length
    ? await lookupExactOwners(input.companyId, rawReferences)
    : {
        helpers: new Map<string, PayoutOwner[]>(),
        paymentRequests: new Map<string, PaymentRequestOwner[]>(),
        payroll: new Map<string, Array<PayrollOwner & { location_id: string | null }>>(),
        workforce: new Map<string, PayoutOwner[]>()
      };
  // Resolve every bare-DropX candidate even when its raw value also matches a
  // generic or payroll reference. That second ownership signal is what lets
  // the ambiguity guard refuse namespace collisions rather than guessing.
  const rowAliases = await resolveLegacyPaymentReferences(
    input.companyId,
    prepared.legacyReferenceCandidates,
    rowErrors
  );
  await lookupPayoutAliases(input.companyId, [...rowAliases.values()], ownerMaps);

  const ownerByRow = new Map<number, CentralBankLedger>();
  const permittedReferences = new Set<string>();
  const canEditPayouts = hasPermission(input.authorization, "workforce_payouts", "edit");
  const owner = isCompanyOwner(input.authorization);

  for (const candidate of prepared.allReferenceCandidates) {
    if (rowErrors.has(candidate.rowNumber)) continue;
    const rawReference = normalizedReference(candidate.referenceNo);
    const canonicalReference = rowAliases.get(candidate.rowNumber) ?? rawReference;
    let paymentRequest: PaymentRequestOwner | null = null;
    let payroll: (PayrollOwner & { location_id: string | null }) | null = null;
    let workforce: PayoutOwner | null = null;
    let helper: PayoutOwner | null = null;
    let ledger: CentralBankLedger | null = null;
    try {
      paymentRequest = uniqueOwner(ownerMaps.paymentRequests.get(rawReference), "payment_requests", rawReference, candidate.rowNumber);
      payroll = uniqueOwner(ownerMaps.payroll.get(rawReference), "payroll", rawReference, candidate.rowNumber);
      workforce = uniqueOwner(ownerMaps.workforce.get(canonicalReference), "workforce", canonicalReference, candidate.rowNumber);
      helper = uniqueOwner(ownerMaps.helpers.get(canonicalReference), "helpers", canonicalReference, candidate.rowNumber);
      ledger = resolveCentralBankRowOwner({
        matches: {
          helpers: Boolean(helper),
          payment_requests: Boolean(paymentRequest),
          payroll: Boolean(payroll),
          workforce: Boolean(workforce)
        },
        referenceNo: rawReference,
        rowNumber: candidate.rowNumber
      });
    } catch (error) {
      // Do not reveal whether an ambiguous reference exists outside the
      // uploader's permitted locations. Detailed bank-evidence errors are
      // returned only after this ownership and scope gate succeeds.
      addRowError(
        rowErrors,
        candidate.rowNumber,
        rawReference,
        input.authorization.hasAllLocationAccess ? errorMessage(error) : "No matching payment instruction is available in your permitted scope.",
        "exceptions"
      );
      continue;
    }
    if (!ledger) {
      addRowError(
        rowErrors,
        candidate.rowNumber,
        rawReference,
        input.authorization.hasAllLocationAccess ? "Customer Ref. No. does not match a payment instruction." : "No matching payment instruction is available in your permitted scope.",
        "skipped"
      );
      continue;
    }

    let permitted = false;
    if (ledger === "payment_requests" && paymentRequest) {
      permitted = (paymentRequest.payment_mode ?? "account_transfer") === "account_transfer"
        && canReconcilePayment(input.authorization, paymentRequest, owner);
    } else if (ledger === "workforce" && workforce) {
      permitted = canEditPayouts && inLocationScope(input.authorization, workforce.location_id_snapshot);
    } else if (ledger === "helpers" && helper) {
      permitted = canEditPayouts && inLocationScope(input.authorization, helper.location_id_snapshot);
    } else if (ledger === "payroll" && payroll) {
      permitted = inLocationScope(input.authorization, payroll.location_id);
    }
    if (!permitted) {
      addRowError(
        rowErrors,
        candidate.rowNumber,
        rawReference,
        !inLocationScope(input.authorization, paymentRequest?.location_id ?? payroll?.location_id ?? workforce?.location_id_snapshot ?? helper?.location_id_snapshot)
          ? "No matching payment instruction is available in your permitted scope."
          : ledger === "payment_requests" && paymentRequest
            ? (paymentRequest.payment_mode ?? "account_transfer") !== "account_transfer"
              ? "This request uses a different payment method."
              : !owner && !(paymentRequest.payment_process_role_ids ?? []).some(id => input.authorization.effectiveRoleIds.includes(id) || id === input.authorization.roleId)
                ? "Your current role cannot reconcile this payment."
                : "This request is not ready for bank reconciliation. Check its approval and payment state."
            : "Your current role cannot reconcile this payment ledger.",
        "exceptions"
      );
      continue;
    }
    ownerByRow.set(candidate.rowNumber, ledger);
    permittedReferences.add(canonicalReference);
  }

  const parsed = parsePreparedFedOneResponseRowsPartially(prepared, permittedReferences, rowAliases);
  for (const issue of parsed.rowErrors) {
    addRowError(rowErrors, issue.rowNumber, issue.referenceNo, issue.message);
  }
  for (const skipped of parsed.skippedRows) {
    if (!rowErrors.has(skipped.rowNumber)) {
      addRowError(
        rowErrors,
        skipped.rowNumber,
        skipped.referenceNo,
        "No matching payment instruction is available in your permitted scope.",
        "skipped"
      );
    }
  }
  const rowsByLedger: Record<CentralBankLedger, WorkforceFedOneResponseRow[]> = {
    helpers: [],
    payment_requests: [],
    payroll: [],
    workforce: []
  };
  for (const row of parsed.rows) {
    const ledger = ownerByRow.get(row.rowNumber);
    if (!ledger) {
      addRowError(
        rowErrors,
        row.rowNumber,
        row.referenceNo,
        "Payment ownership changed while this row was being validated.",
        "skipped"
      );
      continue;
    }
    try {
      validateOwnedBankRow(row, ledger);
    } catch (error) {
      addRowError(rowErrors, row.rowNumber, row.referenceNo, errorMessage(error));
      continue;
    }
    rowsByLedger[ledger].push(row);
  }

  const rowsForFinalization = Object.values(rowsByLedger).flat();
  if (!rowsForFinalization.length) {
    const issues = sortedRowErrors(rowErrors);
    return {
      cancelledRows: 0,
      failedRows: 0,
      fileName: input.file.name,
      ledgerRows: { helpers: 0, paymentRequests: 0, payroll: 0, workforce: 0 },
      matched: 0,
      ok: true,
      paidRows: 0,
      processedRows: 0,
      errorRows: rowErrors.size,
      resultGroups: summarizeCentralBankResponseRows({ databaseRows: [], issues, replayedFile: false }),
      rowErrors: issues,
      skipped: prepared.dataRowCount
    };
  }

  const rawFileSha256 = createHash("sha256").update(bytes).digest("hex");
  const databaseResult = await finalizeBankResponseBatches({
    rows: rowsForFinalization,
    deadlineAt,
    finalize: async (batch) => {
      const subset = (ledger: CentralBankLedger) => batch.filter(row => ownerByRow.get(row.rowNumber) === ledger).map(centralBankRpcRow);
      const finalized = await supabaseAdmin!.rpc("finalize_central_bank_response_partially", {
        p_actor_user_id: input.authorization.userId,
        p_company_id: input.companyId,
        p_file_name: input.file.name.slice(0, 240),
        p_file_sha256: rawFileSha256,
        p_operation_id: crypto.randomUUID(),
        p_helper_rows: subset("helpers"),
        p_payment_request_rows: subset("payment_requests"),
        p_payroll_rows: subset("payroll"),
        p_workforce_rows: subset("workforce")
      });
      if (finalized.error) throw new Error(bankResponseFileError(finalized.error.message));
      const part = resultRecord(finalized.data);
      readDatabaseResultRows(part.rows, batch);
      return part;
    }
  });
  const databaseRows = readDatabaseResultRows(databaseResult.rows, rowsForFinalization);
  const databaseOutcomeByRow = new Map<number, string>();
  for (const raw of databaseRows) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const rowNumber = Number(row.row_number ?? row.rowNumber);
    if (!Number.isSafeInteger(rowNumber) || rowNumber <= 0) continue;
    databaseOutcomeByRow.set(rowNumber, String(row.outcome ?? "").trim().toLowerCase());
  }
  for (const issue of readDatabaseRowErrors(databaseResult.row_errors)) {
    addRowError(
      rowErrors,
      issue.rowNumber,
      issue.referenceNo,
      issue.message,
      databaseOutcomeByRow.get(issue.rowNumber) === "unknown" ? "skipped" : "exceptions"
    );
  }
  const paymentRequestEvents = Array.isArray(databaseResult.payment_request_events)
    ? databaseResult.payment_request_events as PaymentRequestEvent[]
    : [];
  if (paymentRequestEvents.length) {
    await Promise.allSettled(paymentRequestEvents.map((event) => sendPaymentRequestSideEffects({
        actorUserId: input.authorization.userId,
        companyId: input.companyId,
        event
      })));
  }

  const failedRows = resultCount(databaseResult, "failed");
  const totalCancelled = resultCount(databaseResult, "cancelled");
  const replayedFile = databaseResult.replayed === true;
  const issues = sortedRowErrors(rowErrors);
  const databaseErrorRows = new Set(databaseRows
    .filter((row) => ["rejected", "unknown"].includes(String(row.outcome ?? "").trim().toLowerCase()))
    .map((row) => Number(row.row_number ?? row.rowNumber)));
  const successfullyMatchedRows = rowsForFinalization.filter((row) => !databaseErrorRows.has(row.rowNumber));
  const successfulRowsByLedger = (ledger: CentralBankLedger) => rowsByLedger[ledger]
    .filter((row) => !databaseErrorRows.has(row.rowNumber)).length;

  return {
    cancelledRows: Math.max(0, totalCancelled - failedRows),
    fileName: input.file.name,
    ledgerRows: {
      helpers: successfulRowsByLedger("helpers"),
      paymentRequests: successfulRowsByLedger("payment_requests"),
      payroll: successfulRowsByLedger("payroll"),
      workforce: successfulRowsByLedger("workforce")
    },
    matched: successfullyMatchedRows.length,
    ok: true,
    paidRows: resultCount(databaseResult, "paid"),
    processedRows: successfullyMatchedRows.length,
    errorRows: rowErrors.size,
    failedRows,
    replayedFile,
    rejectedRows: resultCount(databaseResult, "rejected"),
    replayedRows: resultCount(databaseResult, "replayed_items"),
    resultGroups: summarizeCentralBankResponseRows({
      databaseRows,
      issues,
      replayedFile,
      replayedRowNumbers: databaseResult.replayed_row_numbers
    }),
    rowErrors: issues,
    unknownRows: resultCount(databaseResult, "unknown"),
    skipped: Math.max(0, prepared.dataRowCount - successfullyMatchedRows.length)
  };
}

export async function POST(request: Request) {
  try {
    if (!sameOrigin(request)) return errorResponse("Invalid request origin.", 403);
    const authorization = await getAuthorization();
    if (!authorization) return errorResponse("Sign in to import bank responses.", 401);
    if (authorization.readOnly || !hasPermission(authorization, "payment_process", "edit")) {
      return errorResponse("Edit access to Payment Process is required.", 403);
    }
    if (!supabaseAdmin) return errorResponse("Database configuration is unavailable.", 503);
    const companyId = requireCompanyId(authorization);

    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_TOTAL_BYTES + 512 * 1024) {
      return errorResponse("The selected bank response files are too large.", 413);
    }
    const form = await request.formData();
    const files = form.getAll("bank_response_files").filter((value): value is File => value instanceof File && value.size > 0);
    if (!files.length) return errorResponse("Select at least one bank response Excel file.", 400);
    if (files.length > MAX_FILES) return errorResponse(`Select no more than ${MAX_FILES} files at a time.`, 400);
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_TOTAL_BYTES) return errorResponse("The selected files must total 50 MB or less.", 413);
    const invalidFile = files.find((file) => file.size > MAX_FILE_BYTES || !/\.xlsx?$/i.test(file.name));
    if (invalidFile) {
      const issue = invalidFile.size > MAX_FILE_BYTES ? "must be 10 MB or smaller" : "must be an .xlsx or .xls file";
      return errorResponse(`${invalidFile.name} ${issue}.`, invalidFile.size > MAX_FILE_BYTES ? 413 : 400);
    }

    let totalRows = 0;
    const deadlineAt = Date.now() + 150_000;
    const results = [] as Array<Record<string, unknown>>;
    for (const file of files) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const prepared = prepareDropxFedOneResponse(bytes);
        totalRows += prepared.dataRowCount;
        if (totalRows > MAX_RESPONSE_ROWS_PER_REQUEST) {
          throw new Error(`One upload can contain at most ${MAX_RESPONSE_ROWS_PER_REQUEST} bank response rows across all files.`);
        }
        const result = await processFile({ authorization, bytes, companyId, file, prepared, deadlineAt });
        results.push(result);
      } catch (error) {
        results.push({ error: bankResponseFileError(errorMessage(error)), fileName: file.name, ok: false });
      }
    }

    let payrollRefresh: Awaited<ReturnType<typeof refreshLossPayroll>> | null = null;
    if (results.some((result) => Number(result.paidRows ?? 0) + Number(result.cancelledRows ?? 0) + Number(result.failedRows ?? 0) > 0)) {
      payrollRefresh = await refreshLossPayroll(companyId).catch(() => null);
      await refreshWorkforcePayoutPublicationJobs({companyId,limit:20,deadlineAtMs:Date.now()+45_000}).catch(() => null);
      revalidatePath("/payments/process");
      revalidatePath("/payments/requests");
      revalidatePath("/payments/approvals");
      revalidatePath("/payments/report");
      revalidatePath("/payments/workforce-payouts");
    }
    return Response.json({ results, payrollRefresh }, { headers: noStore });
  } catch (error) {
    const message = errorMessage(error);
    return errorResponse(message, databaseStatus(message));
  }
}
