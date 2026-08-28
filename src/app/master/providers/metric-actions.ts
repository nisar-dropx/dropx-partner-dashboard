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

export async function saveProviderProductionMetric(formData: FormData) {
  const authorization = await requirePagePermission("master_providers", "edit");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const id = String(formData.get("id") ?? "").trim();
  const providerId = required(formData.get("provider_id"), "Provider");
  const payload = withCompany({
    provider_id: providerId,
    code: required(formData.get("code"), "Count ID").toUpperCase().replace(/[^A-Z0-9_]+/g, "_"),
    name: required(formData.get("name"), "Display name"),
    source_key: required(formData.get("source_key"), "Imported data key").toLowerCase().replace(/[^a-z0-9_]+/g, "_"),
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
