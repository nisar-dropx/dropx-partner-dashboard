import { getAuthorization, hasPermission, isCompanyOwner } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import {
  normalizePaymentRecoveryTid,
  parsePaymentRecoveryWorkbook,
  type PaymentRecoveryImportIssue
} from "@/lib/payment-recovery-import";
import { readAllRows } from "@/lib/supabase-pagination";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const FILE_PATTERN = /\.(xlsx|xls|csv)$/i;
const NO_LOCATION = "00000000-0000-0000-0000-000000000000";
const noStore = { "Cache-Control": "private, no-store" };

type ProviderReferenceRow = {
  id: string;
  code: string;
  name: string;
};

type StationReferenceRow = {
  id: string;
  providerId: string | null;
};

function errorResponse(error: string, status: number) {
  return Response.json({ error }, { status, headers: noStore });
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

function normalizeReferenceCode(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

function addToMap<T>(map: Map<string, T[]>, key: string, value: T) {
  if (!key) return;
  map.set(key, [...(map.get(key) ?? []), value]);
}

function issueKey(issue: PaymentRecoveryImportIssue) {
  return `${issue.rowNumber ?? "file"}\u0000${issue.tid ?? ""}\u0000${issue.message}`;
}

export async function POST(request: Request) {
  try {
    if (!sameOrigin(request)) return errorResponse("Invalid request origin.", 403);

    const authorization = await getAuthorization();
    if (!authorization) return errorResponse("Sign in to upload payment recoveries.", 401);
    if (!hasPermission(authorization, "payment_recoveries", "add")) {
      return errorResponse("Add access to Payment Recovery is required.", 403);
    }
    if (!supabaseAdmin) return errorResponse("Database configuration is unavailable.", 503);

    const companyId = requireCompanyId(authorization);
    const hasCompanyWideAccess = authorization.hasAllLocationAccess || isCompanyOwner(authorization);
    const allowedLocationIds = new Set(authorization.locationScopeIds);
    const form = await request.formData();
    const mode = String(form.get("mode") ?? "preview").trim().toLowerCase();
    const file = form.get("file");

    if (mode !== "preview" && mode !== "commit") {
      return errorResponse("Select preview or commit mode.", 400);
    }
    if (!(file instanceof File) || !file.name || !file.size) {
      return errorResponse("Choose a payment recovery workbook.", 400);
    }
    if (!FILE_PATTERN.test(file.name)) {
      return errorResponse("Upload an Excel or CSV workbook.", 400);
    }
    if (file.size > MAX_FILE_BYTES) {
      return errorResponse("The workbook must be 5 MB or smaller.", 413);
    }

    let parsed;
    try {
      parsed = parsePaymentRecoveryWorkbook(new Uint8Array(await file.arrayBuffer()));
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "The workbook could not be read.", 400);
    }

    const [providersResult, stationsResult, existingCasesResult, previousBatchResult] = await Promise.all([
      readAllRows(supabaseAdmin.from("providers")
        .select("id,code,name")
        .eq("company_id", companyId)
        .order("id")),
      readAllRows(supabaseAdmin.from("stations")
        .select("id,station_code,provider_id")
        .eq("company_id", companyId)
        .order("id")),
      readAllRows(supabaseAdmin.from("payment_recovery_cases")
        .select("id,tid")
        .eq("company_id", companyId)
        .order("id")),
      supabaseAdmin.from("payment_recovery_import_batches")
        .select("id,created_at")
        .eq("company_id", companyId)
        .eq("file_sha256", parsed.fileSha256)
        .maybeSingle()
    ]);

    const referenceError = providersResult.error?.message
      || stationsResult.error?.message
      || existingCasesResult.error?.message
      || previousBatchResult.error?.message;
    if (referenceError) return errorResponse(referenceError, 400);

    const providersById = new Map<string, ProviderReferenceRow>();
    for (const provider of providersResult.data ?? []) {
      const id = String(provider.id);
      providersById.set(id, {
        id,
        code: normalizeReferenceCode(provider.code),
        name: String(provider.name ?? "").trim()
      });
    }

    const stationsByCode = new Map<string, StationReferenceRow[]>();
    for (const station of stationsResult.data ?? []) {
      addToMap(stationsByCode, normalizeReferenceCode(station.station_code), {
        id: String(station.id),
        providerId: station.provider_id ? String(station.provider_id) : null
      });
    }

    const existingTidByNormalized = new Map<string, string>();
    for (const recovery of existingCasesResult.data ?? []) {
      const normalized = normalizePaymentRecoveryTid(recovery.tid);
      if (normalized) existingTidByNormalized.set(normalized, String(recovery.id));
    }

    const issues: PaymentRecoveryImportIssue[] = [...parsed.issues];
    const issueKeys = new Set(issues.map(issueKey));
    const pushIssue = (issue: PaymentRecoveryImportIssue) => {
      const key = issueKey(issue);
      if (issueKeys.has(key)) return;
      issueKeys.add(key);
      issues.push(issue);
    };
    const inferredProvidersByRow = new Map<number, ProviderReferenceRow>();

    for (const row of parsed.rows) {
      const tid = row.normalizedTid || normalizePaymentRecoveryTid(row.tid);
      if (tid && existingTidByNormalized.has(tid)) {
        pushIssue({
          rowNumber: row.rowNumber,
          tid: row.tid,
          message: "This TID is already in the Recovery register."
        });
      }

      if (!row.locationCode) continue;
      const locationMatches = stationsByCode.get(normalizeReferenceCode(row.locationCode)) ?? [];
      if (!locationMatches.length) {
        pushIssue({ rowNumber: row.rowNumber, tid: row.tid, message: `Location ${row.locationCode} was not found.` });
      } else if (locationMatches.length > 1) {
        pushIssue({ rowNumber: row.rowNumber, tid: row.tid, message: `Location code ${row.locationCode} matches more than one location.` });
      } else if (!hasCompanyWideAccess && !allowedLocationIds.has(locationMatches[0].id)) {
        pushIssue({ rowNumber: row.rowNumber, tid: row.tid, message: `Location ${row.locationCode} is outside your assigned locations.` });
      } else if (!locationMatches[0].providerId) {
        pushIssue({
          rowNumber: row.rowNumber,
          tid: row.tid,
          message: `Location ${row.locationCode} is not linked to a provider. Configure its provider before importing.`
        });
      } else {
        const provider = providersById.get(locationMatches[0].providerId);
        if (!provider) {
          pushIssue({
            rowNumber: row.rowNumber,
            tid: row.tid,
            message: `Location ${row.locationCode} has an invalid provider link. Correct the location setup before importing.`
          });
        } else if (!provider.code) {
          pushIssue({
            rowNumber: row.rowNumber,
            tid: row.tid,
            message: `Location ${row.locationCode} is linked to a provider without a code. Complete the provider setup before importing.`
          });
        } else {
          inferredProvidersByRow.set(row.rowNumber, provider);
        }
      }
    }

    if (previousBatchResult.data) {
      pushIssue({
        rowNumber: null,
        tid: null,
        message: "This exact workbook was already imported. No duplicate recovery cases will be created."
      });
    }

    const totalValue = parsed.rows.reduce((sum, row) => sum + Number(row.value ?? 0), 0);
    const preview = {
      fileName: file.name,
      fileSha256: parsed.fileSha256,
      totalRows: parsed.rows.length,
      totalValue: Math.round((totalValue + Number.EPSILON) * 100) / 100,
      canCommit: issues.length === 0,
      issues,
      rows: parsed.rows.slice(0, 50).map((row) => {
        const provider = inferredProvidersByRow.get(row.rowNumber);
        return {
          rowNumber: row.rowNumber,
          tid: row.tid,
          providerCode: provider?.code ?? "",
          providerName: provider?.name ?? "",
          location: row.locationCode,
          debitMonth: row.debitMonth,
          value: row.value,
          providerReference: row.providerReference
        };
      })
    };

    if (mode === "preview") return Response.json(preview, { headers: noStore });
    if (issues.length) {
      return Response.json(
        { ...preview, error: "Correct every issue and preview the workbook again before importing." },
        { status: 400, headers: noStore }
      );
    }

    const applied = await supabaseAdmin.rpc("payment_recovery_apply_import", {
      p_company_id: companyId,
      p_file_name: file.name.slice(0, 240),
      p_file_sha256: parsed.fileSha256,
      p_rows: parsed.rows.map((row) => ({
        row_number: row.rowNumber,
        tid: row.tid,
        location: row.locationCode,
        debit_month: row.debitMonth,
        value: row.value,
        provider_reference: row.providerReference || null,
        reason: row.reason || null,
        remark: row.remark || null
      })),
      p_actor_user_id: authorization.userId,
      p_allowed_location_ids: hasCompanyWideAccess
        ? null
        : (allowedLocationIds.size ? [...allowedLocationIds] : [NO_LOCATION])
    });
    if (applied.error) {
      const conflict = /already|duplicate|unique/i.test(applied.error.message);
      return errorResponse(
        conflict
          ? "This workbook or one of its TIDs is already in the Recovery register. Preview the latest workbook and remove the duplicate data."
          : applied.error.message,
        conflict ? 409 : 400
      );
    }

    const result = applied.data && typeof applied.data === "object"
      ? applied.data as Record<string, unknown>
      : {};
    if (result.replayed === true) {
      return errorResponse("This exact workbook was already imported. No duplicate recovery cases were created.", 409);
    }

    return Response.json({
      ...preview,
      canCommit: false,
      batchId: typeof result.batch_id === "string" ? result.batch_id : null,
      message: `${parsed.rows.length} TID recovery ${parsed.rows.length === 1 ? "record was" : "records were"} imported. Select the recovery method from each register row before applying it to a payout or saving a provider dispute.`
    }, { headers: noStore });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to process the payment recovery workbook.", 500);
  }
}
