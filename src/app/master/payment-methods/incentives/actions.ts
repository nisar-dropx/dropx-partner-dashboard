"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

const path = "/master/payment-methods/incentives";
function text(value: FormDataEntryValue | null) { return String(value ?? "").trim(); }
function optional(value: FormDataEntryValue | null) { return text(value) || null; }
function result(error?: string) {
  revalidatePath(path);
  revalidatePath("/payments/workforce-payouts");
  revalidatePath("/connect/workforce-payments");
  redirect(`${path}?${error ? `error=${encodeURIComponent(error)}` : "saved=1"}`);
}
function nonNegative(value: FormDataEntryValue | null, label: string, optionalValue = false) {
  const raw = text(value);
  if (!raw && optionalValue) return null;
  const parsed = Number(raw || 0);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative number.`);
  return parsed;
}
function isoDate(value: FormDataEntryValue | null, label: string) {
  const date = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error(`${label} is invalid.`);
  return date;
}
function wholeNumber(value: FormDataEntryValue | null, label: string, minimum = 0) {
  const parsed = Number(nonNegative(value, label));
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${label} must be a whole number${minimum ? ` of at least ${minimum}` : ""}.`);
  return parsed;
}
function reportingTime(value: FormDataEntryValue | null) {
  const time = text(value);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("Choose a valid punch-in cutoff time.");
  return time;
}
function tierRows(formData: FormData) {
  const minimums = formData.getAll("tier_minimum");
  const amounts = formData.getAll("tier_amount");
  const rows = minimums.flatMap((minimum, index) => {
    const left = text(minimum), right = text(amounts[index] ?? null);
    if (!left && !right) return [];
    if (!left || !right) throw new Error("Complete both the minimum and amount for every incentive slab.");
    return [{ minimum: nonNegative(minimum, "Tier minimum"), amount: nonNegative(amounts[index] ?? null, "Tier amount") }];
  }).sort((left, right) => Number(left.minimum) - Number(right.minimum));
  if (rows.some((row, index) => Number(row.amount) <= 0 || (index > 0 && Number(row.minimum) <= Number(rows[index - 1].minimum)))) {
    throw new Error("Slab minimums must be unique and ascending, and every amount must be greater than zero.");
  }
  return rows;
}

export async function createIncentivePlan(formData: FormData) {
  const authorization = await requirePagePermission("payment_methods", "add");
  const companyId = requireCompanyId(authorization);
  try {
    if (!supabaseAdmin) throw new Error("Database connection is unavailable.");
    const code = text(formData.get("code")).toUpperCase();
    const name = text(formData.get("name"));
    const providerId = text(formData.get("provider_id"));
    const modelId = optional(formData.get("location_model_id"));
    const stationId = optional(formData.get("station_id"));
    const designationId = text(formData.get("designation_id"));
    if (!code || !name || !providerId || !designationId) throw new Error("Plan ID, name, provider and designation are required.");
    const requestedType = text(formData.get("incentive_type"));
    const incentiveType = requestedType === "conversion" || requestedType === "attendance" ? requestedType : "performance";
    const status = ["active", "paused"].includes(text(formData.get("status"))) ? text(formData.get("status")) : "draft";
    const effectiveFrom = isoDate(formData.get("effective_from"), "Effective from");
    const effectiveTo = isoDate(formData.get("effective_to"), "Effective to");
    if (effectiveTo < effectiveFrom) throw new Error("Effective to cannot be before Effective from.");

    const [provider, designation, model, station] = await Promise.all([
      supabaseAdmin.from("providers").select("id").eq("company_id", companyId).eq("id", providerId).maybeSingle(),
      supabaseAdmin.from("designations").select("id").eq("company_id", companyId).eq("id", designationId).maybeSingle(),
      modelId ? supabaseAdmin.from("location_models").select("id,provider_id").eq("company_id", companyId).eq("id", modelId).maybeSingle() : Promise.resolve({ data: null, error: null }),
      stationId ? supabaseAdmin.from("stations").select("id,provider_id,location_model_id").eq("company_id", companyId).eq("id", stationId).maybeSingle() : Promise.resolve({ data: null, error: null })
    ]);
    if (provider.error || designation.error || model.error || station.error || !provider.data || !designation.data) throw new Error("One or more selected scopes are unavailable.");
    if (model.data && String(model.data.provider_id) !== providerId) throw new Error("The selected model does not belong to the provider.");
    if (station.data && (String(station.data.provider_id) !== providerId || (modelId && String(station.data.location_model_id) !== modelId))) throw new Error("The selected station does not belong to the provider/model scope.");

    const tiers = tierRows(formData);
    const payload: Record<string, unknown> = incentiveType === "conversion" ? {
      incentive_type: "conversion",
      cycle_type: "half_monthly",
      metric: "delivery_conversion",
      calculation_type: "tiered_flat",
      threshold_value: 0,
      rate_value: 0,
      flat_amount: 0,
      tiers,
      reporting_time: null,
      minimum_present_days: 0,
      allowed_late_days: 0
    } : incentiveType === "attendance" ? {
      incentive_type: "attendance",
      cycle_type: text(formData.get("cycle_type")) === "monthly" ? "monthly" : "half_monthly",
      metric: "attendance_compliance",
      calculation_type: "flat_threshold",
      threshold_value: 0,
      rate_value: 0,
      flat_amount: nonNegative(formData.get("flat_amount"), "Attendance bonus"),
      tiers: [],
      reporting_time: reportingTime(formData.get("reporting_time")),
      minimum_present_days: wholeNumber(formData.get("minimum_present_days"), "Minimum reporting days", 1),
      allowed_late_days: wholeNumber(formData.get("allowed_late_days"), "Allowed late days")
    } : {
      incentive_type: "performance",
      cycle_type: ["half_monthly", "monthly"].includes(text(formData.get("cycle_type"))) ? text(formData.get("cycle_type")) : "daily",
      metric: ["total_activity", "amazon_delivery", "swa_delivery", "c_return", "mfn"].includes(text(formData.get("metric"))) ? text(formData.get("metric")) : "total_delivery",
      calculation_type: formData.get("calculation_type") === "per_unit_above_threshold" ? "per_unit_above_threshold" : "flat_threshold",
      threshold_value: nonNegative(formData.get("threshold_value"), "Threshold"),
      rate_value: nonNegative(formData.get("rate_value"), "Rate"),
      flat_amount: nonNegative(formData.get("flat_amount"), "Flat amount"),
      tiers: [],
      reporting_time: null,
      minimum_present_days: 0,
      allowed_late_days: 0
    };
    if (payload.calculation_type === "tiered_flat" && !tiers.length) throw new Error("Add at least one conversion slab before saving the plan.");
    if (payload.calculation_type === "flat_threshold" && Number(payload.flat_amount) <= 0) throw new Error(incentiveType === "attendance" ? "Attendance bonus must be greater than zero." : "Flat performance plans need an amount greater than zero.");
    if (payload.calculation_type === "per_unit_above_threshold" && Number(payload.rate_value) <= 0) throw new Error("Per-unit performance plans need a rate greater than zero.");

    const existing = await supabaseAdmin.from("workforce_incentive_campaigns")
      .select("id,provider_id,location_model_id,station_id,designation_id,incentive_type,metric,effective_from,effective_to,status")
      .eq("company_id", companyId).neq("status", "closed").lte("effective_from", effectiveTo).gte("effective_to", effectiveFrom);
    if (existing.error) throw new Error(existing.error.message);
    const overlaps = (existing.data ?? []).some((plan) =>
      String(plan.provider_id ?? "") === providerId
      && String(plan.location_model_id ?? "") === String(modelId ?? "")
      && String(plan.station_id ?? "") === String(stationId ?? "")
      && String(plan.designation_id ?? "") === designationId
      && String(plan.incentive_type) === incentiveType
      && String(plan.metric) === payload.metric);
    if (overlaps) throw new Error("An overlapping plan already exists for the same provider, model, station, designation and metric.");

    const saved = await supabaseAdmin.from("workforce_incentive_campaigns").insert({
      company_id: companyId,
      code,
      name,
      provider_id: providerId,
      location_model_id: modelId,
      station_id: stationId,
      designation_id: designationId,
      ...payload,
      minimum_activity: incentiveType === "attendance" ? 0 : nonNegative(formData.get("minimum_activity"), "Minimum activity"),
      maximum_amount: nonNegative(formData.get("maximum_amount"), "Maximum amount", true),
      effective_from: effectiveFrom,
      effective_to: effectiveTo,
      status,
      description: optional(formData.get("description")),
      created_by: authorization.userId,
      approved_by: status === "active" ? authorization.userId : null,
      approved_at: status === "active" ? new Date().toISOString() : null
    });
    if (saved.error) throw new Error(saved.error.message);
  } catch (error) {
    result(error instanceof Error ? error.message : "Incentive plan could not be saved.");
  }
  result();
}

export async function updateIncentivePlanStatus(formData: FormData) {
  const authorization = await requirePagePermission("payment_methods", "edit");
  const companyId = requireCompanyId(authorization);
  try {
    if (!supabaseAdmin) throw new Error("Database connection is unavailable.");
    const id = text(formData.get("id"));
    const status = text(formData.get("status"));
    if (!id || !["draft", "active", "paused", "closed"].includes(status)) throw new Error("Choose a valid plan status.");
    if (status === "active") {
      const current = await supabaseAdmin.from("workforce_incentive_campaigns")
        .select("id,provider_id,location_model_id,station_id,designation_id,incentive_type,metric,effective_from,effective_to")
        .eq("company_id", companyId)
        .eq("id", id)
        .maybeSingle();
      if (current.error || !current.data) throw new Error(current.error?.message || "The incentive plan is unavailable.");
      const currentPlan = current.data;

      const overlapping = await supabaseAdmin.from("workforce_incentive_campaigns")
        .select("id,location_model_id,station_id")
        .eq("company_id", companyId)
        .neq("id", id)
        .neq("status", "closed")
        .eq("provider_id", currentPlan.provider_id)
        .eq("designation_id", currentPlan.designation_id)
        .eq("incentive_type", currentPlan.incentive_type)
        .eq("metric", currentPlan.metric)
        .lte("effective_from", currentPlan.effective_to)
        .gte("effective_to", currentPlan.effective_from);
      if (overlapping.error) throw new Error(overlapping.error.message);
      const exactScopeOverlap = (overlapping.data ?? []).some((plan) =>
        String(plan.location_model_id ?? "") === String(currentPlan.location_model_id ?? "")
        && String(plan.station_id ?? "") === String(currentPlan.station_id ?? ""));
      if (exactScopeOverlap) throw new Error("Another overlapping plan already exists for the same provider, model, station, designation and metric.");
    }
    const update: Record<string, unknown> = {
      status,
      updated_at: new Date().toISOString()
    };
    if (status === "active") {
      update.approved_by = authorization.userId;
      update.approved_at = new Date().toISOString();
    } else if (status === "draft") {
      update.approved_by = null;
      update.approved_at = null;
    }
    const updated = await supabaseAdmin.from("workforce_incentive_campaigns").update(update).eq("company_id", companyId).eq("id", id);
    if (updated.error) throw new Error(updated.error.message);
  } catch (error) {
    result(error instanceof Error ? error.message : "Plan status could not be updated.");
  }
  result();
}
