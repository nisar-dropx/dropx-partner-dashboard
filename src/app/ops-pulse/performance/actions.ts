"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePagePermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { resolvePerformanceReviewChain } from "@/lib/ops-pulse/performance-review";
import { supabaseAdmin } from "@/lib/supabase-admin";

function text(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function dateValue(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

function reviewHref(date: string, stationCode: string, notice?: string, error?: string) {
  const params = new URLSearchParams({ view: "reviews", date, review: stationCode });
  if (notice) params.set("notice", notice);
  if (error) params.set("error", error);
  return `/ops-pulse/performance?${params.toString()}`;
}

function canUseStation(authorization: AuthorizationContext, stationId: string) {
  return authorization.hasAllLocationAccess || authorization.locationScopeIds.includes(stationId);
}

async function stationForAction(companyId: string, authorization: AuthorizationContext, stationCode: string) {
  if (!supabaseAdmin) throw new Error("Database service is unavailable.");
  const result = await supabaseAdmin.from("stations").select("id,station_code")
    .eq("company_id", companyId).eq("station_code", stationCode).eq("is_active", true).maybeSingle();
  if (result.error || !result.data || !canUseStation(authorization, result.data.id)) throw new Error("This station is outside your location access.");
  return result.data;
}

export async function startPerformanceReview(formData: FormData) {
  const authorization = await requirePagePermission("performance", "edit");
  const companyId = requireCompanyId(authorization);
  const sourceDate = dateValue(text(formData, "source_date"));
  const stationCode = text(formData, "station_code").toUpperCase();
  if (!supabaseAdmin || !sourceDate || !stationCode) redirect(reviewHref(sourceDate, stationCode, undefined, "Select a valid date and station."));
  try {
    const station = await stationForAction(companyId, authorization, stationCode);
    const existing = await supabaseAdmin.from("ops_performance_reviews").select("id")
      .eq("company_id", companyId).eq("review_type", "daily_operations").eq("source_date", sourceDate).eq("station_id", station.id).maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    let reviewId = existing.data?.id;
    if (!reviewId) {
      const created = await supabaseAdmin.from("ops_performance_reviews").insert({
        company_id: companyId,
        current_step_order: 1,
        report_week: Number(text(formData, "report_week")) || null,
        report_year: Number(sourceDate.slice(0, 4)),
        review_type: "daily_operations",
        source_batch_id: text(formData, "source_batch_id") || null,
        source_date: sourceDate,
        source_type: text(formData, "source_type") || "operational_data",
        started_by: authorization.userId,
        station_code: stationCode,
        station_id: station.id,
        status: "in_review",
        updated_by: authorization.userId
      }).select("id").single();
      if (created.error) throw new Error(created.error.message);
      reviewId = created.data.id;
      const chain = await resolvePerformanceReviewChain(companyId, station.id, authorization);
      const stepRows = chain.map((step, index) => ({
        company_id: companyId,
        review_id: reviewId,
        reviewer_name: step.reviewerName,
        reviewer_role: step.reviewerRole,
        reviewer_user_id: step.reviewerUserId,
        status: "pending",
        step_order: index + 1
      }));
      if (stepRows.length) {
        const steps = await supabaseAdmin.from("ops_performance_review_steps").insert(stepRows);
        if (steps.error) throw new Error(steps.error.message);
      }
    }
    revalidatePath("/ops-pulse/performance");
    redirect(reviewHref(sourceDate, stationCode, "Review started."));
  } catch (error) {
    redirect(reviewHref(sourceDate, stationCode, undefined, error instanceof Error ? error.message : "Unable to start review."));
  }
}

export async function savePerformanceReviewOperations(formData: FormData) {
  const authorization = await requirePagePermission("performance", "edit");
  const companyId = requireCompanyId(authorization);
  const reviewId = text(formData, "review_id");
  const sourceDate = dateValue(text(formData, "source_date"));
  const stationCode = text(formData, "station_code").toUpperCase();
  if (!supabaseAdmin || !reviewId) redirect(reviewHref(sourceDate, stationCode, undefined, "Start the review first."));
  const result = await supabaseAdmin.from("ops_performance_reviews").update({
    review_summary: text(formData, "review_summary") || null,
    station_clear_time: text(formData, "station_clear_time") || null,
    unloading_complete_time: text(formData, "unloading_complete_time") || null,
    updated_at: new Date().toISOString(),
    updated_by: authorization.userId,
    vehicle_arrival_time: text(formData, "vehicle_arrival_time") || null
  }).eq("id", reviewId).eq("company_id", companyId);
  revalidatePath("/ops-pulse/performance");
  redirect(reviewHref(sourceDate, stationCode, result.error ? undefined : "Review details saved.", result.error?.message));
}

export async function savePerformanceReviewItem(formData: FormData) {
  const authorization = await requirePagePermission("performance", "edit");
  const companyId = requireCompanyId(authorization);
  const reviewId = text(formData, "review_id");
  const sourceDate = dateValue(text(formData, "source_date"));
  const stationCode = text(formData, "station_code").toUpperCase();
  if (!supabaseAdmin || !reviewId) redirect(reviewHref(sourceDate, stationCode, undefined, "Start the review first."));
  const actual = text(formData, "actual_value");
  const target = text(formData, "target_value");
  const status = ["open", "in_progress", "blocked", "done"].includes(text(formData, "status")) ? text(formData, "status") : "open";
  const payload = {
    action_owner: text(formData, "action_owner") || null,
    actual_value: actual && Number.isFinite(Number(actual)) ? Number(actual) : null,
    company_id: companyId,
    corrective_action: text(formData, "corrective_action") || null,
    due_date: dateValue(text(formData, "due_date")) || null,
    metric_key: text(formData, "metric_key"),
    metric_label: text(formData, "metric_label"),
    review_id: reviewId,
    root_cause: text(formData, "root_cause") || null,
    severity: text(formData, "severity") === "amber" ? "amber" : "red",
    status,
    target_direction: text(formData, "target_direction") === "lower" ? "lower" : "higher",
    target_value: target && Number.isFinite(Number(target)) ? Number(target) : null,
    updated_at: new Date().toISOString(),
    updated_by: authorization.userId
  };
  const saved = await supabaseAdmin.from("ops_performance_review_items").upsert(payload, { onConflict: "review_id,metric_key" }).select("id").single();
  if (!saved.error) {
    const note = [payload.root_cause && `RCA: ${payload.root_cause}`, payload.corrective_action && `Action: ${payload.corrective_action}`].filter(Boolean).join(" · ") || `Action status changed to ${status}.`;
    await supabaseAdmin.from("ops_performance_review_updates").insert({ company_id: companyId, created_by: authorization.userId, note, review_id: reviewId, review_item_id: saved.data.id, update_type: status === "done" ? "closure" : "action" });
  }
  revalidatePath("/ops-pulse/performance");
  redirect(reviewHref(sourceDate, stationCode, saved.error ? undefined : "RCA and action saved.", saved.error?.message));
}

export async function completePerformanceReviewStep(formData: FormData) {
  const authorization = await requirePagePermission("performance", "edit");
  const companyId = requireCompanyId(authorization);
  const reviewId = text(formData, "review_id");
  const sourceDate = dateValue(text(formData, "source_date"));
  const stationCode = text(formData, "station_code").toUpperCase();
  if (!supabaseAdmin || !reviewId) redirect(reviewHref(sourceDate, stationCode, undefined, "Review is unavailable."));
  const reviewResult = await supabaseAdmin.from("ops_performance_reviews").select("current_step_order")
    .eq("id", reviewId).eq("company_id", companyId).maybeSingle();
  const stepResult = reviewResult.data ? await supabaseAdmin.from("ops_performance_review_steps").select("id,reviewer_user_id")
    .eq("review_id", reviewId).eq("step_order", reviewResult.data.current_step_order).maybeSingle() : { data: null, error: null };
  const canOverride = authorization.isMasterOwner || /owner|managing partner/i.test(`${authorization.roleCode ?? ""} ${authorization.roleName ?? ""}`);
  if (stepResult.data?.reviewer_user_id && stepResult.data.reviewer_user_id !== authorization.userId && !canOverride) {
    redirect(reviewHref(sourceDate, stationCode, undefined, "This review step is assigned to another reviewer."));
  }
  const now = new Date().toISOString();
  if (stepResult.data) {
    const completed = await supabaseAdmin.from("ops_performance_review_steps").update({ completed_at: now, completed_by: authorization.userId, feedback: text(formData, "feedback") || null, status: "completed", updated_at: now }).eq("id", stepResult.data.id).eq("company_id", companyId);
    if (completed.error) redirect(reviewHref(sourceDate, stationCode, undefined, completed.error.message));
  }
  const next = await supabaseAdmin.from("ops_performance_review_steps").select("step_order").eq("review_id", reviewId).eq("status", "pending").order("step_order").limit(1).maybeSingle();
  const closed = !next.data;
  const updated = await supabaseAdmin.from("ops_performance_reviews").update({
    closed_at: closed ? now : null,
    closed_by: closed ? authorization.userId : null,
    current_step_order: next.data?.step_order ?? reviewResult.data?.current_step_order ?? 1,
    status: closed ? "closed" : "in_review",
    updated_at: now,
    updated_by: authorization.userId
  }).eq("id", reviewId).eq("company_id", companyId);
  revalidatePath("/ops-pulse/performance");
  redirect(reviewHref(sourceDate, stationCode, updated.error ? undefined : closed ? "Review completed." : "Review moved to the next level.", updated.error?.message));
}
