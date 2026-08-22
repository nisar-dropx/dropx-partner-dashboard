"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
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

function comparableProviderName(value: string) {
  return value
    .split("/")[0]
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLocaleUpperCase();
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
  if (sourceType !== "employee" && sourceType !== "contractor" && sourceType !== "field_executive") {
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

  const [{ data: worker }, { data: station }] = await Promise.all([
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
        .from("field_executives")
        .select("id, full_name")
        .eq("id", id)
        .eq("company_id", companyId)
        .eq("is_active", true)
        .maybeSingle(),
    supabaseAdmin
      .from("stations")
      .select("id")
      .eq("id", stationId)
      .eq("company_id", companyId)
      .maybeSingle()
  ]);

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
  if (!dropxName || comparableProviderName(uploadedHolderName) !== comparableProviderName(dropxName)) {
    throw new Error(`Row ${index + 1}: Uploaded holder name does not match the DropX name.`);
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
      : supabaseAdmin.from("field_executives").update({ dropx_id: dropxId, location_id: stationId, updated_at: new Date().toISOString() }).eq("id", id).eq("company_id", companyId);
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
    revalidatePath("/field-executive");
  } catch (error) {
    mappingRedirect({ error: error instanceof Error ? error.message : "Unable to save mappings." });
  }

  mappingRedirect({ notice: `${savedRows} row${savedRows === 1 ? "" : "s"} saved.` });
}
