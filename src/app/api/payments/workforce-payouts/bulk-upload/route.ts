import { createHash } from "node:crypto";
import { currentAdminAccessSurface } from "@/lib/access-surface";
import { getAuthorization, hasPermission, isCompanyOwner } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { readAllRows } from "@/lib/supabase-pagination";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  normalizeWorkforcePayoutCode,
  parseWorkforcePayoutWorkbook,
  payoutImportRowsOverlap,
  resolveWorkforcePayoutImportRows,
  type ResolvedWorkforcePayoutImportRow,
  type WorkforcePayoutImportAdditionalField,
  type WorkforcePayoutImportDeductionHead,
  type WorkforcePayoutImportIssue,
  type WorkforcePayoutImportPaymentField,
  type WorkforcePayoutImportSetup,
  type WorkforcePayoutImportWorker
} from "@/lib/workforce-payout-import";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const FILE_PATTERN = /\.(xlsx|xls|csv)$/i;

function errorResponse(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "private, no-store" } });
}

function payoutPageCode() {
  return currentAdminAccessSurface() === "ops" ? "ops_workforce_payouts" : "workforce_payouts";
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

async function loadReferences(companyId: string, batchFrom: string, batchTo: string) {
  if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
  const [workersResult, paymentFieldsResult, additionalFieldsResult, deductionHeadsResult, mappingsResult, allocationsResult, stationsResult] = await Promise.all([
    readAllRows(supabaseAdmin
      .from("workforce")
      .select("id,dropx_id,full_name,location_id,date_of_join,last_working_date,is_active,deleted_at,migration_state,source_profile_type,source_profile_id")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .order("id")),
    readAllRows(supabaseAdmin
      .from("payment_fields")
      .select("id,code,label,field_type,calculation_type,is_custom_production,is_active")
      .eq("company_id", companyId)
      .order("code")),
    readAllRows(supabaseAdmin
      .from("workforce_additional_payment_fields")
      .select("id,code,name,calculation_type,default_rate_value,is_active")
      .eq("company_id", companyId)
      .order("code")),
    readAllRows(supabaseAdmin
      .from("workforce_deduction_heads")
      .select("id,code,name,calculation_type,is_system,is_active")
      .eq("company_id", companyId)
      .order("code")),
    readAllRows(supabaseAdmin
      .from("field_executive_provider_mappings")
      .select("id,workforce_id,employee_id,contractor_id,field_executive_id,station_id,payment_method_id,effective_from,effective_to,status")
      .eq("company_id", companyId)
      .in("status", ["active", "closed"])
      .lte("effective_from", batchTo)
      .or(`effective_to.is.null,effective_to.gte.${batchFrom}`)
      .order("effective_from")
      .order("id")),
    readAllRows(supabaseAdmin
      .from("workforce_payment_allocations")
      .select("id,workforce_id,station_id,payment_method_id,payment_components,effective_from,effective_to,status")
      .eq("company_id", companyId)
      .in("status", ["active", "closed"])
      .lte("effective_from", batchTo)
      .or(`effective_to.is.null,effective_to.gte.${batchFrom}`)
      .order("effective_from")
      .order("id")),
    readAllRows(supabaseAdmin
      .from("stations")
      .select("id,station_code")
      .eq("company_id", companyId)
      .order("station_code"))
  ]);
  const initialError = workersResult.error?.message
    || paymentFieldsResult.error?.message
    || additionalFieldsResult.error?.message
    || deductionHeadsResult.error?.message
    || mappingsResult.error?.message
    || allocationsResult.error?.message
    || stationsResult.error?.message;
  if (initialError) throw new Error(initialError);

  const paymentFields: WorkforcePayoutImportPaymentField[] = (paymentFieldsResult.data ?? []).map((field: any) => ({
    id: String(field.id),
    code: normalizeWorkforcePayoutCode(field.code),
    label: String(field.label ?? field.code ?? ""),
    fieldType: field.field_type === "production" ? "production" : "amount",
    calculationType: field.calculation_type ? String(field.calculation_type) : null,
    isCustomProduction: Boolean(field.is_custom_production),
    isActive: Boolean(field.is_active)
  }));
  const fieldCodeById = new Map(paymentFields.map((field) => [field.id, field.code]));
  const methodIds = [...new Set([...(mappingsResult.data ?? []), ...(allocationsResult.data ?? [])]
    .map((row: any) => String(row.payment_method_id ?? ""))
    .filter(Boolean))];
  const componentsResult = methodIds.length
    ? await readAllRows(supabaseAdmin
      .from("payment_method_components")
      .select("payment_method_id,payment_field_id,component_code,is_active")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .in("payment_method_id", methodIds)
      .order("payment_method_id")
      .order("id"))
    : { data: [], error: null };
  if (componentsResult.error) throw new Error(componentsResult.error.message);

  const codesByMethod = new Map<string, string[]>();
  for (const component of componentsResult.data ?? []) {
    const methodId = String(component.payment_method_id ?? "");
    const code = fieldCodeById.get(String(component.payment_field_id ?? ""))
      ?? normalizeWorkforcePayoutCode(component.component_code);
    if (!methodId || !code) continue;
    codesByMethod.set(methodId, [...new Set([...(codesByMethod.get(methodId) ?? []), code])]);
  }

  const canonicalWorkforceByIdentity = new Map<string, string>();
  for (const worker of workersResult.data ?? []) {
    const workerId = String(worker.id ?? "");
    if (!workerId) continue;
    canonicalWorkforceByIdentity.set(`workforce:${workerId}`, workerId);
    const sourceProfileId = String(worker.source_profile_id ?? "");
    const sourceProfileType = String(worker.source_profile_type ?? "");
    if (sourceProfileId && ["employee", "contractor", "field_executive"].includes(sourceProfileType)) {
      canonicalWorkforceByIdentity.set(`${sourceProfileType}:${sourceProfileId}`, workerId);
    }
  }

  function canonicalMappingWorkforceId(mapping: any) {
    const directId = String(mapping.workforce_id ?? "");
    if (directId) return canonicalWorkforceByIdentity.get(`workforce:${directId}`) ?? "";
    for (const profileType of ["employee", "contractor", "field_executive"] as const) {
      const sourceId = String(mapping[`${profileType}_id`] ?? "");
      if (sourceId) return canonicalWorkforceByIdentity.get(`${profileType}:${sourceId}`) ?? "";
    }
    return "";
  }

  const setups: WorkforcePayoutImportSetup[] = (mappingsResult.data ?? []).flatMap((mapping: any) => {
    const workforceId = canonicalMappingWorkforceId(mapping);
    if (!workforceId) return [];
    return [{
      workforceId,
      locationId: mapping.station_id ? String(mapping.station_id) : null,
      effectiveFrom: String(mapping.effective_from),
      effectiveTo: mapping.effective_to ? String(mapping.effective_to) : null,
      fieldCodes: codesByMethod.get(String(mapping.payment_method_id ?? "")) ?? []
    }];
  });
  for (const allocation of allocationsResult.data ?? []) {
    const snapshot = Array.isArray(allocation.payment_components) ? allocation.payment_components : [];
    const snapshotCodes: string[] = snapshot
      .map((component: any) => normalizeWorkforcePayoutCode(component?.component_code))
      .filter((code: string) => Boolean(code));
    setups.push({
      workforceId: String(allocation.workforce_id ?? ""),
      locationId: allocation.station_id ? String(allocation.station_id) : null,
      effectiveFrom: String(allocation.effective_from),
      effectiveTo: allocation.effective_to ? String(allocation.effective_to) : null,
      // A direct allocation is an immutable payment snapshot. Never infer fields
      // from the live method because the master may have changed since it was saved.
      fieldCodes: [...new Set(snapshotCodes)]
    });
  }

  const workers: WorkforcePayoutImportWorker[] = (workersResult.data ?? [])
    .filter((worker: any) => String(worker.migration_state ?? "") !== "reclassified")
    .map((worker: any) => ({
      id: String(worker.id),
      dropxId: worker.dropx_id ? String(worker.dropx_id) : null,
      fullName: String(worker.full_name ?? worker.dropx_id ?? "Workforce member"),
      locationId: worker.location_id ? String(worker.location_id) : null,
      dateOfJoin: worker.date_of_join ? String(worker.date_of_join) : null,
      lastWorkingDate: worker.last_working_date ? String(worker.last_working_date) : null,
      isActive: Boolean(worker.is_active)
    }));
  const additionalFields: WorkforcePayoutImportAdditionalField[] = (additionalFieldsResult.data ?? []).map((field: any) => ({
    id: String(field.id),
    code: normalizeWorkforcePayoutCode(field.code),
    name: String(field.name ?? field.code ?? ""),
    calculationType: String(field.calculation_type) as WorkforcePayoutImportAdditionalField["calculationType"],
    defaultRateValue: field.default_rate_value === null ? null : Number(field.default_rate_value),
    isActive: Boolean(field.is_active)
  }));
  const deductionHeads: WorkforcePayoutImportDeductionHead[] = (deductionHeadsResult.data ?? []).map((head: any) => ({
    id: String(head.id),
    code: normalizeWorkforcePayoutCode(head.code),
    name: String(head.name ?? head.code ?? ""),
    calculationType: String(head.calculation_type) as WorkforcePayoutImportDeductionHead["calculationType"],
    isSystem: Boolean(head.is_system),
    isActive: Boolean(head.is_active)
  }));
  const locations = (stationsResult.data ?? []).map((station: any) => ({
    id: String(station.id),
    code: normalizeWorkforcePayoutCode(station.station_code)
  })).filter((station) => station.id && station.code);
  return { workers, paymentFields, additionalFields, deductionHeads, setups, locations };
}

async function appendDatabaseIssues(
  companyId: string,
  batchFrom: string,
  batchTo: string,
  fileSha256: string,
  rows: ResolvedWorkforcePayoutImportRow[],
  issues: WorkforcePayoutImportIssue[]
) {
  if (!supabaseAdmin) return;
  const [priorResult, attendanceOverridesResult, paymentOverridesResult, additionalValuesResult, deductionValuesResult] = await Promise.all([
    supabaseAdmin
      .from("workforce_payout_import_batches")
      .select("id")
      .eq("company_id", companyId)
      .eq("effective_from", batchFrom)
      .eq("effective_to", batchTo)
      .eq("file_sha256", fileSha256)
      .eq("status", "committed")
      .maybeSingle(),
    readAllRows(supabaseAdmin
      .from("workforce_payout_attendance_overrides")
      .select("workforce_id,station_id,work_date")
      .eq("company_id", companyId)
      .gte("work_date", batchFrom)
      .lte("work_date", batchTo)
      .order("work_date")),
    readAllRows(supabaseAdmin
      .from("workforce_payment_field_overrides")
      .select("workforce_id,station_id,payment_field_id,effective_from,effective_to")
      .eq("company_id", companyId)
      .lte("effective_from", batchTo)
      .gte("effective_to", batchFrom)
      .order("effective_from")),
    readAllRows(supabaseAdmin
      .from("workforce_additional_payment_values")
      .select("workforce_id,station_id,additional_payment_field_id,effective_from,effective_to")
      .eq("company_id", companyId)
      .lte("effective_from", batchTo)
      .gte("effective_to", batchFrom)
      .order("effective_from")),
    readAllRows(supabaseAdmin
      .from("workforce_payout_deduction_values")
      .select("workforce_id,station_id,deduction_head_id,effective_from,effective_to")
      .eq("company_id", companyId)
      .lte("effective_from", batchTo)
      .gte("effective_to", batchFrom)
      .order("effective_from"))
  ]);
  const error = priorResult.error?.message || attendanceOverridesResult.error?.message
    || paymentOverridesResult.error?.message || additionalValuesResult.error?.message
    || deductionValuesResult.error?.message;
  if (error) throw new Error(error);
  if (priorResult.data) {
    issues.push({ rowNumber: null, dropxId: null, message: "This exact workbook was already imported for the selected payout period." });
  }

  const existingPayment = (paymentOverridesResult.data ?? []).map((item: any) => ({
    workforceId: String(item.workforce_id),
    stationId: item.station_id ? String(item.station_id) : null,
    fieldId: String(item.payment_field_id),
    effectiveFrom: String(item.effective_from),
    effectiveTo: String(item.effective_to)
  }));
  const existingAdditional = (additionalValuesResult.data ?? []).map((item: any) => ({
    workforceId: String(item.workforce_id),
    stationId: item.station_id ? String(item.station_id) : null,
    fieldId: String(item.additional_payment_field_id),
    effectiveFrom: String(item.effective_from),
    effectiveTo: String(item.effective_to)
  }));
  const existingDeductions = (deductionValuesResult.data ?? []).map((item: any) => ({
    workforceId: String(item.workforce_id),
    stationId: item.station_id ? String(item.station_id) : null,
    fieldId: String(item.deduction_head_id),
    effectiveFrom: String(item.effective_from),
    effectiveTo: String(item.effective_to)
  }));
  const existingAttendance = new Map((attendanceOverridesResult.data ?? []).map((item: any) => [
    `${String(item.workforce_id)}|${String(item.work_date)}`,
    item.station_id ? String(item.station_id) : null
  ]));
  for (const row of rows) {
    if (row.inputType === "ATTENDANCE") {
      const existingStation = existingAttendance.get(`${row.workforceId}|${row.effectiveFrom}`);
      if (existingStation && existingStation !== row.locationId) {
        issues.push({
          rowNumber: row.rowNumber,
          dropxId: row.dropxId,
          message: "Attendance for this date already belongs to another location. Clear it from that location first."
        });
      }
      continue;
    }
    const existing = row.inputType === "PAYMENT_FIELD_VALUE" ? existingPayment
      : row.inputType === "ADDITIONAL_PAYMENT" ? existingAdditional
        : row.inputType === "DEDUCTION" ? existingDeductions
        : [];
    if (existing.some((item) => payoutImportRowsOverlap(row, item)
      && (item.effectiveFrom !== row.effectiveFrom || item.effectiveTo !== row.effectiveTo))) {
      issues.push({
        rowNumber: row.rowNumber,
        dropxId: row.dropxId,
        message: "This row partially overlaps an existing value. Use its exact period or clear the existing value first."
      });
    }
    if (row.inputType === "ADDITIONAL_PAYMENT" && existing.some((item) =>
      item.workforceId === row.workforceId
      && item.fieldId === row.additionalPaymentFieldId
      && item.effectiveFrom === row.effectiveFrom
      && item.effectiveTo === row.effectiveTo
      && item.stationId !== row.locationId)) {
      issues.push({
        rowNumber: row.rowNumber,
        dropxId: row.dropxId,
        message: "This additional payment period already belongs to another location. Clear it from that location first."
      });
    }
    if (row.inputType === "DEDUCTION" && existing.some((item) =>
      item.workforceId === row.workforceId
      && item.fieldId === row.deductionHeadId
      && item.effectiveFrom === row.effectiveFrom
      && item.effectiveTo === row.effectiveTo
      && item.stationId !== row.locationId)) {
      issues.push({
        rowNumber: row.rowNumber,
        dropxId: row.dropxId,
        message: "This deduction period already belongs to another location. Clear it from that location first."
      });
    }
  }
}

function rpcRows(rows: ResolvedWorkforcePayoutImportRow[]) {
  return rows.map((row) => ({
    row_number: row.rowNumber,
    action: row.action,
    dropx_id: row.dropxId,
    input_type: row.inputType,
    field_code: row.fieldCode || null,
    workforce_id: row.workforceId,
    station_id: row.locationId,
    payment_field_id: row.paymentFieldId,
    additional_payment_field_id: row.additionalPaymentFieldId,
    deduction_head_id: row.deductionHeadId,
    effective_from: row.effectiveFrom,
    effective_to: row.effectiveTo,
    numeric_value: row.numericValue,
    text_value: row.textValue,
    work_minutes: row.workMinutes,
    remark: row.remark || null
  }));
}

export async function POST(request: Request) {
  try {
    if (!sameOrigin(request)) return errorResponse("Invalid request origin.", 403);
    const authorization = await getAuthorization();
    if (!authorization) return errorResponse("Sign in to use payout imports.", 401);
    const pageCode = payoutPageCode();
    if (!hasPermission(authorization, pageCode, "edit")) {
      return errorResponse("Payout edit access is required to preview or apply a bulk upload.", 403);
    }
    if (!supabaseAdmin) return errorResponse("Database configuration is unavailable.", 503);
    const companyId = requireCompanyId(authorization);
    const form = await request.formData();
    const mode = String(form.get("mode") ?? "preview");
    const batchFrom = String(form.get("effective_from") ?? "");
    const batchTo = String(form.get("effective_to") ?? "");
    const file = form.get("file");
    if (mode !== "preview" && mode !== "commit") return errorResponse("Select preview or commit mode.", 400);
    if (!(file instanceof File) || !file.name || !file.size) return errorResponse("Choose a payout input workbook.", 400);
    if (!FILE_PATTERN.test(file.name)) return errorResponse("Upload an Excel or CSV workbook.", 400);
    if (file.size > MAX_FILE_BYTES) return errorResponse("The workbook must be 5 MB or smaller.", 413);

    const bytes = new Uint8Array(await file.arrayBuffer());
    const fileSha256 = createHash("sha256").update(bytes).digest("hex");
    let parsed;
    try {
      parsed = parseWorkforcePayoutWorkbook(bytes, { batchFrom, batchTo });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "The workbook could not be read.", 400);
    }
    const references = await loadReferences(companyId, batchFrom, batchTo);
    const allowedLocationIds = authorization.hasAllLocationAccess || isCompanyOwner(authorization)
      ? null
      : new Set(authorization.locationScopeIds);
    const resolved = resolveWorkforcePayoutImportRows(parsed, { ...references, allowedLocationIds });
    const issues = [...resolved.issues];
    await appendDatabaseIssues(companyId, batchFrom, batchTo, fileSha256, resolved.rows, issues);

    const preview = {
      fileName: file.name,
      fileSha256,
      effectiveFrom: batchFrom,
      effectiveTo: batchTo,
      totalRows: parsed.rows.length,
      matchedRows: resolved.rows.length,
      canCommit: issues.length === 0,
      issues,
      counts: Object.fromEntries(["ATTENDANCE", "PRODUCTION_UNITS", "PAYMENT_FIELD_VALUE", "ADDITIONAL_PAYMENT", "DEDUCTION"]
        .map((type) => [type, parsed.rows.filter((row) => row.inputType === type).length])),
      rows: resolved.rows.slice(0, 50).map((row) => ({
        rowNumber: row.rowNumber,
        action: row.action,
        dropxId: row.dropxId,
        fullName: row.fullName,
        inputType: row.inputType,
        fieldCode: row.fieldCode,
        locationCode: row.locationCode || references.locations.find((location) => location.id === row.locationId)?.code || "",
        effectiveFrom: row.effectiveFrom,
        effectiveTo: row.effectiveTo,
        value: row.textValue ?? row.numericValue,
        workMinutes: row.workMinutes,
        locationId: row.locationId
      })),
      matchRule: "Canonical company Workforce DROPX_ID only"
    };
    if (mode === "preview") {
      return Response.json(preview, { headers: { "Cache-Control": "private, no-store" } });
    }
    if (issues.length) {
      return Response.json(
        { ...preview, error: "Resolve every blocked row and preview the workbook again before importing." },
        { status: 400, headers: { "Cache-Control": "private, no-store" } }
      );
    }

    const applied = await supabaseAdmin.rpc("workforce_apply_payout_import", {
      p_company_id: companyId,
      p_effective_from: batchFrom,
      p_effective_to: batchTo,
      p_file_name: file.name.slice(0, 240),
      p_file_sha256: fileSha256,
      p_rows: rpcRows(resolved.rows),
      p_actor_user_id: authorization.userId,
      p_allowed_location_ids: allowedLocationIds ? [...allowedLocationIds] : null
    });
    if (applied.error) {
      const conflict = /already imported|overlap|approved|paid/i.test(applied.error.message);
      return errorResponse(applied.error.message, conflict ? 409 : 400);
    }
    return Response.json({
      ...preview,
      canCommit: false,
      importId: applied.data,
      message: `${parsed.rows.length} payout input row${parsed.rows.length === 1 ? " was" : "s were"} imported atomically.`
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to process the payout workbook.", 500);
  }
}
