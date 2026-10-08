import { getAuthorization, hasPermission, isCompanyOwner } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import {
  normalizePaymentRecoveryPersonId,
  normalizePaymentRecoveryTid,
  parsePaymentRecoveryWorkbook,
  type PaymentRecoveryImportIssue,
  type PaymentRecoveryImportRow
} from "@/lib/payment-recovery-import";
import { readAllRows } from "@/lib/supabase-pagination";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const FILE_PATTERN = /\.(xlsx|xls|csv)$/i;
const NO_LOCATION = "00000000-0000-0000-0000-000000000000";
const noStore = { "Cache-Control": "private, no-store" };

type ReferenceRow = {
  id: string;
};

type StationReferenceRow = ReferenceRow & {
  isActive: boolean;
  providerId: string | null;
};

type PersonRow = {
  identityKey: string;
  locationId: string | null;
  preferCanonical: boolean;
};

type UnsupportedPersonRow = { dropx_id?: unknown };

type TargetState = "linked" | "pending";

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

function addSupportedPerson(map: Map<string, PersonRow[]>, dropxId: unknown, person: PersonRow) {
  const normalizedId = normalizePaymentRecoveryPersonId(dropxId);
  if (!normalizedId) return;
  const matches = map.get(normalizedId) ?? [];
  const existingIndex = matches.findIndex((match) => match.identityKey === person.identityKey);
  if (existingIndex < 0) {
    map.set(normalizedId, [...matches, person]);
    return;
  }
  if (!person.preferCanonical || matches[existingIndex].preferCanonical) return;
  const collapsed = [...matches];
  collapsed[existingIndex] = person;
  map.set(normalizedId, collapsed);
}

function issueKey(issue: PaymentRecoveryImportIssue) {
  return `${issue.rowNumber ?? "file"}\u0000${issue.tid ?? ""}\u0000${issue.message}`;
}

function rowRecoveryMethod(row: PaymentRecoveryImportRow) {
  if (row.recoveryMethod === "PAYOUT_DEDUCTION") return "payout_deduction" as const;
  if (row.recoveryMethod === "POST_INVOICE_DISPUTE") return "post_invoice_dispute" as const;
  return null;
}

function previewLinkStatus(row: PaymentRecoveryImportRow, states: TargetState[]) {
  if (row.recoveryMethod === "POST_INVOICE_DISPUTE") return "not_required";
  if (states.length !== row.recoveryIds.length) return "invalid";
  if (!states.length) return "invalid";
  if (states.every((state) => state === "linked")) return "linked";
  if (states.every((state) => state === "pending")) return "pending";
  return "mixed";
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

    const [
      providersResult,
      stationsResult,
      employeesResult,
      contractorsResult,
      workforceResult,
      helpersResult,
      vendorsResult,
      workforceHelpersResult,
      workforcePickersResult,
      existingCasesResult,
      previousBatchResult
    ] = await Promise.all([
      readAllRows(supabaseAdmin.from("providers")
        .select("id,code,name")
        .eq("company_id", companyId)
        .order("id")),
      readAllRows(supabaseAdmin.from("stations")
        .select("id,station_code,station_name,provider_id,is_active")
        .eq("company_id", companyId)
        .order("id")),
      readAllRows(supabaseAdmin.from("employees")
        .select("id,employee_code,full_name,location_id")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .is("deleted_at", null)
        .order("id")),
      readAllRows(supabaseAdmin.from("contractors")
        .select("id,dropx_id,full_name,location_id")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .is("deleted_at", null)
        .order("id")),
      readAllRows(supabaseAdmin.from("workforce")
        .select("id,dropx_id,full_name,location_id,source_profile_type,source_profile_id")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .is("deleted_at", null)
        .or("migration_state.is.null,migration_state.not.in.(reclassified,moved_to_vendor)")
        .order("id")),
      readAllRows(supabaseAdmin.from("helpers")
        .select("id,dropx_id")
        .eq("company_id", companyId)
        .order("id")),
      readAllRows(supabaseAdmin.from("vendors")
        .select("id,dropx_id")
        .eq("company_id", companyId)
        .order("id")),
      readAllRows(supabaseAdmin.from("workforce_helpers")
        .select("id,dropx_id")
        .eq("company_id", companyId)
        .order("id")),
      readAllRows(supabaseAdmin.from("workforce_pickers")
        .select("id,dropx_id")
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
      || employeesResult.error?.message
      || contractorsResult.error?.message
      || workforceResult.error?.message
      || helpersResult.error?.message
      || vendorsResult.error?.message
      || workforceHelpersResult.error?.message
      || workforcePickersResult.error?.message
      || existingCasesResult.error?.message
      || previousBatchResult.error?.message;
    if (referenceError) return errorResponse(referenceError, 400);

    const providersByCode = new Map<string, ReferenceRow[]>();
    for (const provider of providersResult.data ?? []) {
      const code = normalizeReferenceCode(provider.code);
      addToMap(providersByCode, code, {
        id: String(provider.id)
      });
    }

    const stationsByCode = new Map<string, StationReferenceRow[]>();
    const stationById = new Map<string, StationReferenceRow>();
    for (const station of stationsResult.data ?? []) {
      const code = normalizeReferenceCode(station.station_code);
      const reference = {
        id: String(station.id),
        isActive: station.is_active === true,
        providerId: station.provider_id ? String(station.provider_id) : null
      };
      addToMap(stationsByCode, code, reference);
      stationById.set(reference.id, reference);
    }

    const supportedPeopleById = new Map<string, PersonRow[]>();
    for (const employee of employeesResult.data ?? []) {
      addSupportedPerson(supportedPeopleById, employee.employee_code, {
        identityKey: `employee:${String(employee.id)}`,
        locationId: employee.location_id ? String(employee.location_id) : null,
        preferCanonical: false
      });
    }
    for (const contractor of contractorsResult.data ?? []) {
      addSupportedPerson(supportedPeopleById, contractor.dropx_id, {
        identityKey: `contractor:${String(contractor.id)}`,
        locationId: contractor.location_id ? String(contractor.location_id) : null,
        preferCanonical: false
      });
    }
    for (const worker of workforceResult.data ?? []) {
      const sourceType = String(worker.source_profile_type ?? "").trim().toLowerCase();
      const sourceId = String(worker.source_profile_id ?? "").trim();
      const mirrorsSource = (sourceType === "employee" || sourceType === "contractor") && sourceId;
      addSupportedPerson(supportedPeopleById, worker.dropx_id, {
        identityKey: mirrorsSource ? `${sourceType}:${sourceId}` : `workforce:${String(worker.id)}`,
        locationId: worker.location_id ? String(worker.location_id) : null,
        preferCanonical: true
      });
    }

    const unsupportedPeopleById = new Map<string, string[]>();
    const addUnsupportedPeople = (rows: UnsupportedPersonRow[], category: string) => {
      for (const row of rows) {
        addToMap(
          unsupportedPeopleById,
          normalizePaymentRecoveryPersonId(row.dropx_id),
          category
        );
      }
    };
    addUnsupportedPeople(helpersResult.data ?? [], "Helper");
    addUnsupportedPeople(vendorsResult.data ?? [], "Vendor");
    addUnsupportedPeople(workforceHelpersResult.data ?? [], "Legacy Helper");
    addUnsupportedPeople(workforcePickersResult.data ?? [], "Legacy Picker");

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
    const targetStatesByRow = new Map<number, TargetState[]>();

    for (const row of parsed.rows) {
      const tid = row.normalizedTid || normalizePaymentRecoveryTid(row.tid);
      if (tid) {
        if (existingTidByNormalized.has(tid)) {
          pushIssue({
            rowNumber: row.rowNumber,
            tid: row.tid,
            message: "This TID is already in the Recovery register."
          });
        }
      }

      if (row.providerCode) {
        const providerMatches = providersByCode.get(normalizeReferenceCode(row.providerCode)) ?? [];
        if (!providerMatches.length) {
          pushIssue({ rowNumber: row.rowNumber, tid: row.tid, message: `Provider ${row.providerCode} was not found.` });
        } else if (providerMatches.length > 1) {
          pushIssue({ rowNumber: row.rowNumber, tid: row.tid, message: `Provider code ${row.providerCode} matches more than one provider.` });
        }
      }

      if (row.locationCode) {
        const locationMatches = stationsByCode.get(normalizeReferenceCode(row.locationCode)) ?? [];
        if (!locationMatches.length) {
          pushIssue({ rowNumber: row.rowNumber, tid: row.tid, message: `Location ${row.locationCode} was not found.` });
        } else if (locationMatches.length > 1) {
          pushIssue({ rowNumber: row.rowNumber, tid: row.tid, message: `Location code ${row.locationCode} matches more than one location.` });
        } else if (!hasCompanyWideAccess && !allowedLocationIds.has(locationMatches[0].id)) {
          pushIssue({ rowNumber: row.rowNumber, tid: row.tid, message: `Location ${row.locationCode} is outside your assigned locations.` });
        }
      }

      if (row.providerCode && row.locationCode) {
        const providerMatches = providersByCode.get(normalizeReferenceCode(row.providerCode)) ?? [];
        const locationMatches = stationsByCode.get(normalizeReferenceCode(row.locationCode)) ?? [];
        if (
          providerMatches.length === 1
          && locationMatches.length === 1
          && locationMatches[0].providerId !== providerMatches[0].id
        ) {
          pushIssue({
            rowNumber: row.rowNumber,
            tid: row.tid,
            message: `Location ${row.locationCode} is not configured for provider ${row.providerCode}. Choose a location assigned to that provider.`
          });
        }
      }

      const states: TargetState[] = [];
      if (row.recoveryMethod === "PAYOUT_DEDUCTION") {
        for (const recoveryId of row.recoveryIds) {
          const normalizedId = normalizePaymentRecoveryPersonId(recoveryId);
          const matches = supportedPeopleById.get(normalizedId) ?? [];
          const unsupportedCategories = unsupportedPeopleById.get(normalizedId) ?? [];
          if (matches.length > 1) {
            pushIssue({
              rowNumber: row.rowNumber,
              tid: row.tid,
              message: `Recovery ID ${recoveryId} matches more than one People profile. Correct the duplicate profile before importing.`
            });
            continue;
          }
          if (matches.length === 1) {
            const person = matches[0];
            const location = person.locationId ? stationById.get(person.locationId) : undefined;
            if (!location) {
              pushIssue({
                rowNumber: row.rowNumber,
                tid: row.tid,
                message: `Recovery ID ${recoveryId} does not have a valid company location.`
              });
              continue;
            }
            if (!location.isActive) {
              pushIssue({
                rowNumber: row.rowNumber,
                tid: row.tid,
                message: `Recovery ID ${recoveryId} is assigned to an inactive location. Update the People profile to an active location before importing.`
              });
              continue;
            }
            if (!hasCompanyWideAccess && !allowedLocationIds.has(location.id)) {
              pushIssue({
                rowNumber: row.rowNumber,
                tid: row.tid,
                message: `Recovery ID ${recoveryId} is outside your assigned locations.`
              });
              continue;
            }
            states.push("linked");
            continue;
          }
          if (unsupportedCategories.length) {
            pushIssue({
              rowNumber: row.rowNumber,
              tid: row.tid,
              message: `Recovery ID ${recoveryId} belongs to an unsupported category (${[...new Set(unsupportedCategories)].join(", ")}).`
            });
            continue;
          }
          if (!hasCompanyWideAccess) {
            pushIssue({
              rowNumber: row.rowNumber,
              tid: row.tid,
              message: `Recovery ID ${recoveryId} is not registered. Company-wide location access is required to retain it as awaiting registration.`
            });
            continue;
          }
          states.push("pending");
        }
      }
      targetStatesByRow.set(row.rowNumber, states);
    }

    if (previousBatchResult.data) {
      pushIssue({
        rowNumber: null,
        tid: null,
        message: "This exact workbook was already imported. No duplicate recovery cases will be created."
      });
    }

    const payoutRows = parsed.rows.filter((row) => row.recoveryMethod === "PAYOUT_DEDUCTION").length;
    const disputeRows = parsed.rows.filter((row) => row.recoveryMethod === "POST_INVOICE_DISPUTE").length;
    const linkedAllocations = [...targetStatesByRow.values()].flat().filter((state) => state === "linked").length;
    const pendingAllocations = [...targetStatesByRow.values()].flat().filter((state) => state === "pending").length;
    const preview = {
      fileName: file.name,
      fileSha256: parsed.fileSha256,
      totalRows: parsed.rows.length,
      payoutRows,
      disputeRows,
      linkedAllocations,
      pendingAllocations,
      canCommit: issues.length === 0,
      issues,
      rows: parsed.rows.slice(0, 50).map((row) => {
        const states = targetStatesByRow.get(row.rowNumber) ?? [];
        return {
          rowNumber: row.rowNumber,
          tid: row.tid,
          providerCode: row.providerCode,
          location: row.locationCode,
          debitDate: row.debitDate,
          debitAmount: row.debitAmount,
          recoveryMethod: row.recoveryMethod,
          recoveryIds: row.recoveryIds,
          allocationCount: row.recoveryIds.length,
          linkStatus: previewLinkStatus(row, states)
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
        provider_code: row.providerCode,
        location: row.locationCode,
        debit_date: row.debitDate,
        debit_amount: row.debitAmount,
        recovery_method: rowRecoveryMethod(row),
        provider_reference: row.providerReference || null,
        reason: row.reason || null,
        remark: row.remark || null,
        targets: row.recoveryIds.map((dropxId) => ({ dropx_id: dropxId }))
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
      message: `${parsed.rows.length} TID recovery ${parsed.rows.length === 1 ? "case was" : "cases were"} imported as recovery plans. No payout deduction or provider dispute was submitted.`
    }, { headers: noStore });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to process the payment recovery workbook.", 500);
  }
}
