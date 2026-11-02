"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { conversionRateTiers } from "@/lib/conversion-rate-rules";
import { todayKolkata } from "@/lib/ops-pulse/cod";

const path = "/master/payment-methods/rate-rules";
const text = (value: FormDataEntryValue | null) => String(value ?? "").trim();
function date(value: FormDataEntryValue | null) {
  const result = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || new Date(`${result}T00:00:00Z`).toISOString().slice(0, 10) !== result) throw new Error("Enter valid effective dates.");
  return result;
}

export async function createConversionRateRule(formData: FormData) {
  const authorization = await requirePagePermission("payment_methods", "add");
  const companyId = requireCompanyId(authorization);
  let errorMessage: string | null = null;
  try {
    if (!supabaseAdmin) throw new Error("Database connection is unavailable.");
    const stationId = text(formData.get("station_id"));
    if (!authorization.hasAllLocationAccess && !authorization.locationScopeIds.includes(stationId)) throw new Error("You do not have access to this location.");
    const station = await supabaseAdmin.from("stations").select("id,provider_id,location_model_id")
      .eq("company_id", companyId).eq("id", stationId).single();
    if (station.error || !station.data?.provider_id || !station.data?.location_model_id) throw new Error("Choose a location with a provider and operating model.");
    if (String(station.data.location_model_id) !== text(formData.get("location_model_id"))) throw new Error("The selected location does not belong to this model.");
    const minimums = formData.getAll("minimum");
    const rates = formData.getAll("rate");
    const tiers = conversionRateTiers(minimums.flatMap((minimum, index) => {
      const left = text(minimum), right = text(rates[index] ?? null);
      if (!left && !right) return [];
      if (!left || !right) throw new Error("Complete both values for every slab.");
      return [{ minimum: Number(left), rate: Number(right) }];
    }));
    const effectiveFrom = date(formData.get("effective_from"));
    const effectiveTo = date(formData.get("effective_to"));
    if (effectiveFrom <= todayKolkata()) throw new Error("Choose a start date after today so existing payments stay unchanged.");
    if (effectiveTo < effectiveFrom) throw new Error("End date cannot precede start date.");
    const result = await supabaseAdmin.from("payment_conversion_rate_rules").insert({
      company_id: companyId, name: text(formData.get("name")),
      payment_method_id: text(formData.get("payment_method_id")), payment_field_id: text(formData.get("payment_field_id")),
      provider_id: station.data.provider_id, location_model_id: station.data.location_model_id, station_id: stationId,
      numerator_source: text(formData.get("numerator_source")), denominator_source: text(formData.get("denominator_source")),
      effective_from: effectiveFrom, effective_to: effectiveTo, tiers
    });
    if (result.error) throw new Error(result.error.message);
  } catch (error) { errorMessage = error instanceof Error ? error.message : "Unable to save the conversion rule."; }
  if (errorMessage) redirect(`${path}?error=${encodeURIComponent(errorMessage)}`);
  revalidatePath(path);
  revalidatePath("/payments/workforce-payouts");
  redirect(`${path}?saved=1`);
}
