"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId, withCompany } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

function required(value: FormDataEntryValue | null, label: string) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function optional(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text || null;
}

function normalizedKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
}

export async function saveProviderProductionMetric(formData: FormData) {
  const authorization = await requirePagePermission("master_providers", "edit");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const id = String(formData.get("id") ?? "").trim();
  const providerId = required(formData.get("provider_id"), "Provider");
  const providerModelId = optional(formData.get("provider_model_id"));
  const operation = required(formData.get("calculation_operation"), "Calculation");
  if (!["direct", "sum"].includes(operation)) throw new Error("Select a valid count calculation.");
  const sourceKeys = required(formData.get("source_keys"), "Imported data key")
    .split(",")
    .map((value) => normalizedKey(value.trim()))
    .filter(Boolean);
  if (!sourceKeys.length) throw new Error("Add at least one imported data key.");
  if (operation === "direct" && sourceKeys.length !== 1) throw new Error("Direct counts must use exactly one imported data key.");

  const provider = await supabaseAdmin.from("providers").select("id").eq("id", providerId).eq("company_id", companyId).single();
  if (provider.error) throw new Error("Provider is not available for this company.");
  if (providerModelId) {
    const model = await supabaseAdmin.from("location_models").select("id").eq("id", providerModelId).eq("provider_id", providerId).eq("company_id", companyId).single();
    if (model.error) throw new Error("The selected model does not belong to this provider.");
  }
  const payload = withCompany({
    provider_id: providerId,
    provider_model_id: providerModelId,
    code: required(formData.get("code"), "Count ID").toUpperCase().replace(/[^A-Z0-9_]+/g, "_"),
    name: required(formData.get("name"), "Display name"),
    source_key: sourceKeys[0],
    source_keys: sourceKeys,
    calculation_operation: operation,
    sort_order: Number(formData.get("sort_order") ?? 0) || 0,
    is_active: formData.get("is_active") !== "inactive",
    updated_at: new Date().toISOString()
  }, companyId);
  const result = id
    ? await supabaseAdmin.from("provider_production_metrics").update(payload).eq("id", id).eq("company_id", companyId)
    : await supabaseAdmin.from("provider_production_metrics").insert(payload);
  if (result.error) throw new Error(result.error.message);
  revalidatePath("/master/providers");
  revalidatePath("/master/payment-methods");
  redirect("/master/providers?counts=1");
}

export async function deleteProviderProductionMetric(formData: FormData) {
  const authorization = await requirePagePermission("master_providers", "edit");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const id = required(formData.get("id"), "Production count");
  const usage = await supabaseAdmin.from("payment_field_provider_metrics").select("id", { count: "exact", head: true })
    .eq("company_id", companyId).eq("provider_metric_id", id);
  if (usage.error) throw new Error(usage.error.message);
  if ((usage.count ?? 0) > 0) throw new Error("Remove this count from Payment Fields before deleting it.");
  const result = await supabaseAdmin.from("provider_production_metrics").delete().eq("id", id).eq("company_id", companyId);
  if (result.error) throw new Error(result.error.message);
  revalidatePath("/master/providers");
  redirect("/master/providers?counts=1");
}
