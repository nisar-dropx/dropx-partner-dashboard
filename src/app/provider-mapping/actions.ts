"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import * as XLSX from "xlsx";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId, withCompany } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

function clean(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text.length ? text : null;
}

function mappingRedirect(params: { error?: string; notice?: string }) {
  cookies().set("dropx_provider_mapping_flash", JSON.stringify(params), {
    httpOnly: true,
    maxAge: 15,
    path: "/provider-mapping",
    sameSite: "lax"
  });
  redirect("/provider-mapping");
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

function providerNameTokens(value: string) {
  return value
    .split("/")[0]
    .normalize("NFKD")
    .toLocaleUpperCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter(Boolean);
}

const COMMON_NAME_TOKENS = new Set([
  "KUMAR", "KUMARI", "AHAMMED", "AHMED", "AHMAD", "MOHAMMED", "MUHAMMED", "MOHAMMAD", "MOHD", "MD",
  "SINGH", "DEVI", "DAS", "LAL", "RAJ", "KRISHNA", "PRASAD", "KUMARAN", "BEGUM", "BI", "BEE"
]);

function tokenDistance(first: string, second: string) {
  const previous = Array.from({ length: second.length + 1 }, (_, index) => index);
  for (let row = 1; row <= first.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= second.length; column += 1) {
      current[column] = Math.min(current[column - 1] + 1, previous[column] + 1, previous[column - 1] + (first[row - 1] === second[column - 1] ? 0 : 1));
    }
    for (let index = 0; index < current.length; index += 1) previous[index] = current[index];
  }
  return previous[second.length];
}

function providerHolderMatches(holderName: string, workerName: string) {
  const holderTokens = providerNameTokens(holderName).filter((token) => token.length >= 4 && !COMMON_NAME_TOKENS.has(token));
  const workerTokens = providerNameTokens(workerName).filter((token) => token.length >= 4 && !COMMON_NAME_TOKENS.has(token));
  return holderTokens.some((holderToken) => workerTokens.some((workerToken) =>
    holderToken === workerToken || (Math.min(holderToken.length, workerToken.length) >= 6 && tokenDistance(holderToken, workerToken) <= 1)
  ));
}

function normalizedHeader(value: unknown) {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function bulkCell(row: Record<string, unknown>, aliases: string[]) {
  for (const [key, value] of Object.entries(row)) {
    if (aliases.includes(normalizedHeader(key))) return String(value ?? "").trim();
  }
  return "";
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
  if (!hasPermission(authorization, "provider_mapping", "add") && !hasPermission(authorization, "provider_mapping", "edit")) {
    redirect("/unauthorized?page=provider_mapping&action=edit");
  }

  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const file = formData.get("mapping_file");
    if (!(file instanceof File) || !file.size) throw new Error("Select an Excel or CSV file to upload.");
    if (file.size > 10 * 1024 * 1024) throw new Error("The upload file must be 10 MB or smaller.");

    const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", raw: false });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) throw new Error("The uploaded file does not contain a worksheet.");
    const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
    const uploadRows = rawRows.map((row, index) => ({
      rowNumber: index + 2,
      dropxId: bulkCell(row, ["DROPX_ID", "DROPXID", "DROPX_ID_CODE"]).toUpperCase(),
      providerMemberId: bulkCell(row, ["PROVIDER_MEMBER_ID", "PROVIDER_ID", "MEMBER_ID", "PROVIDER_EMPLOYEE_ID"]),
      paymentMethodCode: bulkCell(row, ["PAYMENT_METHOD_CODE", "PAYMENT_METHOD", "METHOD_CODE"]).toUpperCase(),
      effectiveFromRaw: bulkCell(row, ["EFFECTIVE_FROM", "FROM_DATE"]),
      effectiveToRaw: bulkCell(row, ["EFFECTIVE_TO", "TO_DATE"]),
      cells: Object.fromEntries(Object.entries(row).map(([key, value]) => [normalizedHeader(key), String(value ?? "").trim()]))
    })).filter((row) => row.dropxId || row.providerMemberId || row.paymentMethodCode);
    if (!uploadRows.length) throw new Error("No DropX ID or Provider Member ID rows were found.");

    const dropxIds = Array.from(new Set(uploadRows.map((row) => row.dropxId).filter(Boolean)));
    const [{ data: employees, error: employeeError }, { data: contractors, error: contractorError }, { data: executives, error: executiveError }, { data: designations, error: designationError }, { data: paymentMethods, error: paymentMethodsError }] = await Promise.all([
      supabaseAdmin.from("employees").select("id, employee_code, full_name, location_id, date_of_join, designations!inner(is_field_operations)").eq("company_id", companyId).eq("is_active", true).is("deleted_at", null).eq("designations.is_field_operations", true).in("employee_code", dropxIds),
      supabaseAdmin.from("contractors").select("id, dropx_id, full_name, location_id, date_of_join, designation").eq("company_id", companyId).eq("is_active", true).is("deleted_at", null).in("dropx_id", dropxIds),
      supabaseAdmin.from("workforce").select("id, dropx_id, full_name, location_id, date_of_join").eq("company_id", companyId).eq("is_active", true).in("dropx_id", dropxIds),
      supabaseAdmin.from("designations").select("code, name").eq("company_id", companyId).eq("is_active", true).eq("is_field_operations", true),
      supabaseAdmin.from("payment_methods").select("id, code, payment_method_components(component_code, label)").eq("company_id", companyId).eq("is_active", true)
    ]);
    if (employeeError) throw new Error(employeeError.message);
    if (contractorError) throw new Error(contractorError.message);
    if (executiveError) throw new Error(executiveError.message);
    if (designationError) throw new Error(designationError.message);
    if (paymentMethodsError) throw new Error(paymentMethodsError.message);

    const paymentMethodByCode = new Map((paymentMethods ?? []).map((method) => [String(method.code ?? "").trim().toUpperCase(), {
      id: String(method.id),
      code: String(method.code ?? "").trim(),
      components: (method.payment_method_components ?? []) as Array<{ component_code: string; label: string }>
    }]));
    const allPaymentFieldCodes = new Set(Array.from(paymentMethodByCode.values()).flatMap((method) => method.components.map((component) => normalizedHeader(component.component_code))));

    const fieldOperationsDesignations = new Set((designations ?? []).flatMap((row) => [row.code, row.name]).map((value) => String(value ?? "").trim().toLowerCase()));

    const workers = new Map<string, BulkWorker>();
    (employees ?? []).forEach((row) => workers.set(String(row.employee_code ?? "").toUpperCase(), {
      id: row.id, sourceType: "employee", dropxId: String(row.employee_code ?? "").toUpperCase(), fullName: String(row.full_name ?? ""), stationId: String(row.location_id ?? ""), effectiveFrom: String(row.date_of_join ?? "")
    }));
    (contractors ?? []).filter((row) => fieldOperationsDesignations.has(String(row.designation ?? "").trim().toLowerCase())).forEach((row) => workers.set(String(row.dropx_id ?? "").toUpperCase(), {
      id: row.id, sourceType: "contractor", dropxId: String(row.dropx_id ?? "").toUpperCase(), fullName: String(row.full_name ?? ""), stationId: String(row.location_id ?? ""), effectiveFrom: String(row.date_of_join ?? "")
    }));
    (executives ?? []).forEach((row) => workers.set(String(row.dropx_id ?? "").toUpperCase(), {
      id: row.id, sourceType: "workforce", dropxId: String(row.dropx_id ?? "").toUpperCase(), fullName: String(row.full_name ?? ""), stationId: String(row.location_id ?? ""), effectiveFrom: String(row.date_of_join ?? "")
    }));

    const allowedLocationIds = authorization.hasAllLocationAccess || authorization.isMasterOwner || authorization.roleCode === "OWNER"
      ? null
      : new Set(authorization.locationScopeIds);
    const eligibleWorkers = new Map(Array.from(workers.entries()).filter(([, worker]) => !allowedLocationIds || allowedLocationIds.has(worker.stationId)));
    const stationIds = Array.from(new Set(Array.from(eligibleWorkers.values()).map((worker) => worker.stationId).filter(Boolean))) as string[];
    const { data: stations, error: stationsError } = await supabaseAdmin.from("stations").select("id, provider_id").eq("company_id", companyId).in("id", stationIds);
    if (stationsError) throw new Error(stationsError.message);
    const providerByStation = new Map((stations ?? []).map((station) => [station.id, String(station.provider_id ?? "")]));
    const memberIds = Array.from(new Set(uploadRows.map((row) => row.providerMemberId).filter(Boolean)));
    const memberNameById = new Map<string, string>();
    for (let offset = 0; offset < memberIds.length; offset += 200) {
      const { data, error } = await supabaseAdmin.from("cps_shipment_daily")
        .select("provider_employee_id, provider_employee_name, work_date, created_at")
        .eq("company_id", companyId)
        .in("provider_employee_id", memberIds.slice(offset, offset + 200))
        .order("work_date", { ascending: false })
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      (data ?? []).forEach((row) => {
        const memberId = String(row.provider_employee_id ?? "").trim();
        if (memberId && !memberNameById.has(memberId)) memberNameById.set(memberId, String(row.provider_employee_name ?? "").trim());
      });
    }
    let saved = 0;
    const seenDropxIds = new Set<string>();
    const reportRows: BulkUploadReportRow[] = [];
    for (const uploadRow of uploadRows) {
      const reportRow = { rowNumber: uploadRow.rowNumber, dropxId: uploadRow.dropxId, providerMemberId: uploadRow.providerMemberId, paymentMethodCode: uploadRow.paymentMethodCode };
      const skipped = (reason: string) => reportRows.push({ ...reportRow, result: "Skipped", reason });
      if (!uploadRow.dropxId || !uploadRow.providerMemberId) { skipped("DropX ID or Provider Member ID is blank."); continue; }
      if (seenDropxIds.has(uploadRow.dropxId)) { skipped("Duplicate DropX ID in this upload."); continue; }
      seenDropxIds.add(uploadRow.dropxId);
      const worker = eligibleWorkers.get(uploadRow.dropxId);
      if (!worker) { skipped("DropX ID is not available in the current mapping list."); continue; }
      const providerId = providerByStation.get(worker.stationId);
      if (!providerId) { skipped("The worker's location has no provider configured."); continue; }
      const holderName = memberNameById.get(uploadRow.providerMemberId);
      if (!holderName) { skipped("Provider Member ID was not found in uploaded provider data."); continue; }
      const suppliedPaymentValues = Array.from(allPaymentFieldCodes).some((code) => String(uploadRow.cells[code] ?? "").trim() !== "");
      const hasAllocationData = Boolean(uploadRow.paymentMethodCode || uploadRow.effectiveFromRaw || uploadRow.effectiveToRaw || suppliedPaymentValues);
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
        .select("id, effective_from")
        .eq("company_id", companyId)
        .eq(workerColumn, worker.id)
        .is("effective_to", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existingError) throw new Error(existingError.message);

      const fallbackEffectiveFrom = /^\d{4}-\d{2}-\d{2}$/.test(worker.effectiveFrom) ? worker.effectiveFrom : new Date().toISOString().slice(0, 10);
      const allocationPayload = paymentMethod ? {
        payment_method_id: paymentMethod.id,
        payment_values: paymentValues,
        pay_type: paymentMethod.code
      } : {};
      const requestedEffectiveFrom = effectiveFrom || String(existing?.effective_from ?? fallbackEffectiveFrom);

      if (existing && paymentMethod && effectiveFrom && effectiveFrom > String(existing.effective_from)) {
        const closingDate = previousDate(effectiveFrom);
        const { error: closeError } = await supabaseAdmin.from("field_executive_provider_mappings").update({ effective_to: closingDate, status: "closed", updated_at: new Date().toISOString() }).eq("id", existing.id).eq("company_id", companyId);
        if (closeError) { skipped(closeError.message); continue; }
        const { error: insertError } = await supabaseAdmin.from("field_executive_provider_mappings").insert(withCompany({
          workforce_id: worker.sourceType === "workforce" ? worker.id : null,
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

    revalidatePath("/provider-mapping");
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

  const id = rowRequired(formData, index, "id", "Field executive");
  const sourceType = rowRequired(formData, index, "source_type", "Worker source");
  if (sourceType !== "employee" && sourceType !== "contractor" && sourceType !== "field_executive" && sourceType !== "workforce") {
    throw new Error(`Row ${index + 1}: Worker source is invalid.`);
  }
  const mappingId = rowValue(formData, index, "mapping_id");
  const dropxId = rowRequired(formData, index, "dropx_id", "DropX ID").toUpperCase();
  const providerId = rowRequired(formData, index, "provider_id", "Provider");
  const providerMemberId = rowRequired(formData, index, "provider_member_id", "Provider Member ID");
  const stationId = rowRequired(formData, index, "station_id", "Location");
  if (allowedLocationIds && !allowedLocationIds.has(stationId)) {
    throw new Error(`Row ${index + 1}: This location is not allocated to your account.`);
  }
  const effectiveFrom = rowRequired(formData, index, "effective_from", "Effective from");
  const effectiveTo = rowValue(formData, index, "effective_to");
  const paymentMethodId = rowRequired(formData, index, "payment_method_id", "Payment method");
  const rawPaymentValues = rowValue(formData, index, "payment_values_json") ?? "{}";
  const { data: paymentMethod, error: methodError } = await supabaseAdmin
    .from("payment_methods")
    .select("id, code, payment_method_components (component_code, label)")
    .eq("id", paymentMethodId)
    .eq("company_id", companyId)
    .eq("is_active", true)
    .single();

  if (methodError) throw new Error(methodError.message);

  const [{ data: legacyWorker }, { data: station }] = await Promise.all([
    sourceType === "employee"
      ? supabaseAdmin
        .from("employees")
        .select("id, full_name, designations!inner(is_field_operations)")
        .eq("id", id)
        .eq("company_id", companyId)
        .eq("is_active", true)
        .is("deleted_at", null)
        .eq("designations.is_field_operations", true)
        .maybeSingle()
      : sourceType === "contractor"
        ? supabaseAdmin
          .from("contractors")
          .select("id, full_name, designation")
          .eq("id", id)
          .eq("company_id", companyId)
          .eq("is_active", true)
          .is("deleted_at", null)
          .maybeSingle()
        : supabaseAdmin
        .from("workforce")
        .select("id, full_name")
        .eq("id", id)
        .eq("company_id", companyId)
        .is("deleted_at", null)
        .maybeSingle(),
    supabaseAdmin
      .from("stations")
      .select("id")
      .eq("id", stationId)
      .eq("company_id", companyId)
      .maybeSingle()
  ]);

  const canonicalWorkerResult = legacyWorker
    ? { data: null, error: null }
    : await supabaseAdmin
      .from("workforce")
      .select("id, full_name")
      .eq("company_id", companyId)
      .eq("source_profile_type", sourceType)
      .eq("source_profile_id", id)
      .eq("is_active", true)
      .is("deleted_at", null)
      .maybeSingle();
  if (canonicalWorkerResult.error) throw new Error(canonicalWorkerResult.error.message);
  const worker = legacyWorker ?? canonicalWorkerResult.data;
  if (!worker) throw new Error(`Row ${index + 1}: Field Operations worker was not found for this company.`);
  const dropxName = String((worker as { full_name?: string | null }).full_name ?? "").trim();
  const { data: uploadedMember, error: uploadedMemberError } = await supabaseAdmin
    .from("cps_shipment_daily")
    .select("provider_employee_name")
    .eq("company_id", companyId)
    .eq("provider_employee_id", providerMemberId)
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
  if (sourceType === "contractor") {
    const contractorDesignation = String((worker as { designation?: string | null }).designation ?? "").trim().toLowerCase();
    const { data: fieldOperationsDesignations } = await supabaseAdmin
      .from("designations")
      .select("code, name")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .eq("is_field_operations", true);
    const isFieldOperations = (fieldOperationsDesignations ?? []).some((designation) =>
      [designation.code, designation.name].some((value) => String(value ?? "").trim().toLowerCase() === contractorDesignation)
    );
    if (!isFieldOperations) throw new Error(`Row ${index + 1}: Contractor designation is not enabled for Field Operations.`);
  }
  if (!station) throw new Error(`Row ${index + 1}: Location was not found for this company.`);

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

  const components = (paymentMethod.payment_method_components ?? []) as Array<{ component_code: string; label: string }>;
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

  const workerUpdate = sourceType === "employee"
    ? supabaseAdmin.from("employees").update({ employee_code: dropxId, location_id: stationId, updated_at: new Date().toISOString() }).eq("id", id).eq("company_id", companyId)
    : sourceType === "contractor"
      ? supabaseAdmin.from("contractors").update({ dropx_id: dropxId, location_id: stationId, updated_at: new Date().toISOString() }).eq("id", id).eq("company_id", companyId)
      : supabaseAdmin.from("workforce").update({ dropx_id: dropxId, location_id: stationId, updated_at: new Date().toISOString() }).eq("id", id).eq("company_id", companyId);
  const { error: executiveError } = await workerUpdate;

  if (executiveError) throw new Error(executiveError.message);

  if (!mappingId) {
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
    .select("id, effective_from, effective_to")
    .eq("id", mappingId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (existingError) throw new Error(existingError.message);
  if (!existingMapping) throw new Error(`Row ${index + 1}: Mapping history row was not found.`);

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
  if (!hasPermission(authorization, "provider_mapping", "add") && !hasPermission(authorization, "provider_mapping", "edit")) {
    redirect("/unauthorized?page=provider_mapping&action=edit");
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

    revalidatePath("/provider-mapping");
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
    path: "/provider-mapping",
    sameSite: "lax"
  });
  redirect("/provider-mapping/provider-first");
}

/** Saves the full provider-member-first worksheet.  It deliberately reuses the
 * same row validator and history-safe save path as the existing worksheet. */
export async function saveProviderFirstMappingWorksheet(formData: FormData) {
  const authorization = await getAuthorization();
  if (!authorization) redirect("/login");
  const companyId = requireCompanyId(authorization);
  if (!hasPermission(authorization, "provider_mapping", "add") && !hasPermission(authorization, "provider_mapping", "edit")) {
    redirect("/unauthorized?page=provider_mapping&action=edit");
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
      const { data: currentMapping, error: currentMappingError } = await supabaseAdmin!
        .from("field_executive_provider_mappings")
        .select("id, provider_member_id")
        .eq("company_id", companyId)
        .eq("workforce_id", workforceId)
        .is("effective_to", null)
        .neq("status", "cancelled")
        .maybeSingle();
      if (currentMappingError) throw new Error(currentMappingError.message);
      if (currentMapping && String(currentMapping.provider_member_id) !== providerMemberId) {
        throw new Error(`Row ${index + 1}: This DropX ID is already mapped to Provider Member ID ${currentMapping.provider_member_id}.`);
      }
      await saveExecutiveMappingRow(formData, index, authorization.userId, companyId, allowedLocationIds);
      savedRows += 1;
    }
    revalidatePath("/provider-mapping");
    revalidatePath("/provider-mapping/provider-first");
    revalidatePath("/payments/workforce-payouts");
  } catch (error) {
    providerFirstMappingRedirect({ error: error instanceof Error ? error.message : "Unable to save provider-first mappings." });
  }
  providerFirstMappingRedirect({ notice: `${savedRows} row${savedRows === 1 ? "" : "s"} saved.` });
}

/** Links an imported provider member to an existing canonical workforce record.
 * Payment-method and rate configuration remains on the existing worksheet. */
export async function saveProviderFirstMapping(formData: FormData) {
  const authorization = await getAuthorization();
  if (!authorization) redirect("/login");
  const companyId = requireCompanyId(authorization);
  if (!hasPermission(authorization, "provider_mapping", "add") && !hasPermission(authorization, "provider_mapping", "edit")) {
    redirect("/unauthorized?page=provider_mapping&action=edit");
  }

  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const providerMemberId = clean(formData.get("provider_member_id"));
    const workforceId = clean(formData.get("workforce_id"));
    const stationId = clean(formData.get("station_id"));
    if (!providerMemberId || !workforceId || !stationId) throw new Error("Provider Member ID, workforce DropX ID, and location are required.");

    const allowedLocationIds = authorization.hasAllLocationAccess || authorization.isMasterOwner || authorization.roleCode === "OWNER"
      ? null
      : new Set(authorization.locationScopeIds);
    if (allowedLocationIds && !allowedLocationIds.has(stationId)) throw new Error("This location is not allocated to your account.");

    const [{ data: worker, error: workerError }, { data: station, error: stationError }, { data: memberMapping, error: memberMappingError }, { data: workerMapping, error: workerMappingError }] = await Promise.all([
      supabaseAdmin.from("workforce").select("id, full_name, location_id, is_active").eq("id", workforceId).eq("company_id", companyId).is("deleted_at", null).maybeSingle(),
      supabaseAdmin.from("stations").select("id, provider_id").eq("id", stationId).eq("company_id", companyId).eq("is_active", true).maybeSingle(),
      supabaseAdmin.from("field_executive_provider_mappings").select("id, workforce_id").eq("company_id", companyId).eq("provider_member_id", providerMemberId).is("effective_to", null).neq("status", "cancelled").maybeSingle(),
      supabaseAdmin.from("field_executive_provider_mappings").select("id, payment_method_id, payment_values, pay_type, effective_from").eq("company_id", companyId).eq("workforce_id", workforceId).is("effective_to", null).neq("status", "cancelled").order("created_at", { ascending: false }).limit(1).maybeSingle()
    ]);
    if (workerError || stationError || memberMappingError || workerMappingError) throw new Error(workerError?.message || stationError?.message || memberMappingError?.message || workerMappingError?.message || "Unable to load mapping data.");
    if (!worker?.is_active) throw new Error("The selected workforce record is no longer active.");
    if (!station?.provider_id) throw new Error("The selected location does not have a provider configured.");
    if (memberMapping && memberMapping.workforce_id !== workforceId) throw new Error("This Provider Member ID is already actively linked to another workforce record.");

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
    revalidatePath("/provider-mapping");
    revalidatePath("/provider-mapping/provider-first");
    revalidatePath("/payments/workforce-payouts");
  } catch (error) {
    providerFirstMappingRedirect({ error: error instanceof Error ? error.message : "Unable to save provider-first mapping." });
  }
  providerFirstMappingRedirect({ notice: "Provider Member ID linked to workforce. Configure payment and rates in the Existing mapping worksheet if needed." });
}
