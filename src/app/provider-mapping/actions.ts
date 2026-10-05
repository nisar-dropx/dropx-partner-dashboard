"use server";

import { cookies } from "next/headers";
import { revalidatePath, revalidateTag } from "next/cache";
import { redirect } from "next/navigation";
import * as XLSX from "xlsx";
import { getAuthorization } from "@/lib/authorization";
import { requireCompanyId, withCompany } from "@/lib/company-scope";
import { isScientificProviderMemberId, providerFirstNamesMatch, providerMemberIdFromSpreadsheetCells } from "@/lib/provider-first-mapping-view";
import { ongoingMappingClosureError } from "@/lib/provider-mapping-period";
import { canEditProviderMappings, currentProviderMappingPageCode } from "@/lib/provider-mapping-access";
import { parseProductionThresholdConfig, type ProductionThresholdConfig } from "@/lib/production-threshold-config";
import {
  isFirstDayOfMonth,
  monthlyThresholdChangeRequiresMonthStart,
  parseProductionThresholdSnapshot,
  resolveMappingProductionThresholdSnapshot,
  type MappingProductionThresholdSnapshot
} from "@/lib/production-threshold-snapshot";
import { supabaseAdmin } from "@/lib/supabase-admin";

function clean(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text.length ? text : null;
}

function mappingRedirect(params: { error?: string; notice?: string }) {
  cookies().set("dropx_provider_mapping_flash", JSON.stringify(params), {
    httpOnly: true,
    maxAge: 15,
    path: "/provider-id-mapping",
    sameSite: "lax"
  });
  redirect("/provider-id-mapping");
}

function rowValue(formData: FormData, index: number, field: string) {
  return clean(formData.get(`rows[${index}][${field}]`));
}

function rowRequired(formData: FormData, index: number, field: string, label: string) {
  const value = rowValue(formData, index, field);
  if (!value) throw new Error(`Row ${index + 1}: ${label} is required.`);
  return value;
}

function rowNumber(formData: FormData, index: number, field: string, label: string) {
  const value = rowValue(formData, index, field);
  if (!value) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`Row ${index + 1}: ${label} must be a valid amount.`);
  }
  return number;
}

function nonEmptyRow(formData: FormData, index: number) {
  return [
    "id",
    "source_type",
    "mapping_id",
    "dropx_id",
    "provider_id",
    "provider_member_id",
    "station_id",
    "effective_from",
    "effective_to",
    "payment_method_id",
    "payment_values_json",
    "production_threshold_minimum_units",
    "delivery_rate",
    "pickup_rate",
    "mfn_rate",
    "mfn_return_rate",
    "guarantee_amount",
    "guarantee_schedule",
    "fuel_rate",
  ].some((field) => rowValue(formData, index, field));
}

function previousDate(dateValue: string) {
  const date = new Date(`${dateValue}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function firstRelation<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

type ProviderPaymentComponent = {
  component_code: string;
  label: string;
  payment_fields?: { calculation_source?: string | null; calculation_type?: string | null } | Array<{ calculation_source?: string | null; calculation_type?: string | null }> | null;
};

type WorkforceDesignationReference = {
  designation_id?: string | null;
  designation?: string | null;
};

async function resolveFieldOperationsDesignationPolicy(
  companyId: string,
  worker: WorkforceDesignationReference
) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const { data, error } = await supabaseAdmin
    .from("designations")
    .select("id, code, name, provider_mapping_required")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .eq("is_field_operations", true);
  if (error) throw new Error(error.message);

  const designationText = String(worker.designation ?? "").trim().toLowerCase();
  return (data ?? []).find((designation) => designation.id === worker.designation_id
    || (designationText.length > 0 && [designation.code, designation.name]
      .some((value) => String(value ?? "").trim().toLowerCase() === designationText))) ?? null;
}

function providerHolderMatches(holderName: string, workerName: string) {
  return providerFirstNamesMatch(holderName, workerName);
}

function normalizedHeader(value: unknown) {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function bulkValue(row: Record<string, unknown>, aliases: string[]) {
  for (const [key, value] of Object.entries(row)) {
    if (aliases.includes(normalizedHeader(key))) return value;
  }
  return "";
}

function bulkCell(row: Record<string, unknown>, aliases: string[]) {
  return String(bulkValue(row, aliases) ?? "").trim();
}

function bulkDate(value: string) {
  const text = value.trim();
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (!match) return null;
  const [, day, month, year] = match;
  const normalized = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized ? null : normalized;
}

type BulkWorker = {
  id: string;
  sourceType: "employee" | "contractor" | "field_executive" | "workforce";
  dropxId: string;
  fullName: string;
  stationId: string;
  effectiveFrom: string;
};

export type BulkUploadReportRow = {
  rowNumber: number;
  dropxId: string;
  providerMemberId: string;
  paymentMethodCode: string;
  result: "Mapped" | "Skipped";
  reason: string;
};

export type BulkUploadResult = {
  ok: boolean;
  message: string;
  rows: BulkUploadReportRow[];
};

export async function bulkUploadProviderIds(formData: FormData): Promise<BulkUploadResult> {
  const authorization = await getAuthorization();
  if (!authorization) redirect("/login");
  const companyId = requireCompanyId(authorization);
  if (!canEditProviderMappings(authorization)) {
    redirect(`/unauthorized?page=${currentProviderMappingPageCode()}&action=edit`);
  }

  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const file = formData.get("mapping_file");
    if (!(file instanceof File) || !file.size) throw new Error("Select an Excel or CSV file to upload.");
    if (file.size > 10 * 1024 * 1024) throw new Error("The upload file must be 10 MB or smaller.");

    const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", raw: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) throw new Error("The uploaded file does not contain a worksheet.");
    const formattedRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
    const identifierRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: true });
    const uploadRows = formattedRows.map((row, index) => {
      const identifierRow = identifierRows[index] ?? row;
      const providerMemberValue = bulkValue(identifierRow, ["PROVIDER_MEMBER_ID", "PROVIDER_ID", "MEMBER_ID", "PROVIDER_EMPLOYEE_ID"]);
      const providerMember = providerMemberIdFromSpreadsheetCells(
        bulkValue(row, ["PROVIDER_MEMBER_ID", "PROVIDER_ID", "MEMBER_ID", "PROVIDER_EMPLOYEE_ID"]),
        providerMemberValue
      );
      return {
        rowNumber: index + 2,
        dropxId: bulkCell(row, ["DROPX_ID", "DROPXID", "DROPX_ID_CODE"]).toUpperCase(),
        ...providerMember,
        paymentMethodCode: bulkCell(row, ["PAYMENT_METHOD_CODE", "PAYMENT_METHOD", "METHOD_CODE"]).toUpperCase(),
        effectiveFromRaw: bulkCell(row, ["EFFECTIVE_FROM", "FROM_DATE"]),
        effectiveToRaw: bulkCell(row, ["EFFECTIVE_TO", "TO_DATE"]),
        productionThresholdMinimumUnitsRaw: bulkCell(row, ["COMBINED_MINIMUM_UNITS", "PRODUCTION_MINIMUM_UNITS", "MINIMUM_UNITS"]),
        cells: Object.fromEntries(Object.entries(row).map(([key, value]) => [normalizedHeader(key), String(value ?? "").trim()]))
      };
    }).filter((row) => row.dropxId || row.providerMemberId || row.paymentMethodCode);
    if (!uploadRows.length) throw new Error("No DropX ID or Provider Member ID rows were found.");

    const dropxIds = Array.from(new Set(uploadRows.map((row) => row.dropxId).filter(Boolean)));
    const [{ data: employees, error: employeeError }, { data: contractors, error: contractorError }, { data: executives, error: executiveError }, { data: designations, error: designationError }, { data: paymentMethods, error: paymentMethodsError }] = await Promise.all([
      supabaseAdmin.from("employees").select("id, employee_code, full_name, location_id, date_of_join, designations!inner(is_field_operations,provider_mapping_required)").eq("company_id", companyId).eq("is_active", true).is("deleted_at", null).eq("designations.is_field_operations", true).eq("designations.provider_mapping_required", true).in("employee_code", dropxIds),
      supabaseAdmin.from("contractors").select("id, dropx_id, full_name, location_id, date_of_join, designation").eq("company_id", companyId).eq("is_active", true).is("deleted_at", null).in("dropx_id", dropxIds),
      supabaseAdmin.from("workforce").select("id, dropx_id, full_name, location_id, date_of_join, designation_id, designation").eq("company_id", companyId).eq("is_active", true).is("deleted_at", null).in("dropx_id", dropxIds),
      supabaseAdmin.from("designations").select("id, code, name").eq("company_id", companyId).eq("is_active", true).eq("is_field_operations", true).eq("provider_mapping_required", true),
      supabaseAdmin.from("payment_methods").select("id, code, production_threshold_config, payment_method_components(component_code, label, payment_fields(calculation_source, calculation_type))").eq("company_id", companyId).eq("is_active", true)
    ]);
    if (employeeError) throw new Error(employeeError.message);
    if (contractorError) throw new Error(contractorError.message);
    if (executiveError) throw new Error(executiveError.message);
    if (designationError) throw new Error(designationError.message);
    if (paymentMethodsError) throw new Error(paymentMethodsError.message);

    const paymentMethodByCode = new Map((paymentMethods ?? []).map((method) => [String(method.code ?? "").trim().toUpperCase(), {
      id: String(method.id),
      code: String(method.code ?? "").trim(),
      productionThresholdConfig: parseProductionThresholdConfig(method.production_threshold_config),
      components: (method.payment_method_components ?? []) as ProviderPaymentComponent[]
    }]));
    const allPaymentFieldCodes = new Set(Array.from(paymentMethodByCode.values()).flatMap((method) => method.components.map((component) => normalizedHeader(component.component_code))));

    const fieldOperationsDesignations = new Set((designations ?? []).flatMap((row) => [row.code, row.name]).map((value) => String(value ?? "").trim().toLowerCase()));
    const fieldOperationsDesignationIds = new Set((designations ?? []).map((row) => String(row.id)));

    const workers = new Map<string, BulkWorker>();
    (employees ?? []).forEach((row) => workers.set(String(row.employee_code ?? "").toUpperCase(), {
      id: row.id, sourceType: "employee", dropxId: String(row.employee_code ?? "").toUpperCase(), fullName: String(row.full_name ?? ""), stationId: String(row.location_id ?? ""), effectiveFrom: String(row.date_of_join ?? "")
    }));
    (contractors ?? []).filter((row) => fieldOperationsDesignations.has(String(row.designation ?? "").trim().toLowerCase())).forEach((row) => workers.set(String(row.dropx_id ?? "").toUpperCase(), {
      id: row.id, sourceType: "contractor", dropxId: String(row.dropx_id ?? "").toUpperCase(), fullName: String(row.full_name ?? ""), stationId: String(row.location_id ?? ""), effectiveFrom: String(row.date_of_join ?? "")
    }));
    (executives ?? []).filter((row) => fieldOperationsDesignationIds.has(String(row.designation_id ?? ""))
      || fieldOperationsDesignations.has(String(row.designation ?? "").trim().toLowerCase())).forEach((row) => workers.set(String(row.dropx_id ?? "").toUpperCase(), {
      id: row.id, sourceType: "workforce", dropxId: String(row.dropx_id ?? "").toUpperCase(), fullName: String(row.full_name ?? ""), stationId: String(row.location_id ?? ""), effectiveFrom: String(row.date_of_join ?? "")
    }));

    const allowedLocationIds = authorization.hasAllLocationAccess || authorization.isMasterOwner || authorization.roleCode === "OWNER"
      ? null
      : new Set(authorization.locationScopeIds);
    const eligibleWorkers = new Map(Array.from(workers.entries()).filter(([, worker]) => !allowedLocationIds || allowedLocationIds.has(worker.stationId)));
    const stationIds = Array.from(new Set(Array.from(eligibleWorkers.values()).map((worker) => worker.stationId).filter(Boolean))) as string[];
    const { data: stations, error: stationsError } = await supabaseAdmin.from("stations").select("id, provider_id, station_code").eq("company_id", companyId).in("id", stationIds);
    if (stationsError) throw new Error(stationsError.message);
    const stationById = new Map((stations ?? []).map((station) => [station.id, {
      providerId: String(station.provider_id ?? ""),
      stationCode: String(station.station_code ?? "").trim().toUpperCase()
    }]));
    const memberIds = Array.from(new Set(uploadRows.map((row) => row.providerMemberId).filter(Boolean)));
    const memberNameByStationAndId = new Map<string, string>();
    for (let offset = 0; offset < memberIds.length; offset += 200) {
      const { data, error } = await supabaseAdmin.from("cps_shipment_daily")
        .select("provider_employee_id, provider_employee_name, station_code, work_date, created_at")
        .eq("company_id", companyId)
        .in("provider_employee_id", memberIds.slice(offset, offset + 200))
        .order("work_date", { ascending: false })
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      (data ?? []).forEach((row) => {
        const memberId = String(row.provider_employee_id ?? "").trim();
        const stationCode = String(row.station_code ?? "").trim().toUpperCase();
        const memberKey = `${stationCode}|${memberId}`;
        if (memberId && stationCode && !memberNameByStationAndId.has(memberKey)) {
          memberNameByStationAndId.set(memberKey, String(row.provider_employee_name ?? "").trim());
        }
      });
    }
    let saved = 0;
    const seenDropxIds = new Set<string>();
    const reportRows: BulkUploadReportRow[] = [];
    for (const uploadRow of uploadRows) {
      const reportRow = { rowNumber: uploadRow.rowNumber, dropxId: uploadRow.dropxId, providerMemberId: uploadRow.providerMemberId, paymentMethodCode: uploadRow.paymentMethodCode };
      const skipped = (reason: string) => reportRows.push({ ...reportRow, result: "Skipped", reason });
      if (!uploadRow.dropxId || !uploadRow.providerMemberId) { skipped("DropX ID or Provider Member ID is blank."); continue; }
      if (uploadRow.providerMemberIdUnsafeNumber) { skipped("Provider Member ID is too large to read safely as a number. Format that cell as text and upload it again."); continue; }
      if (isScientificProviderMemberId(uploadRow.providerMemberId)) { skipped("Provider Member ID is rounded scientific notation. Upload the full provider ID as text or an unformatted number."); continue; }
      if (seenDropxIds.has(uploadRow.dropxId)) { skipped("Duplicate DropX ID in this upload."); continue; }
      seenDropxIds.add(uploadRow.dropxId);
      const worker = eligibleWorkers.get(uploadRow.dropxId);
      if (!worker) { skipped("DropX ID is not available in the current mapping list."); continue; }
      const station = stationById.get(worker.stationId);
      const providerId = station?.providerId;
      if (!providerId || !station?.stationCode) { skipped("The worker's location has no provider configured."); continue; }
      const holderName = memberNameByStationAndId.get(`${station.stationCode}|${uploadRow.providerMemberId}`);
      if (!holderName) { skipped("Provider Member ID was not found in uploaded provider data for the worker's location."); continue; }
      if (!providerHolderMatches(holderName, worker.fullName)) { skipped("Provider Member ID holder name does not match the DropX worker."); continue; }
      const suppliedPaymentValues = Array.from(allPaymentFieldCodes).some((code) => String(uploadRow.cells[code] ?? "").trim() !== "");
      const hasAllocationData = Boolean(uploadRow.paymentMethodCode || uploadRow.effectiveFromRaw || uploadRow.effectiveToRaw || uploadRow.productionThresholdMinimumUnitsRaw || suppliedPaymentValues);
      const paymentMethod = uploadRow.paymentMethodCode ? paymentMethodByCode.get(uploadRow.paymentMethodCode) : null;
      if (hasAllocationData && !uploadRow.paymentMethodCode) { skipped("Payment Method Code is required when payment allocation data is supplied."); continue; }
      if (uploadRow.paymentMethodCode && !paymentMethod) { skipped("Payment Method Code is not active or does not exist."); continue; }
      const effectiveFrom = bulkDate(uploadRow.effectiveFromRaw);
      const effectiveTo = bulkDate(uploadRow.effectiveToRaw);
      if (effectiveFrom === null) { skipped("Effective From must be YYYY-MM-DD or DD/MM/YYYY."); continue; }
      if (effectiveTo === null) { skipped("Effective To must be YYYY-MM-DD or DD/MM/YYYY."); continue; }
      if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) { skipped("Effective To cannot be before Effective From."); continue; }
      const paymentValues: Record<string, number> = {};
      let invalidPaymentValue = "";
      for (const component of paymentMethod?.components ?? []) {
        const rawValue = String(uploadRow.cells[normalizedHeader(component.component_code)] ?? "").trim();
        if (!rawValue) continue;
        const number = Number(rawValue.replace(/,/g, ""));
        if (!Number.isFinite(number) || number < 0) {
          invalidPaymentValue = `${component.label} must be a valid non-negative number.`;
          break;
        }
        paymentValues[component.component_code] = number;
      }
      if (invalidPaymentValue) { skipped(invalidPaymentValue); continue; }
      const workerColumn = worker.sourceType === "workforce" ? "workforce_id" : worker.sourceType === "employee" ? "employee_id" : worker.sourceType === "contractor" ? "contractor_id" : "field_executive_id";
      const { data: existing, error: existingError } = await supabaseAdmin.from("field_executive_provider_mappings")
        .select("id, effective_from, effective_to, station_id, payment_method_id, production_threshold_config")
        .eq("company_id", companyId)
        .eq(workerColumn, worker.id)
        .is("effective_to", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existingError) throw new Error(existingError.message);
      if (existing && allowedLocationIds && (!existing.station_id || !allowedLocationIds.has(existing.station_id))) {
        skipped("The existing active mapping is outside your allocated locations.");
        continue;
      }

      const fallbackEffectiveFrom = /^\d{4}-\d{2}-\d{2}$/.test(worker.effectiveFrom) ? worker.effectiveFrom : new Date().toISOString().slice(0, 10);
      const requestedEffectiveFrom = effectiveFrom || String(existing?.effective_from ?? fallbackEffectiveFrom);
      const storedThresholdSnapshot = parseProductionThresholdSnapshot(existing?.production_threshold_config);
      const editsExistingVersion = Boolean(existing)
        && String(existing?.effective_from ?? "") === requestedEffectiveFrom;
      const paymentMethodChanged = editsExistingVersion
        && String(existing?.payment_method_id ?? "") !== String(paymentMethod?.id ?? "");
      let productionThresholdConfig: MappingProductionThresholdSnapshot;
      try {
        productionThresholdConfig = resolveMappingProductionThresholdSnapshot({
          existingValue: existing?.production_threshold_config,
          editsExistingVersion,
          paymentMethodChanged,
          methodConfig: paymentMethod?.productionThresholdConfig ?? null,
          minimumUnits: uploadRow.productionThresholdMinimumUnitsRaw,
          inheritedMinimumUnits: storedThresholdSnapshot?.minimum_units
        });
        if (!paymentMethod?.productionThresholdConfig
          && uploadRow.productionThresholdMinimumUnitsRaw
          && !(editsExistingVersion && storedThresholdSnapshot)) {
          throw new Error("The selected payment method does not use a combined production minimum.");
        }
      } catch (error) {
        skipped(error instanceof Error ? error.message : "Combined minimum is invalid.");
        continue;
      }
      const allocationPayload = paymentMethod ? {
        payment_method_id: paymentMethod.id,
        payment_values: paymentValues,
        production_threshold_config: productionThresholdConfig,
        pay_type: paymentMethod.code
      } : {};
      if (monthlyThresholdChangeRequiresMonthStart(storedThresholdSnapshot, parseProductionThresholdSnapshot(productionThresholdConfig)) && !isFirstDayOfMonth(requestedEffectiveFrom)) {
        skipped("Changes to an existing monthly combined minimum must start on the first day of a month.");
        continue;
      }
      const closureError = existing ? ongoingMappingClosureError({
        existingEffectiveFrom: String(existing.effective_from),
        existingEffectiveTo: existing.effective_to,
        requestedEffectiveFrom,
        requestedEffectiveTo: effectiveTo || null
      }) : null;
      if (closureError) { skipped(closureError); continue; }

      if (existing && paymentMethod && effectiveFrom && effectiveFrom > String(existing.effective_from)) {
        if (worker.sourceType === "workforce") {
          const { error } = await supabaseAdmin.rpc("workforce_save_joining_mapping", {
            p_company: companyId,
            p_actor: authorization.userId,
            p_workforce: worker.id,
            p_mapping: existing.id,
            p_dropx: worker.dropxId,
            p_payload: {
              provider_id: providerId,
              provider_member_id: uploadRow.providerMemberId,
              station_id: worker.stationId,
              effective_from: effectiveFrom,
              effective_to: effectiveTo || null,
              payment_method_id: paymentMethod.id,
              payment_values: paymentValues,
              production_threshold_config: productionThresholdConfig,
              pay_type: paymentMethod.code,
              status: effectiveTo ? "closed" : "active"
            },
            p_locations: allowedLocationIds ? Array.from(allowedLocationIds) : null,
            p_actor_name: authorization.fullName || authorization.email || "Dashboard mapping reviewer"
          });
          if (error) { skipped(error.message); continue; }
          saved += 1;
          reportRows.push({ ...reportRow, result: "Mapped", reason: "ID and payment allocation mapped." });
          continue;
        }
        const closingDate = previousDate(effectiveFrom);
        const { error: closeError } = await supabaseAdmin.from("field_executive_provider_mappings").update({ effective_to: closingDate, status: "closed", updated_at: new Date().toISOString() }).eq("id", existing.id).eq("company_id", companyId);
        if (closeError) { skipped(closeError.message); continue; }
        const { error: insertError } = await supabaseAdmin.from("field_executive_provider_mappings").insert(withCompany({
          workforce_id: null,
          field_executive_id: worker.sourceType === "field_executive" ? worker.id : null,
          employee_id: worker.sourceType === "employee" ? worker.id : null,
          contractor_id: worker.sourceType === "contractor" ? worker.id : null,
          provider_id: providerId,
          provider_member_id: uploadRow.providerMemberId,
          station_id: worker.stationId,
          effective_from: effectiveFrom,
          effective_to: effectiveTo || null,
          payment_method_id: paymentMethod.id,
          payment_values: paymentValues,
          production_threshold_config: productionThresholdConfig,
          pay_type: paymentMethod.code,
          status: effectiveTo ? "closed" : "active",
          created_by: authorization.userId,
          updated_at: new Date().toISOString()
        }, companyId));
        if (insertError) { skipped(insertError.message); continue; }
      } else if (existing) {
        const { error } = await supabaseAdmin.from("field_executive_provider_mappings").update({
          provider_id: providerId,
          provider_member_id: uploadRow.providerMemberId,
          station_id: worker.stationId,
          ...(effectiveFrom ? { effective_from: effectiveFrom } : {}),
          ...(effectiveTo ? { effective_to: effectiveTo, status: "closed" } : {}),
          ...allocationPayload,
          updated_at: new Date().toISOString()
        }).eq("id", existing.id).eq("company_id", companyId);
        if (error) { skipped(error.message); continue; }
      } else {
        const { error } = await supabaseAdmin.from("field_executive_provider_mappings").insert(withCompany({
          workforce_id: worker.sourceType === "workforce" ? worker.id : null,
          field_executive_id: worker.sourceType === "field_executive" ? worker.id : null,
          employee_id: worker.sourceType === "employee" ? worker.id : null,
          contractor_id: worker.sourceType === "contractor" ? worker.id : null,
          provider_id: providerId,
          provider_member_id: uploadRow.providerMemberId,
          station_id: worker.stationId,
          effective_from: requestedEffectiveFrom,
          effective_to: effectiveTo || null,
          payment_method_id: paymentMethod?.id ?? null,
          payment_values: paymentMethod ? paymentValues : {},
          production_threshold_config: paymentMethod ? productionThresholdConfig : null,
          pay_type: paymentMethod?.code ?? "UNALLOCATED",
          status: effectiveTo ? "closed" : "active",
          created_by: authorization.userId,
          updated_at: new Date().toISOString()
        }, companyId));
        if (error) { skipped(error.message); continue; }
      }
      saved += 1;
      reportRows.push({ ...reportRow, result: "Mapped", reason: paymentMethod ? "ID and payment allocation mapped." : existing ? "Existing ID mapping updated." : "New ID mapping created." });
    }

    revalidateTag("ops-cps");
    revalidatePath("/cps");
    revalidatePath("/provider-id-mapping");
    const skippedCount = reportRows.length - saved;
    return { ok: true, message: `${saved} mapped; ${skippedCount} skipped.`, rows: reportRows };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Unable to upload ID mappings.", rows: [] };
  }
}

async function saveExecutiveMappingRow(
  formData: FormData,
  index: number,
  createdBy: string,
  companyId: string,
  allowedLocationIds: Set<string> | null
) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const admin = supabaseAdmin;

  const id = rowRequired(formData, index, "id", "Field executive");
  const sourceType = rowRequired(formData, index, "source_type", "Worker source");
  if (sourceType !== "employee" && sourceType !== "contractor" && sourceType !== "field_executive" && sourceType !== "workforce") {
    throw new Error(`Row ${index + 1}: Worker source is invalid.`);
  }
  const mappingId = rowValue(formData, index, "mapping_id");
  const dropxId = rowRequired(formData, index, "dropx_id", "DropX ID").toUpperCase();
  const submittedProviderId = rowValue(formData, index, "provider_id");
  const providerMemberId = rowRequired(formData, index, "provider_member_id", "Provider Member ID");
  if (isScientificProviderMemberId(providerMemberId)) {
    throw new Error(`Row ${index + 1}: The imported Provider Member ID is rounded. Reimport a report containing the full ID.`);
  }
  const stationId = rowRequired(formData, index, "station_id", "Location");
  if (allowedLocationIds && !allowedLocationIds.has(stationId)) {
    throw new Error(`Row ${index + 1}: This location is not allocated to your account.`);
  }
  const effectiveFrom = rowRequired(formData, index, "effective_from", "Effective from");
  const effectiveTo = rowValue(formData, index, "effective_to");
  const paymentMethodId = rowRequired(formData, index, "payment_method_id", "Payment method");
  const rawPaymentValues = rowValue(formData, index, "payment_values_json") ?? "{}";
  const productionThresholdMinimumUnits = rowValue(formData, index, "production_threshold_minimum_units");
  const { data: paymentMethod, error: methodError } = await supabaseAdmin
    .from("payment_methods")
    .select("id, code, production_threshold_config, payment_method_components (component_code, label, payment_fields(calculation_source, calculation_type))")
    .eq("id", paymentMethodId)
    .eq("company_id", companyId)
    .eq("is_active", true)
    .single();

  if (methodError) throw new Error(methodError.message);
  const methodComponents = (paymentMethod.payment_method_components ?? []) as ProviderPaymentComponent[];
  const { data: existingThresholdMapping, error: existingThresholdMappingError } = mappingId
    ? await supabaseAdmin
      .from("field_executive_provider_mappings")
      .select("payment_method_id, production_threshold_config, effective_from")
      .eq("id", mappingId)
      .eq("company_id", companyId)
      .maybeSingle()
    : { data: null, error: null };
  if (existingThresholdMappingError) throw new Error(existingThresholdMappingError.message);
  const storedThresholdSnapshot = parseProductionThresholdSnapshot(existingThresholdMapping?.production_threshold_config);
  const methodThresholdConfig = parseProductionThresholdConfig(paymentMethod.production_threshold_config);
  const editsExistingVersion = Boolean(existingThresholdMapping)
    && String(existingThresholdMapping?.effective_from ?? "") === effectiveFrom;
  const paymentMethodChanged = editsExistingVersion
    && String(existingThresholdMapping?.payment_method_id ?? "") !== paymentMethodId;
  let productionThresholdConfig: MappingProductionThresholdSnapshot;
  try {
    productionThresholdConfig = resolveMappingProductionThresholdSnapshot({
      existingValue: existingThresholdMapping?.production_threshold_config,
      editsExistingVersion,
      paymentMethodChanged,
      methodConfig: methodThresholdConfig,
      minimumUnits: productionThresholdMinimumUnits,
      inheritedMinimumUnits: storedThresholdSnapshot?.minimum_units
    });
    if (!methodThresholdConfig
      && productionThresholdMinimumUnits
      && !(editsExistingVersion && storedThresholdSnapshot)) {
      throw new Error("The selected payment method does not use a combined production minimum.");
    }
  } catch (error) {
    throw new Error(`Row ${index + 1}: ${error instanceof Error ? error.message : "Combined minimum is invalid."}`);
  }

  const [{ data: legacyWorker }, { data: station }] = await Promise.all([
    sourceType === "employee"
      ? supabaseAdmin
        .from("employees")
        .select("id, full_name, location_id, designations!inner(is_field_operations,provider_mapping_required)")
        .eq("id", id)
        .eq("company_id", companyId)
        .eq("is_active", true)
        .is("deleted_at", null)
        .eq("designations.is_field_operations", true)
        .maybeSingle()
      : sourceType === "contractor"
        ? supabaseAdmin
          .from("contractors")
          .select("id, full_name, location_id, designation")
          .eq("id", id)
          .eq("company_id", companyId)
          .eq("is_active", true)
          .is("deleted_at", null)
          .maybeSingle()
        : supabaseAdmin
        .from("workforce")
        .select("id, full_name, location_id, designation_id, designation")
        .eq("id", id)
        .eq("company_id", companyId)
        .is("deleted_at", null)
        .maybeSingle(),
    supabaseAdmin
      .from("stations")
      .select("id, station_code, provider_id")
      .eq("id", stationId)
      .eq("company_id", companyId)
      .maybeSingle()
  ]);

  const canonicalWorkerResult = legacyWorker
    ? { data: null, error: null }
    : await supabaseAdmin
      .from("workforce")
      .select("id, full_name, location_id, designation_id, designation")
      .eq("company_id", companyId)
      .eq("source_profile_type", sourceType)
      .eq("source_profile_id", id)
      .eq("is_active", true)
      .is("deleted_at", null)
      .maybeSingle();
  if (canonicalWorkerResult.error) throw new Error(canonicalWorkerResult.error.message);
  const worker = legacyWorker ?? canonicalWorkerResult.data;
  if (!worker) throw new Error(`Row ${index + 1}: Field Operations worker was not found for this company.`);
  const workerLocationId = String((worker as { location_id?: string | null }).location_id ?? "");
  if (allowedLocationIds && (!workerLocationId || !allowedLocationIds.has(workerLocationId))) {
    throw new Error(`Row ${index + 1}: The worker's current location is not allocated to your account.`);
  }
  if (sourceType === "workforce" && String((worker as { location_id?: string | null }).location_id ?? "") !== stationId) {
    throw new Error(`Row ${index + 1}: Location mismatch.`);
  }
  if (!station) throw new Error(`Row ${index + 1}: Location was not found for this company.`);
  const providerId = String(station.provider_id ?? "");
  if (!providerId) throw new Error(`Row ${index + 1}: The selected location does not have a provider configured.`);
  if (submittedProviderId && submittedProviderId !== providerId) {
    throw new Error(`Row ${index + 1}: Provider does not match the selected location. Refresh the page and try again.`);
  }
  if (!mappingId) {
    const workerColumn = sourceType === "workforce" ? "workforce_id"
      : sourceType === "employee" ? "employee_id"
        : sourceType === "contractor" ? "contractor_id"
          : "field_executive_id";
    const { data: existingCurrentMapping, error: existingCurrentMappingError } = await supabaseAdmin
      .from("field_executive_provider_mappings")
      .select("id, station_id")
      .eq("company_id", companyId)
      .eq(workerColumn, id)
      .is("effective_to", null)
      .neq("status", "cancelled")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existingCurrentMappingError) throw new Error(existingCurrentMappingError.message);
    if (existingCurrentMapping) {
      if (allowedLocationIds && (!existingCurrentMapping.station_id || !allowedLocationIds.has(existingCurrentMapping.station_id))) {
        throw new Error(`Row ${index + 1}: The existing active mapping is outside your allocated locations.`);
      }
      throw new Error(`Row ${index + 1}: An active mapping already exists. Reload the page and try again.`);
    }
  }
  const dropxName = String((worker as { full_name?: string | null }).full_name ?? "").trim();
  const { data: uploadedMember, error: uploadedMemberError } = await supabaseAdmin
    .from("cps_shipment_daily")
    .select("provider_employee_name")
    .eq("company_id", companyId)
    .eq("provider_employee_id", providerMemberId)
    .eq("station_code", station.station_code)
    .order("work_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (uploadedMemberError) throw new Error(uploadedMemberError.message);
  const uploadedHolderName = String(uploadedMember?.provider_employee_name ?? "").trim();
  if (!uploadedHolderName) {
    throw new Error(`Row ${index + 1}: No uploaded holder was found for this Provider Member ID.`);
  }
  if (!dropxName || !providerHolderMatches(uploadedHolderName, dropxName)) {
    throw new Error(`Row ${index + 1}: Name mismatch.`);
  }
  let providerMappingRequired = firstRelation((worker as { designations?: { provider_mapping_required?: boolean | null } | Array<{ provider_mapping_required?: boolean | null }> | null }).designations)?.provider_mapping_required !== false;
  if (sourceType === "contractor") {
    const contractorDesignation = String((worker as { designation?: string | null }).designation ?? "").trim().toLowerCase();
    const { data: fieldOperationsDesignations } = await supabaseAdmin
      .from("designations")
      .select("code, name, provider_mapping_required")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .eq("is_field_operations", true);
    const matchedDesignation = (fieldOperationsDesignations ?? []).find((designation) =>
      [designation.code, designation.name].some((value) => String(value ?? "").trim().toLowerCase() === contractorDesignation)
    );
    if (!matchedDesignation) throw new Error(`Row ${index + 1}: Contractor designation is not enabled for Field Operations.`);
    providerMappingRequired = matchedDesignation.provider_mapping_required !== false;
  } else if (sourceType === "workforce" || sourceType === "field_executive") {
    const matchedDesignation = await resolveFieldOperationsDesignationPolicy(companyId, worker as WorkforceDesignationReference);
    if (!matchedDesignation) throw new Error(`Row ${index + 1}: Workforce designation is not enabled for Field Operations.`);
    providerMappingRequired = matchedDesignation.provider_mapping_required !== false;
  }
  if (!providerMappingRequired && !mappingId) {
    throw new Error(`Row ${index + 1}: This designation uses Direct pay allocations and does not require a new provider ID mapping.`);
  }
  let paymentValues: Record<string, number> = {};
  try {
    const parsed = JSON.parse(rawPaymentValues) as Record<string, unknown>;
    paymentValues = Object.fromEntries(
      Object.entries(parsed)
        .map(([key, value]) => [key, String(value ?? "").trim()] as const)
        .filter(([, value]) => value !== "")
        .map(([key, value]) => {
          const number = Number(value);
          if (!Number.isFinite(number) || number < 0) {
            throw new Error(`Row ${index + 1}: ${key} must be a valid amount.`);
          }
          return [key, number] as const;
        })
    );
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error(`Row ${index + 1}: Payment values are invalid.`);
  }

  const components = methodComponents;
  const selectedComponentCodes = new Set(components.map((component) => component.component_code));
  paymentValues = Object.fromEntries(
    Object.entries(paymentValues).filter(([key]) => selectedComponentCodes.has(key))
  );

  for (const component of components) {
    if (paymentValues[component.component_code] === undefined) {
      throw new Error(`Row ${index + 1}: ${component.label} is required.`);
    }
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
    throw new Error(`Row ${index + 1}: Effective from must be YYYY-MM-DD.`);
  }

  if (effectiveTo && !/^\d{4}-\d{2}-\d{2}$/.test(effectiveTo)) {
    throw new Error(`Row ${index + 1}: Effective to must be YYYY-MM-DD.`);
  }

  if (effectiveTo && effectiveTo < effectiveFrom) {
    throw new Error(`Row ${index + 1}: Effective to cannot be before effective from.`);
  }
  if (monthlyThresholdChangeRequiresMonthStart(storedThresholdSnapshot, parseProductionThresholdSnapshot(productionThresholdConfig)) && !isFirstDayOfMonth(effectiveFrom)) {
    throw new Error(`Row ${index + 1}: Changes to an existing monthly combined minimum must start on the first day of a month.`);
  }

  const mappingPayload = withCompany({
    workforce_id: sourceType === "workforce" ? id : null,
    field_executive_id: sourceType === "field_executive" ? id : null,
    employee_id: sourceType === "employee" ? id : null,
    contractor_id: sourceType === "contractor" ? id : null,
    provider_id: providerId,
    provider_member_id: providerMemberId,
    station_id: stationId,
    effective_from: effectiveFrom,
    effective_to: effectiveTo,
    payment_method_id: paymentMethodId,
    payment_values: paymentValues,
    production_threshold_config: productionThresholdConfig,
    pay_type: paymentMethod.code,
    delivery_rate: null,
    pickup_rate: null,
    mfn_rate: null,
    mfn_return_rate: null,
    guarantee_amount: null,
    guarantee_schedule: null,
    fuel_rate: null,
    reason: null,
    status: effectiveTo ? "closed" : "active",
    updated_at: new Date().toISOString()
  }, companyId);

  const updateLegacyWorker = async () => {
    const workerUpdate = sourceType === "employee"
      ? admin.from("employees").update({ employee_code: dropxId, location_id: stationId, updated_at: new Date().toISOString() }).eq("id", id).eq("company_id", companyId)
      : sourceType === "contractor"
        ? admin.from("contractors").update({ dropx_id: dropxId, location_id: stationId, updated_at: new Date().toISOString() }).eq("id", id).eq("company_id", companyId)
        : admin.from("workforce").update({ dropx_id: dropxId, location_id: stationId, updated_at: new Date().toISOString() }).eq("id", id).eq("company_id", companyId);
    const { error } = await workerUpdate;
    if (error) throw new Error(error.message);
  };

  if (sourceType === "workforce") {
    let existingMapping: { effective_from: string; effective_to: string | null } | null = null;
    if (mappingId) {
      const { data, error } = await supabaseAdmin
        .from("field_executive_provider_mappings")
        .select("effective_from, effective_to, station_id")
        .eq("id", mappingId)
        .eq("company_id", companyId)
        .eq("workforce_id", id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) throw new Error(`Row ${index + 1}: Mapping history row was not found.`);
      if (allowedLocationIds && (!data.station_id || !allowedLocationIds.has(data.station_id))) {
        throw new Error(`Row ${index + 1}: The existing mapping is outside your allocated locations.`);
      }
      existingMapping = data;
    }

    const closureError = existingMapping ? ongoingMappingClosureError({
      existingEffectiveFrom: existingMapping.effective_from,
      existingEffectiveTo: existingMapping.effective_to,
      requestedEffectiveFrom: effectiveFrom,
      requestedEffectiveTo: effectiveTo
    }) : null;
    if (closureError) throw new Error(`Row ${index + 1}: ${closureError}`);

    const { error } = await supabaseAdmin.rpc("workforce_save_joining_mapping", {
      p_company: companyId,
      p_actor: createdBy,
      p_workforce: id,
      p_mapping: mappingId,
      p_dropx: dropxId,
      p_payload: mappingPayload,
      p_locations: allowedLocationIds ? Array.from(allowedLocationIds) : null,
      p_actor_name: "Dashboard mapping reviewer"
    });
    if (error) throw new Error(error.message);
    return;
  }

  if (!mappingId) {
    await updateLegacyWorker();
    const { error } = await supabaseAdmin
      .from("field_executive_provider_mappings")
      .insert({
        ...mappingPayload,
        created_by: createdBy
      });
    if (error) throw new Error(error.message);
    return;
  }

  const { data: existingMapping, error: existingError } = await supabaseAdmin
    .from("field_executive_provider_mappings")
    .select("id, effective_from, effective_to, station_id, workforce_id, employee_id, contractor_id, field_executive_id")
    .eq("id", mappingId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (existingError) throw new Error(existingError.message);
  if (!existingMapping) throw new Error(`Row ${index + 1}: Mapping history row was not found.`);
  if (allowedLocationIds && (!existingMapping.station_id || !allowedLocationIds.has(existingMapping.station_id))) {
    throw new Error(`Row ${index + 1}: The existing mapping is outside your allocated locations.`);
  }
  const existingWorkerId = sourceType === "employee" ? existingMapping.employee_id
      : sourceType === "contractor" ? existingMapping.contractor_id
        : existingMapping.field_executive_id;
  if (existingWorkerId !== id) throw new Error(`Row ${index + 1}: Mapping history does not belong to this worker.`);
  const closureError = ongoingMappingClosureError({
    existingEffectiveFrom: existingMapping.effective_from,
    existingEffectiveTo: existingMapping.effective_to,
    requestedEffectiveFrom: effectiveFrom,
    requestedEffectiveTo: effectiveTo
  });
  if (closureError) throw new Error(`Row ${index + 1}: ${closureError}`);
  await updateLegacyWorker();

  if (effectiveFrom > existingMapping.effective_from) {
    const closingDate = previousDate(effectiveFrom);
    if (closingDate < existingMapping.effective_from) {
      throw new Error(`Row ${index + 1}: New effective date must be after the existing period start.`);
    }

    const { error: closeError } = await supabaseAdmin
      .from("field_executive_provider_mappings")
      .update({
        effective_to: closingDate,
        status: "closed",
        updated_at: new Date().toISOString()
      })
      .eq("id", mappingId)
      .eq("company_id", companyId);

    if (closeError) throw new Error(closeError.message);

    const { error: insertError } = await supabaseAdmin
      .from("field_executive_provider_mappings")
      .insert({
        ...mappingPayload,
        created_by: createdBy
      });

    if (insertError) throw new Error(insertError.message);
    return;
  }

  const { error } = await supabaseAdmin
    .from("field_executive_provider_mappings")
    .update(mappingPayload)
    .eq("id", mappingId)
    .eq("company_id", companyId);

  if (error) throw new Error(error.message);
}

export async function saveProviderMappingWorksheet(formData: FormData) {
  const authorization = await getAuthorization();
  if (!authorization) redirect("/login");
  const companyId = requireCompanyId(authorization);
  if (!canEditProviderMappings(authorization)) {
    redirect(`/unauthorized?page=${currentProviderMappingPageCode()}&action=edit`);
  }

  let savedRows = 0;

  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");

    const rowCount = Number(formData.get("row_count") ?? 0);
    const saveRowIndex = clean(formData.get("save_row"));
    let dirtyIndexes: number[] = [];

    if (saveRowIndex === null) {
      try {
        const parsed = JSON.parse(clean(formData.get("dirty_row_indexes")) ?? "[]") as unknown;
        if (!Array.isArray(parsed)) throw new Error();
        dirtyIndexes = parsed.filter((index): index is number => Number.isInteger(index));
      } catch {
        throw new Error("Unable to identify edited rows. Refresh the page and try again.");
      }
    }

    const indexes = saveRowIndex !== null ? [Number(saveRowIndex)] : dirtyIndexes;

    if (!indexes.length) throw new Error("No rows to save.");

    for (const index of indexes) {
      if (!Number.isInteger(index) || index < 0 || index >= rowCount) {
        throw new Error("Invalid row selected.");
      }
      if (!nonEmptyRow(formData, index)) continue;
      const allowedLocationIds = authorization.hasAllLocationAccess || authorization.isMasterOwner || authorization.roleCode === "OWNER"
        ? null
        : new Set(authorization.locationScopeIds);
      await saveExecutiveMappingRow(formData, index, authorization.userId, companyId, allowedLocationIds);
      savedRows += 1;
    }

    revalidateTag("ops-cps");
    revalidatePath("/cps");
    revalidatePath("/provider-id-mapping");
    revalidatePath("/workforce");
  } catch (error) {
    mappingRedirect({ error: error instanceof Error ? error.message : "Unable to save mappings." });
  }

  mappingRedirect({ notice: `${savedRows} row${savedRows === 1 ? "" : "s"} saved.` });
}

function providerFirstMappingRedirect(params: { error?: string; notice?: string }) {
  cookies().set("dropx_provider_mapping_flash", JSON.stringify(params), {
    httpOnly: true,
    maxAge: 15,
    path: "/provider-id-mapping",
    sameSite: "lax"
  });
  redirect("/provider-id-mapping");
}

async function assertProviderFirstRowScope(
  companyId: string,
  workforceId: string,
  stationId: string,
  sourceType: string,
  allowedLocationIds: Set<string> | null,
  rowNumber: number
) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  if (sourceType !== "workforce") {
    throw new Error(`Row ${rowNumber}: Provider-first mappings must use the canonical workforce record.`);
  }
  if (allowedLocationIds && !allowedLocationIds.has(stationId)) {
    throw new Error(`Row ${rowNumber}: This location is not allocated to your account.`);
  }
  const { data: scopedWorker, error: scopedWorkerError } = await supabaseAdmin
    .from("workforce")
    .select("id")
    .eq("company_id", companyId)
    .eq("id", workforceId)
    .eq("location_id", stationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (scopedWorkerError) throw new Error(scopedWorkerError.message);
  if (!scopedWorker) {
    throw new Error(`Row ${rowNumber}: The selected DropX workforce ID is not available at this location.`);
  }
}

/** Saves the full provider-member-first worksheet.  It deliberately reuses the
 * same row validator and history-safe save path as the ID Mapping page. */
export async function saveProviderFirstMappingWorksheet(formData: FormData) {
  const authorization = await getAuthorization();
  if (!authorization) redirect("/login");
  const companyId = requireCompanyId(authorization);
  if (!canEditProviderMappings(authorization)) {
    redirect(`/unauthorized?page=${currentProviderMappingPageCode()}&action=edit`);
  }

  let savedRows = 0;
  try {
    const rowCount = Number(formData.get("row_count") ?? 0);
    const saveRow = clean(formData.get("save_row"));
    let indexes: number[];
    if (saveRow !== null) {
      indexes = [Number(saveRow)];
    } else {
      const parsed = JSON.parse(clean(formData.get("dirty_row_indexes")) ?? "[]") as unknown;
      if (!Array.isArray(parsed)) throw new Error("Unable to identify edited rows. Refresh the page and try again.");
      indexes = parsed.filter((value): value is number => Number.isInteger(value));
    }
    if (!indexes.length) throw new Error("No rows to save.");

    const allowedLocationIds = authorization.hasAllLocationAccess || authorization.isMasterOwner || authorization.roleCode === "OWNER"
      ? null
      : new Set(authorization.locationScopeIds);
    for (const index of indexes) {
      if (index < 0 || index >= rowCount) throw new Error("Invalid row selected.");
      const workforceId = rowRequired(formData, index, "id", "DropX workforce ID");
      const providerMemberId = rowRequired(formData, index, "provider_member_id", "Provider Member ID");
      const stationId = rowRequired(formData, index, "station_id", "Location");
      const sourceType = rowRequired(formData, index, "source_type", "Worker source");
      const submittedMappingId = rowValue(formData, index, "mapping_id");
      await assertProviderFirstRowScope(companyId, workforceId, stationId, sourceType, allowedLocationIds, index + 1);
      const { data: currentMapping, error: currentMappingError } = await supabaseAdmin!
        .from("field_executive_provider_mappings")
        .select("id, provider_member_id, station_id")
        .eq("company_id", companyId)
        .eq("workforce_id", workforceId)
        .is("effective_to", null)
        .neq("status", "cancelled")
        .maybeSingle();
      if (currentMappingError) throw new Error(currentMappingError.message);
      if (currentMapping && allowedLocationIds && (!currentMapping.station_id || !allowedLocationIds.has(currentMapping.station_id))) {
        throw new Error(`Row ${index + 1}: The existing active mapping is outside your allocated locations.`);
      }
      if ((currentMapping?.id ?? null) !== submittedMappingId) {
        throw new Error(`Row ${index + 1}: The active mapping changed. Reload the page and try again.`);
      }
      if (currentMapping && String(currentMapping.provider_member_id).trim().toUpperCase() !== providerMemberId.trim().toUpperCase()) {
        throw new Error(`Row ${index + 1}: This DropX ID already has a different active provider mapping.`);
      }
      await saveExecutiveMappingRow(formData, index, authorization.userId, companyId, allowedLocationIds);
      savedRows += 1;
    }
    revalidateTag("ops-cps");
    revalidatePath("/cps");
    revalidatePath("/provider-id-mapping");
    revalidatePath("/payments/workforce-payouts");
  } catch (error) {
    providerFirstMappingRedirect({ error: error instanceof Error ? error.message : "Unable to save provider-first mappings." });
  }
  providerFirstMappingRedirect({ notice: `${savedRows} row${savedRows === 1 ? "" : "s"} saved.` });
}

export type ProviderFirstInlineSavedRow = {
  clientKey: string;
  mappingId: string;
  workforceId: string;
  paymentMethodId: string;
  paymentValues: Record<string, string>;
  productionThresholdConfig: ProductionThresholdConfig | null;
  productionThresholdMinimumUnits: string;
  effectiveFrom: string;
  effectiveTo: string;
};

export type ProviderFirstInlineSaveResult = {
  ok: boolean;
  message: string;
  savedRows: ProviderFirstInlineSavedRow[];
  failedClientKey?: string;
};

/** Saves provider-first rows without redirecting or reloading the worksheet.
 * The authoritative validation and history-safe write remain in
 * saveExecutiveMappingRow; this wrapper only changes response delivery. */
export async function saveProviderFirstMappingsInline(formData: FormData): Promise<ProviderFirstInlineSaveResult> {
  const savedRows: ProviderFirstInlineSavedRow[] = [];
  let currentClientKey: string | undefined;
  try {
    const authorization = await getAuthorization();
    if (!authorization) return { ok: false, message: "Your sign-in session has expired. Reload the page and sign in again.", savedRows };
    const companyId = requireCompanyId(authorization);
    if (!canEditProviderMappings(authorization)) {
      return { ok: false, message: "You do not have permission to edit provider mappings.", savedRows };
    }
    if (!supabaseAdmin) return { ok: false, message: "Supabase service role key is not configured.", savedRows };

    const rowCount = Number(formData.get("row_count") ?? 0);
    if (!Number.isInteger(rowCount) || rowCount < 1 || rowCount > 5000) {
      return { ok: false, message: "The selected mapping rows are invalid. Reload the page and try again.", savedRows };
    }
    const allowedLocationIds = authorization.hasAllLocationAccess || authorization.isMasterOwner || authorization.roleCode === "OWNER"
      ? null
      : new Set(authorization.locationScopeIds);

    for (let index = 0; index < rowCount; index += 1) {
      currentClientKey = rowValue(formData, index, "client_key") ?? String(index);
      const workforceId = rowRequired(formData, index, "id", "DropX workforce ID");
      const providerMemberId = rowRequired(formData, index, "provider_member_id", "Provider Member ID");
      const stationId = rowRequired(formData, index, "station_id", "Location");
      const sourceType = rowRequired(formData, index, "source_type", "Worker source");
      const submittedMappingId = rowValue(formData, index, "mapping_id");
      await assertProviderFirstRowScope(companyId, workforceId, stationId, sourceType, allowedLocationIds, index + 1);
      const { data: currentMapping, error: currentMappingError } = await supabaseAdmin
        .from("field_executive_provider_mappings")
        .select("id, provider_member_id, station_id")
        .eq("company_id", companyId)
        .eq("workforce_id", workforceId)
        .is("effective_to", null)
        .neq("status", "cancelled")
        .maybeSingle();
      if (currentMappingError) throw new Error(currentMappingError.message);
      if (currentMapping && allowedLocationIds && (!currentMapping.station_id || !allowedLocationIds.has(currentMapping.station_id))) {
        throw new Error(`Row ${index + 1}: The existing active mapping is outside your allocated locations.`);
      }
      if ((currentMapping?.id ?? null) !== submittedMappingId) {
        throw new Error(`Row ${index + 1}: The active mapping changed. Reload the page and try again.`);
      }
      if (currentMapping && String(currentMapping.provider_member_id).trim().toUpperCase() !== providerMemberId.trim().toUpperCase()) {
        throw new Error(`Row ${index + 1}: This DropX ID already has a different active provider mapping.`);
      }

      await saveExecutiveMappingRow(formData, index, authorization.userId, companyId, allowedLocationIds);

      const { data: savedMapping, error: savedMappingError } = await supabaseAdmin
        .from("field_executive_provider_mappings")
        .select("id, workforce_id, payment_method_id, payment_values, production_threshold_config, effective_from, effective_to")
        .eq("company_id", companyId)
        .eq("workforce_id", workforceId)
        .eq("provider_member_id", providerMemberId)
        .eq("station_id", stationId)
        .neq("status", "cancelled")
        .order("effective_from", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (savedMappingError) throw new Error(savedMappingError.message);
      if (!savedMapping) throw new Error(`Row ${index + 1}: The saved mapping could not be reloaded.`);

      const thresholdSnapshot = parseProductionThresholdSnapshot(savedMapping.production_threshold_config);
      savedRows.push({
        clientKey: currentClientKey,
        mappingId: String(savedMapping.id),
        workforceId: String(savedMapping.workforce_id ?? workforceId),
        paymentMethodId: String(savedMapping.payment_method_id ?? ""),
        paymentValues: Object.fromEntries(Object.entries((savedMapping.payment_values ?? {}) as Record<string, string | number>).map(([key, value]) => [key, String(value)])),
        productionThresholdConfig: thresholdSnapshot ? { period: thresholdSnapshot.period, component_codes: thresholdSnapshot.component_codes } : null,
        productionThresholdMinimumUnits: thresholdSnapshot ? String(thresholdSnapshot.minimum_units) : "",
        effectiveFrom: String(savedMapping.effective_from ?? ""),
        effectiveTo: String(savedMapping.effective_to ?? "")
      });
    }

    revalidateTag("ops-cps");
    return { ok: true, message: `${savedRows.length} row${savedRows.length === 1 ? "" : "s"} saved.`, savedRows };
  } catch (error) {
    if (savedRows.length) revalidateTag("ops-cps");
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Unable to save provider-first mappings.",
      savedRows,
      failedClientKey: currentClientKey
    };
  }
}

/** Links an imported provider member to an existing canonical workforce record.
 * Payment-method and rate configuration remains on the ID Mapping page. */
export async function saveProviderFirstMapping(formData: FormData) {
  const authorization = await getAuthorization();
  if (!authorization) redirect("/login");
  const companyId = requireCompanyId(authorization);
  if (!canEditProviderMappings(authorization)) {
    redirect(`/unauthorized?page=${currentProviderMappingPageCode()}&action=edit`);
  }

  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const providerMemberId = clean(formData.get("provider_member_id"));
    const workforceId = clean(formData.get("workforce_id"));
    const stationId = clean(formData.get("station_id"));
    if (!providerMemberId || !workforceId || !stationId) throw new Error("Provider Member ID, workforce DropX ID, and location are required.");
    if (isScientificProviderMemberId(providerMemberId)) {
      throw new Error("This Provider Member ID is rounded. Reimport a report containing the full ID before mapping it.");
    }

    const allowedLocationIds = authorization.hasAllLocationAccess || authorization.isMasterOwner || authorization.roleCode === "OWNER"
      ? null
      : new Set(authorization.locationScopeIds);
    if (allowedLocationIds && !allowedLocationIds.has(stationId)) throw new Error("This location is not allocated to your account.");

    const [{ data: worker, error: workerError }, { data: station, error: stationError }, { data: memberMapping, error: memberMappingError }, { data: workerMapping, error: workerMappingError }] = await Promise.all([
      supabaseAdmin.from("workforce").select("id, full_name, location_id, designation_id, designation, is_active").eq("id", workforceId).eq("company_id", companyId).is("deleted_at", null).maybeSingle(),
      supabaseAdmin.from("stations").select("id, provider_id, station_code").eq("id", stationId).eq("company_id", companyId).eq("is_active", true).maybeSingle(),
      supabaseAdmin.from("field_executive_provider_mappings").select("id, workforce_id").eq("company_id", companyId).eq("provider_member_id", providerMemberId).is("effective_to", null).neq("status", "cancelled").maybeSingle(),
      supabaseAdmin.from("field_executive_provider_mappings").select("id, payment_method_id, payment_values, pay_type, effective_from, station_id").eq("company_id", companyId).eq("workforce_id", workforceId).is("effective_to", null).neq("status", "cancelled").order("created_at", { ascending: false }).limit(1).maybeSingle()
    ]);
    if (workerError || stationError || memberMappingError || workerMappingError) throw new Error(workerError?.message || stationError?.message || memberMappingError?.message || workerMappingError?.message || "Unable to load mapping data.");
    if (workerMapping && allowedLocationIds && (!workerMapping.station_id || !allowedLocationIds.has(workerMapping.station_id))) {
      throw new Error("The existing active mapping is outside your allocated locations.");
    }
    if (!worker?.is_active) throw new Error("The selected workforce record is no longer active.");
    if (worker.location_id !== stationId) throw new Error("The selected workforce member belongs to a different location.");
    if (!station?.provider_id) throw new Error("The selected location does not have a provider configured.");
    const { data: uploadedMember, error: uploadedMemberError } = await supabaseAdmin
      .from("cps_shipment_daily")
      .select("provider_employee_name")
      .eq("company_id", companyId)
      .eq("provider_employee_id", providerMemberId)
      .eq("station_code", station.station_code)
      .order("work_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (uploadedMemberError) throw new Error(uploadedMemberError.message);
    const uploadedHolderName = String(uploadedMember?.provider_employee_name ?? "").trim();
    if (!uploadedHolderName) throw new Error("No uploaded holder was found for this Provider Member ID at the selected location.");
    if (!providerHolderMatches(uploadedHolderName, String(worker.full_name ?? ""))) throw new Error("Provider Member ID holder name does not match the selected workforce member.");
    if (memberMapping && memberMapping.workforce_id !== workforceId) throw new Error("This Provider Member ID is already actively linked to another workforce record.");
    const designation = await resolveFieldOperationsDesignationPolicy(companyId, worker);
    if (!designation) throw new Error("The selected workforce designation is not enabled for Field Operations.");
    if (designation.provider_mapping_required === false && !workerMapping) {
      throw new Error("This designation uses Direct pay allocations and does not require a new provider ID mapping.");
    }

    const now = new Date().toISOString();
    if (workerMapping) {
      const { error } = await supabaseAdmin.from("field_executive_provider_mappings").update({
        provider_member_id: providerMemberId,
        provider_id: station.provider_id,
        station_id: stationId,
        updated_at: now
      }).eq("id", workerMapping.id).eq("company_id", companyId);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supabaseAdmin.from("field_executive_provider_mappings").insert(withCompany({
        workforce_id: workforceId,
        provider_id: station.provider_id,
        station_id: stationId,
        provider_member_id: providerMemberId,
        effective_from: new Date().toISOString().slice(0, 10),
        payment_method_id: null,
        payment_values: {},
        pay_type: "UNALLOCATED",
        status: "active",
        created_by: authorization.userId,
        updated_at: now
      }, companyId));
      if (error) throw new Error(error.message);
    }
    revalidateTag("ops-cps");
    revalidatePath("/cps");
    revalidatePath("/provider-id-mapping");
    revalidatePath("/payments/workforce-payouts");
  } catch (error) {
    providerFirstMappingRedirect({ error: error instanceof Error ? error.message : "Unable to save provider-first mapping." });
  }
  providerFirstMappingRedirect({ notice: "Provider Member ID linked to workforce. Configure the payment method and rates on this ID Mapping page if needed." });
}
