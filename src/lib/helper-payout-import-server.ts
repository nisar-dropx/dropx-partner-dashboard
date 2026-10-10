import type { AuthorizationContext } from "@/lib/authorization";
import { isCompanyOwner } from "@/lib/authorization";
import { readAllRows } from "@/lib/supabase-pagination";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  normalizeWorkforcePayoutCode,
  parseWorkforcePayoutWorkbook,
  resolveWorkforcePayoutImportRows,
  type ResolvedWorkforcePayoutImportRow,
  type WorkforcePayoutImportAdditionalField,
  type WorkforcePayoutImportDeductionHead,
  type WorkforcePayoutImportIssue,
  type WorkforcePayoutImportSetup,
  type WorkforcePayoutImportWorker
} from "@/lib/workforce-payout-import";
import { workforcePayoutImportFingerprint } from "@/lib/workforce-payout-import-fingerprint";
import {
  requiredAttendanceBasisForComponents,
  validateAttendanceImportBases,
  validateAttendanceImportStability,
  type AttendancePaymentComponentBasis,
  type AttendancePaymentSetting,
  type EffectiveAttendanceAllocation
} from "@/app/api/payments/workforce-payouts/bulk-upload/attendance-basis";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const FILE_PATTERN = /\.(xlsx|xls|csv)$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HELPER_INPUT_TYPES = ["ATTENDANCE", "ADDITIONAL_PAYMENT", "DEDUCTION"] as const;

function errorResponse(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "private, no-store" } });
}

function helperIssue(issue: WorkforcePayoutImportIssue): WorkforcePayoutImportIssue {
  return {
    ...issue,
    message: issue.message
      .replaceAll("company Workforce record", "company Helper record")
      .replaceAll("Workforce member", "Helper")
      .replaceAll("Workforce current location", "Helper current location")
      .replaceAll("This worker", "This Helper")
      .replaceAll("this worker", "this Helper")
  };
}

async function loadHelperReferences(companyId: string, batchFrom: string, batchTo: string) {
  if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
  const [helpersResult, additionalFieldsResult, deductionHeadsResult, allocationsResult, stationsResult, paymentSettingsResult] = await Promise.all([
    readAllRows(supabaseAdmin
      .from("helpers")
      .select("id,dropx_id,full_name,location_id,date_of_join,is_active,onboarding_status")
      .eq("company_id", companyId)
      .order("id")),
    readAllRows(supabaseAdmin
      .from("workforce_additional_payment_fields")
      .select("id,code,name,calculation_type,default_rate_value,is_active")
      .eq("company_id", companyId)
      .order("code")),
    readAllRows(supabaseAdmin
      .from("workforce_deduction_heads")
      .select("id,code,name,calculation_type,is_system,is_active")
      .eq("company_id", companyId)
      .neq("code", "ADVANCE")
      .order("code")),
    readAllRows(supabaseAdmin
      .from("helper_payment_allocations")
      .select("id,helper_id,station_id,payment_components,effective_from,effective_to,status")
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
      .order("station_code")),
    readAllRows(supabaseAdmin
      .from("workforce_payment_settings")
      .select("calculation_method,paid_off_days,work_units_per_paid_off,cap_at_monthly_amount,effective_from")
      .eq("company_id", companyId)
      .lte("effective_from", batchTo)
      .order("effective_from"))
  ]);
  const error = helpersResult.error?.message || additionalFieldsResult.error?.message
    || deductionHeadsResult.error?.message || allocationsResult.error?.message
    || stationsResult.error?.message || paymentSettingsResult.error?.message;
  if (error) throw new Error(error);

  const workers: WorkforcePayoutImportWorker[] = (helpersResult.data ?? []).map((helper: any) => ({
    id: String(helper.id),
    dropxId: helper.dropx_id ? String(helper.dropx_id) : null,
    fullName: String(helper.full_name ?? helper.dropx_id ?? "Helper"),
    locationId: helper.location_id ? String(helper.location_id) : null,
    dateOfJoin: helper.date_of_join ? String(helper.date_of_join) : null,
    lastWorkingDate: null,
    // Helper history has no canonical last-working-date field. A historical
    // direct-pay allocation remains editable regardless of the current master
    // status; the database processing hook is the financial mutation lock.
    isActive: true
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
  const setups: WorkforcePayoutImportSetup[] = [];
  const attendanceAllocations: EffectiveAttendanceAllocation[] = [];
  for (const allocation of allocationsResult.data ?? []) {
    const components: AttendancePaymentComponentBasis[] = (Array.isArray(allocation.payment_components)
      ? allocation.payment_components
      : []).map((component: any) => ({
        componentType: component?.component_type,
        calculationSource: component?.calculation_source,
        paySchedule: component?.pay_schedule,
        calculationType: component?.calculation_type,
        paymentFieldId: component?.payment_field_id,
        fieldCode: normalizeWorkforcePayoutCode(component?.component_code)
      }));
    const helperId = String(allocation.helper_id ?? "");
    const locationId = allocation.station_id ? String(allocation.station_id) : null;
    setups.push({
      workforceId: helperId,
      locationId,
      effectiveFrom: String(allocation.effective_from),
      effectiveTo: allocation.effective_to ? String(allocation.effective_to) : null,
      fieldCodes: []
    });
    attendanceAllocations.push({
      sourceId: `helper:${String(allocation.id ?? "")}`,
      workforceId: helperId,
      locationId,
      effectiveFrom: String(allocation.effective_from),
      effectiveTo: allocation.effective_to ? String(allocation.effective_to) : null,
      requiredBasis: requiredAttendanceBasisForComponents(components),
      components
    });
  }
  const paymentSettings: AttendancePaymentSetting[] = (paymentSettingsResult.data ?? []).map((setting: any) => ({
    effectiveFrom: String(setting.effective_from ?? ""),
    calculationMethod: String(setting.calculation_method ?? "calendar_days"),
    paidOffDays: Number(setting.paid_off_days ?? 4),
    workUnitsPerPaidOff: Number(setting.work_units_per_paid_off ?? 6),
    capAtMonthlyAmount: setting.cap_at_monthly_amount !== false
  }));
  return {
    workers,
    paymentFields: [],
    additionalFields,
    deductionHeads,
    setups,
    locations,
    attendanceAllocations,
    paymentFieldOverrides: [],
    paymentSettings
  };
}

async function appendHelperDatabaseIssues(
  companyId: string,
  batchFrom: string,
  batchTo: string,
  fileSha256: string,
  rows: ResolvedWorkforcePayoutImportRow[],
  issues: WorkforcePayoutImportIssue[]
) {
  if (!supabaseAdmin) return;
  const [priorResult, attendanceResult, additionsResult, deductionsResult] = await Promise.all([
    supabaseAdmin
      .from("helper_payout_import_batches")
      .select("id")
      .eq("company_id", companyId)
      .eq("effective_from", batchFrom)
      .eq("effective_to", batchTo)
      .eq("file_sha256", fileSha256)
      .eq("status", "committed")
      .maybeSingle(),
    readAllRows(supabaseAdmin
      .from("helper_payout_attendance_values")
      .select("helper_id,station_id,effective_from,effective_to")
      .eq("company_id", companyId)
      .lte("effective_from", batchTo)
      .gte("effective_to", batchFrom)
      .order("effective_from")),
    readAllRows(supabaseAdmin
      .from("helper_additional_payment_values")
      .select("helper_id,station_id,additional_payment_field_id,effective_from,effective_to")
      .eq("company_id", companyId)
      .lte("effective_from", batchTo)
      .gte("effective_to", batchFrom)
      .order("effective_from")),
    readAllRows(supabaseAdmin
      .from("helper_payout_deduction_values")
      .select("helper_id,station_id,deduction_head_id,effective_from,effective_to")
      .eq("company_id", companyId)
      .lte("effective_from", batchTo)
      .gte("effective_to", batchFrom)
      .order("effective_from"))
  ]);
  const error = priorResult.error?.message || attendanceResult.error?.message
    || additionsResult.error?.message || deductionsResult.error?.message;
  if (error) throw new Error(error);
  if (priorResult.data) {
    issues.push({ rowNumber: null, dropxId: null, message: "This exact Helper workbook was already imported for the selected payout period." });
  }

  const overlaps = (from: string, to: string, otherFrom: string, otherTo: string) => from <= otherTo && to >= otherFrom;
  for (const row of rows) {
    if (row.inputType === "ATTENDANCE") {
      const matches = (attendanceResult.data ?? []).filter((value: any) => String(value.helper_id) === row.workforceId
        && overlaps(row.effectiveFrom, row.effectiveTo, String(value.effective_from), String(value.effective_to)));
      const partial = matches.find((value: any) => String(value.effective_from) !== row.effectiveFrom || String(value.effective_to) !== row.effectiveTo);
      if (partial) {
        issues.push({
          rowNumber: row.rowNumber,
          dropxId: row.dropxId,
          message: `This attendance range partially overlaps the stored ${String(partial.effective_from)} to ${String(partial.effective_to)} value. Split the row or clear the exact stored range first.`
        });
      }
      const exactOtherLocation = matches.find((value: any) => String(value.effective_from) === row.effectiveFrom
        && String(value.effective_to) === row.effectiveTo && String(value.station_id) !== row.locationId);
      if (exactOtherLocation) {
        issues.push({ rowNumber: row.rowNumber, dropxId: row.dropxId, message: "This attendance period belongs to another location. Clear it from that location first." });
      }
      continue;
    }
    const values = row.inputType === "ADDITIONAL_PAYMENT" ? additionsResult.data ?? [] : deductionsResult.data ?? [];
    const fieldId = row.additionalPaymentFieldId ?? row.deductionHeadId;
    const matches = values.filter((value: any) => String(value.helper_id) === row.workforceId
      && String(row.inputType === "ADDITIONAL_PAYMENT" ? value.additional_payment_field_id : value.deduction_head_id) === fieldId
      && overlaps(row.effectiveFrom, row.effectiveTo, String(value.effective_from), String(value.effective_to)));
    if (matches.some((value: any) => String(value.effective_from) !== row.effectiveFrom || String(value.effective_to) !== row.effectiveTo)) {
      issues.push({
        rowNumber: row.rowNumber,
        dropxId: row.dropxId,
        message: "This row partially overlaps an existing Helper value. Use its exact period or clear the stored value first."
      });
    }
    if (matches.some((value: any) => String(value.effective_from) === row.effectiveFrom
      && String(value.effective_to) === row.effectiveTo && String(value.station_id) !== row.locationId)) {
      issues.push({ rowNumber: row.rowNumber, dropxId: row.dropxId, message: "This exact adjustment period belongs to another location. Clear it from that location first." });
    }
  }
}

function helperRpcRows(rows: ResolvedWorkforcePayoutImportRow[]) {
  return rows.map((row) => ({
    row_number: row.rowNumber,
    action: row.action,
    dropx_id: row.dropxId,
    input_type: row.inputType,
    field_code: row.fieldCode || null,
    helper_id: row.workforceId,
    station_id: row.locationId,
    additional_payment_field_id: row.additionalPaymentFieldId,
    deduction_head_id: row.deductionHeadId,
    effective_from: row.effectiveFrom,
    effective_to: row.effectiveTo,
    numeric_value: row.numericValue,
    remark: row.remark || null
  }));
}

export async function processHelperPayoutImport(input: {
  authorization: AuthorizationContext;
  companyId: string;
  form: FormData;
}) {
  const { authorization, companyId, form } = input;
  if (!supabaseAdmin) return errorResponse("Database configuration is unavailable.", 503);
  const mode = String(form.get("mode") ?? "preview");
  const batchFrom = String(form.get("effective_from") ?? "");
  const batchTo = String(form.get("effective_to") ?? "");
  const inputSource = String(form.get("input_source") ?? "workbook").trim().toLowerCase();
  const manualOperationId = String(form.get("manual_operation_id") ?? "").trim();
  const file = form.get("file");
  if (mode !== "preview" && mode !== "commit") return errorResponse("Select preview or commit mode.", 400);
  if (inputSource !== "workbook" && inputSource !== "manual") return errorResponse("Payout input source is not supported.", 400);
  if (inputSource === "manual" && !UUID_PATTERN.test(manualOperationId)) {
    return errorResponse("The manual payout edit session is invalid. Close the editor and try again.", 400);
  }
  if (inputSource !== "manual" && manualOperationId) return errorResponse("Manual operation ID is valid only for manual payout edits.", 400);
  if (!(file instanceof File) || !file.name || !file.size) return errorResponse("Choose a Helper payout input workbook.", 400);
  if (!FILE_PATTERN.test(file.name)) return errorResponse("Upload an Excel or CSV workbook.", 400);
  if (file.size > MAX_FILE_BYTES) return errorResponse("The workbook must be 5 MB or smaller.", 413);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const fileSha256 = workforcePayoutImportFingerprint(bytes, inputSource === "manual" ? manualOperationId : null);
  let parsed;
  try {
    parsed = parseWorkforcePayoutWorkbook(bytes, { batchFrom, batchTo });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "The workbook could not be read.", 400);
  }

  if (mode === "commit" && inputSource === "manual") {
    const replay = await supabaseAdmin
      .from("helper_payout_import_batches")
      .select("id,row_count")
      .eq("company_id", companyId)
      .eq("effective_from", batchFrom)
      .eq("effective_to", batchTo)
      .eq("file_sha256", fileSha256)
      .eq("status", "committed")
      .maybeSingle();
    if (replay.error) throw new Error(replay.error.message);
    if (replay.data) {
      const replayedRows = Number(replay.data.row_count ?? parsed.rows.length);
      return Response.json({
        fileName: file.name,
        fileSha256,
        effectiveFrom: batchFrom,
        effectiveTo: batchTo,
        totalRows: replayedRows,
        matchedRows: replayedRows,
        canCommit: true,
        issues: [],
        counts: Object.fromEntries(HELPER_INPUT_TYPES.map((type) => [type, parsed.rows.filter((row) => row.inputType === type).length])),
        rows: [],
        importId: String(replay.data.id),
        replayed: true,
        warnings: [],
        message: `${replayedRows} Helper payout input row${replayedRows === 1 ? " was" : "s were"} already applied; the retry was accepted safely.`
      }, { headers: { "Cache-Control": "private, no-store" } });
    }
  }

  const unsupportedIssues: WorkforcePayoutImportIssue[] = parsed.rows
    .filter((row) => row.inputType && !HELPER_INPUT_TYPES.includes(row.inputType as (typeof HELPER_INPUT_TYPES)[number]))
    .map((row) => ({
      rowNumber: row.rowNumber,
      dropxId: row.dropxId || null,
      message: `${row.inputType.replaceAll("_", " ")} is not available for Helpers. Use attendance, additional payment, or deduction.`
    }));
  const supportedParsed = {
    rows: parsed.rows.filter((row) => HELPER_INPUT_TYPES.includes(row.inputType as (typeof HELPER_INPUT_TYPES)[number])),
    issues: [...parsed.issues, ...unsupportedIssues]
  };
  const references = await loadHelperReferences(companyId, batchFrom, batchTo);
  const allowedLocationIds = authorization.hasAllLocationAccess || isCompanyOwner(authorization)
    ? null
    : new Set(authorization.locationScopeIds);
  const resolved = resolveWorkforcePayoutImportRows(supportedParsed, { ...references, allowedLocationIds });
  const issues = resolved.issues.map(helperIssue);
  issues.push(...validateAttendanceImportBases(resolved.rows, references.attendanceAllocations).map(helperIssue));
  issues.push(...validateAttendanceImportStability(
    resolved.rows,
    references.attendanceAllocations,
    references.paymentFieldOverrides,
    references.paymentSettings
  ).map(helperIssue));
  await appendHelperDatabaseIssues(companyId, batchFrom, batchTo, fileSha256, resolved.rows, issues);

  const counts = Object.fromEntries([
    "ATTENDANCE", "PRODUCTION_UNITS", "PAYMENT_FIELD_VALUE", "ADDITIONAL_PAYMENT", "DEDUCTION"
  ].map((type) => [type, parsed.rows.filter((row) => row.inputType === type).length]));
  const preview = {
    audience: "helpers",
    fileName: file.name,
    fileSha256,
    effectiveFrom: batchFrom,
    effectiveTo: batchTo,
    totalRows: parsed.rows.length,
    matchedRows: resolved.rows.length,
    canCommit: issues.length === 0,
    issues,
    counts,
    rows: resolved.rows.slice(0, 50).map((row) => ({
      rowNumber: row.rowNumber,
      action: row.action,
      dropxId: row.dropxId,
      fullName: row.fullName,
      inputType: row.inputType,
      fieldCode: row.fieldCode,
      locationCode: row.locationCode || references.locations.find((location) => location.id === row.locationId)?.code || "",
      effectiveDate: row.effectiveDate || row.effectiveFrom,
      effectiveTo: row.effectiveTo,
      value: row.numericValue ?? row.textValue,
      locationId: row.locationId
    })),
    matchRule: "Canonical company Helper DROPX_ID only"
  };
  if (mode === "preview") return Response.json(preview, { headers: { "Cache-Control": "private, no-store" } });
  if (issues.length) {
    return Response.json(
      { ...preview, error: "Resolve every blocked Helper row and preview the workbook again before importing." },
      { status: 400, headers: { "Cache-Control": "private, no-store" } }
    );
  }

  const applied = await supabaseAdmin.rpc("helper_apply_payout_import", {
    p_company_id: companyId,
    p_effective_from: batchFrom,
    p_effective_to: batchTo,
    p_file_name: file.name.slice(0, 240),
    p_file_sha256: fileSha256,
    p_rows: helperRpcRows(resolved.rows),
    p_actor_user_id: authorization.userId,
    p_allowed_location_ids: allowedLocationIds ? [...allowedLocationIds] : null
  });
  if (applied.error) {
    const conflict = /already imported|overlap|processing|location scope|allocation/i.test(applied.error.message);
    return errorResponse(applied.error.message, conflict ? 409 : 400);
  }
  return Response.json({
    ...preview,
    canCommit: false,
    importId: String(applied.data),
    warnings: [],
    message: `${parsed.rows.length} Helper payout input row${parsed.rows.length === 1 ? " was" : "s were"} imported atomically.`
  }, { headers: { "Cache-Control": "private, no-store" } });
}
