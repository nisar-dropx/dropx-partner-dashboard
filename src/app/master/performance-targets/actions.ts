"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { createPerformanceTarget, deletePerformanceTarget, performanceTargetSeeds, savePerformanceTarget } from "@/lib/ops-pulse/performance-targets";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function updatePerformanceTarget(formData: FormData) {
  const authorization = await requirePagePermission("performance_master", "edit");
  const companyId = requireCompanyId(authorization);
  const id = String(formData.get("id") ?? "");
  const reportType = formData.get("report_type") === "sls" ? "sls" : "daily";
  const targetText = String(formData.get("target") ?? "").trim();
  const error = await savePerformanceTarget(companyId, id, {
    id,
    metricKey: String(formData.get("metric_key") ?? ""),
    label: String(formData.get("label") ?? "").trim(),
    short: String(formData.get("short") ?? "").trim(),
    reportType,
    sourceIndex: String(formData.get("source_index") ?? "").trim() ? Number(formData.get("source_index")) : null,
    target: targetText ? Number(targetText) : null,
    direction: formData.get("direction") === "lower" ? "lower" : "higher",
    weight: Number(formData.get("weight") ?? 0),
    unit: ["dpmo", "ratio"].includes(String(formData.get("unit"))) ? formData.get("unit") as "dpmo" | "ratio" : "percent",
    displayOrder: Number(formData.get("display_order") ?? 0),
    isActive: formData.get("is_active") === "true"
  });
  revalidatePath("/master/performance-targets");
  revalidatePath("/ops-pulse/performance");
  redirect(`/master/performance-targets?view=${reportType}&${error ? `error=${encodeURIComponent(error)}` : "saved=1"}`);
}

export async function addPerformanceMetric(formData: FormData) {
  const authorization = await requirePagePermission("performance_master", "add");
  const companyId = requireCompanyId(authorization);
  const reportType = formData.get("report_type") === "sls" ? "sls" : "daily";
  const sourceIndex = Number(formData.get("source_index"));
  const catalog = performanceTargetSeeds.find((row) => row.reportType === reportType && row.sourceIndex === sourceIndex);
  const metricKey = catalog?.metricKey ?? `source_field_${sourceIndex}`;
  const error = await createPerformanceTarget(companyId, {
    metricKey,
    label: catalog?.label ?? `Source field ${sourceIndex}`,
    short: catalog?.short ?? `Field ${sourceIndex}`,
    reportType,
    sourceIndex,
    target: catalog?.target ?? null,
    direction: catalog?.direction ?? "higher",
    weight: catalog?.weight ?? 0,
    unit: catalog?.unit ?? "percent",
    displayOrder: Number(formData.get("display_order") ?? 999),
    isActive: true
  });
  revalidatePath("/master/performance-targets");
  revalidatePath("/ops-pulse/performance");
  redirect(`/master/performance-targets?view=${reportType}&${error ? `error=${encodeURIComponent(error)}` : "added=1"}`);
}

export async function removePerformanceMetric(formData: FormData) {
  const authorization = await requirePagePermission("performance_master", "edit");
  const companyId = requireCompanyId(authorization);
  const reportType = formData.get("report_type") === "sls" ? "sls" : "daily";
  const error = await deletePerformanceTarget(companyId, String(formData.get("id") ?? ""));
  revalidatePath("/master/performance-targets");
  revalidatePath("/ops-pulse/performance");
  redirect(`/master/performance-targets?view=${reportType}&${error ? `error=${encodeURIComponent(error)}` : "deleted=1"}`);
}

export async function updatePerformanceReviewCadence(formData: FormData) {
  const authorization = await requirePagePermission("performance_master", "edit");
  const companyId = requireCompanyId(authorization);
  const weekday = Math.max(0, Math.min(6, Number(formData.get("weekly_review_weekday") ?? 4)));
  const staleHours = Math.max(1, Math.min(168, Number(formData.get("stale_after_hours") ?? 24)));
  const result = supabaseAdmin ? await supabaseAdmin.from("ops_performance_review_settings").upsert({
    company_id: companyId,
    daily_review_time: String(formData.get("daily_review_time") ?? "10:00"),
    stale_after_hours: staleHours,
    updated_at: new Date().toISOString(),
    updated_by: authorization.userId,
    weekly_review_time: String(formData.get("weekly_review_time") ?? "16:00"),
    weekly_review_weekday: weekday
  }, { onConflict: "company_id" }) : { error: { message: "Database service is unavailable." } };
  revalidatePath("/master/performance-targets");
  revalidatePath("/ops-pulse/performance");
  redirect(`/master/performance-targets?view=reviews&${result.error ? `error=${encodeURIComponent(result.error.message)}` : "saved=1"}`);
}
