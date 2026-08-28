"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId, withCompany } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { AMAZON_PAYMENT_CALCULATION_SOURCES, INTERNAL_PAYMENT_CALCULATION_SOURCES, type PaymentCalculationType } from "@/lib/payment-calculation";

function clean(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text.length ? text : null;
}

function required(value: FormDataEntryValue | null, field: string) {
  const text = clean(value);
  if (!text) {
    throw new Error(`${field} is required`);
  }
  return text;
}

function paymentMethodRedirect(params: { error?: string; notice?: string }) {
  cookies().set("dropx_payment_method_flash", JSON.stringify(params), {
    httpOnly: true,
    maxAge: 15,
    path: "/master/payment-methods",
    sameSite: "lax"
  });
  redirect("/master/payment-methods");
}

export async function createPaymentMethod(formData: FormData) {
  const authorization = await requirePagePermission("payment_methods", "add");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) {
    throw new Error("Supabase service role key is not configured");
  }

  const code = required(formData.get("code"), "Method ID").toUpperCase();
  const name = required(formData.get("name"), "Method name");
  const components = await selectedPaymentFields(formData, companyId);

  const { data: method, error } = await supabaseAdmin
    .from("payment_methods")
    .insert(withCompany({ code, name, is_active: true }, companyId))
    .select("id")
    .single();

  if (error) throw new Error(error.message);

  const { error: componentError } = await supabaseAdmin
    .from("payment_method_components")
    .insert(components.map((component) => ({
      ...component,
      payment_method_id: method.id
    })));

  if (componentError) throw new Error(componentError.message);

  revalidatePath("/master/payment-methods");
}

async function selectedPaymentFields(formData: FormData, companyId: string) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");
  const ids = [...new Set(formData.getAll("field_ids").map((entry) => String(entry).trim()).filter(Boolean))];
  if (!ids.length) throw new Error("Select at least one payment field.");
  const result = await supabaseAdmin
    .from("payment_fields")
    .select("id, code, field_type, label, pay_schedule")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .in("id", ids);
  if (result.error) throw new Error(result.error.message);
  if ((result.data ?? []).length !== ids.length) throw new Error("One or more selected payment fields are unavailable.");
  const byId = new Map((result.data ?? []).map((field) => [String(field.id), field]));
  return ids.map((id, index) => {
    const field = byId.get(id)!;
    return {
      payment_field_id: field.id,
      component_code: field.code,
      component_type: field.field_type,
      label: field.label,
      pay_schedule: field.pay_schedule,
      sort_order: index + 1,
      is_active: true,
      company_id: companyId
    };
  });
}

export async function updatePaymentMethod(formData: FormData) {
  const authorization = await requirePagePermission("payment_methods", "edit");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");
  const admin = supabaseAdmin;

  const id = required(formData.get("id"), "Payment method");
  const code = required(formData.get("code"), "Method ID").toUpperCase();
  const name = required(formData.get("name"), "Method name");
  const components = await selectedPaymentFields(formData, companyId);

  const existingMethod = await admin
    .from("payment_methods")
    .select("id")
    .eq("id", id)
    .eq("company_id", companyId)
    .single();
  if (existingMethod.error) throw new Error("Payment method not found for this company.");

  const { error: methodError } = await admin
    .from("payment_methods")
    .update({ code, name, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("company_id", companyId);
  if (methodError) throw new Error(methodError.message);

  const existingComponents = await admin.from("payment_method_components")
    .select("id, payment_field_id").eq("payment_method_id", id).eq("company_id", companyId);
  if (existingComponents.error) throw new Error(existingComponents.error.message);
  const existingByField = new Map((existingComponents.data ?? []).map((component) => [String(component.payment_field_id), component.id]));
  for (const component of components) {
    const existingId = existingByField.get(String(component.payment_field_id));
    const payload = { ...component, payment_method_id: id, updated_at: new Date().toISOString() };
    const result = existingId
      ? await admin.from("payment_method_components").update(payload).eq("id", existingId).eq("company_id", companyId)
      : await admin.from("payment_method_components").insert(payload);
    if (result.error) throw new Error(result.error.message);
  }
  const selectedIds = new Set(components.map((component) => String(component.payment_field_id)));
  const removedIds = (existingComponents.data ?? [])
    .filter((component) => !selectedIds.has(String(component.payment_field_id)))
    .map((component) => component.id);
  if (removedIds.length) {
    const removed = await admin.from("payment_method_components").delete().in("id", removedIds).eq("company_id", companyId);
    if (removed.error) throw new Error(removed.error.message);
  }

  revalidatePath("/master/payment-methods");
  revalidatePath("/provider-mapping");
  redirect("/master/payment-methods");
}

function parsePaymentField(formData: FormData) {
  const code = required(formData.get("field_code"), "Field ID").toUpperCase();
  const label = required(formData.get("field_label"), "Field label");
  const fieldType = required(formData.get("field_type"), "Field type");
  const paySchedule = clean(formData.get("pay_schedule"));
  const calculationType: PaymentCalculationType = fieldType === "production" ? "count_x_rate" : "manual_input";
  const amazonSource = clean(formData.get("amazon_calculation_source"));
  const flipkartSource = clean(formData.get("flipkart_calculation_source"));
  const internalSource = clean(formData.get("internal_calculation_source"));
  if (!["amount", "production"].includes(fieldType)) throw new Error("Field type must be Amount or Production.");
  if (fieldType === "amount" && !["per_hour", "per_day", "per_month"].includes(paySchedule ?? "")) {
    throw new Error("Amount fields need a pay schedule.");
  }
  if (amazonSource && !AMAZON_PAYMENT_CALCULATION_SOURCES.some((option) => option.value === amazonSource)) throw new Error("Select a valid Amazon production count.");
  if (flipkartSource) throw new Error("Flipkart production sources have not been configured yet.");
  if (internalSource && !INTERNAL_PAYMENT_CALCULATION_SOURCES.some((option) => option.value === internalSource)) throw new Error("Select a valid internal calculation source.");
  if (fieldType === "production" && !amazonSource && !flipkartSource && !internalSource) throw new Error("Select at least one provider or internal calculation source.");
  return {
    code,
    label,
    field_type: fieldType,
    pay_schedule: fieldType === "amount" ? paySchedule : null,
    calculation_type: calculationType,
    calculation_source: fieldType === "production" ? amazonSource : null,
    provider_calculation_sources: fieldType === "production" ? {
      amazon: amazonSource,
      flipkart: flipkartSource,
      internal: internalSource
    } : {}
  };
}

export async function createPaymentField(formData: FormData) {
  const authorization = await requirePagePermission("payment_methods", "add");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");
  const payload = parsePaymentField(formData);
  const result = await supabaseAdmin.from("payment_fields").insert(withCompany({ ...payload, is_active: true }, companyId));
  if (result.error) throw new Error(result.error.message);
  revalidatePath("/master/payment-methods");
  redirect("/master/payment-methods?fields=1");
}

export async function updatePaymentField(formData: FormData) {
  const authorization = await requirePagePermission("payment_methods", "edit");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");
  const id = required(formData.get("field_id"), "Payment field");
  const payload = parsePaymentField(formData);
  const update = await supabaseAdmin.from("payment_fields").update({ ...payload, updated_at: new Date().toISOString() })
    .eq("id", id).eq("company_id", companyId);
  if (update.error) throw new Error(update.error.message);
  const sync = await supabaseAdmin.from("payment_method_components").update({
    component_code: payload.code,
    component_type: payload.field_type,
    label: payload.label,
    pay_schedule: payload.pay_schedule,
    updated_at: new Date().toISOString()
  }).eq("payment_field_id", id).eq("company_id", companyId);
  if (sync.error) throw new Error(sync.error.message);
  revalidatePath("/master/payment-methods");
  revalidatePath("/provider-mapping");
  redirect("/master/payment-methods?fields=1");
}

export async function deletePaymentField(formData: FormData) {
  const authorization = await requirePagePermission("payment_methods", "edit");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");
  const id = required(formData.get("field_id"), "Payment field");
  const usage = await supabaseAdmin.from("payment_method_components").select("id", { count: "exact", head: true })
    .eq("payment_field_id", id).eq("company_id", companyId);
  if (usage.error) throw new Error(usage.error.message);
  if ((usage.count ?? 0) > 0) throw new Error("This payment field is assigned to a payment method and cannot be deleted.");
  const result = await supabaseAdmin.from("payment_fields").delete().eq("id", id).eq("company_id", companyId);
  if (result.error) throw new Error(result.error.message);
  revalidatePath("/master/payment-methods");
  redirect("/master/payment-methods?fields=1");
}

export async function deletePaymentMethod(formData: FormData) {
  const authorization = await requirePagePermission("payment_methods", "edit");
  const companyId = requireCompanyId(authorization);
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");
    const id = required(formData.get("id"), "Payment method");

    const usage = await supabaseAdmin
      .from("field_executive_provider_mappings")
      .select("id", { count: "exact", head: true })
      .eq("payment_method_id", id)
      .eq("company_id", companyId);
    if (usage.error) throw new Error(usage.error.message);
    if ((usage.count ?? 0) > 0) {
      throw new Error(`This payment method is used in ${usage.count} mapping${usage.count === 1 ? "" : "s"} and cannot be deleted.`);
    }

    const { error } = await supabaseAdmin.from("payment_methods").delete().eq("id", id).eq("company_id", companyId);
    if (error) throw new Error(error.message);
    revalidatePath("/master/payment-methods");
  } catch (error) {
    paymentMethodRedirect({ error: error instanceof Error ? error.message : "Unable to delete payment method." });
  }

  paymentMethodRedirect({ notice: "Payment method deleted." });
}
