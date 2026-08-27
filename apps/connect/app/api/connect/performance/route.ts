import { NextResponse } from "next/server";
import { requireConnectAccount, type ConnectAccount } from "../../../../src/lib/connect-auth";
import { supabaseAdmin } from "../../../../src/lib/supabase-admin";

type WorkerType = "employee" | "contractor";

function db() {
  if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
  return supabaseAdmin;
}

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function rating(value: unknown) {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || result > 10) throw new Error("Choose a valid rating.");
  return result;
}

async function ownPerformanceContext(url: URL, body?: Record<string, unknown>) {
  const accountId = clean(body?.accountId ?? url.searchParams.get("accountId"));
  const profileType = clean(body?.profileType ?? url.searchParams.get("profileType"));
  if (!accountId || !["employee", "contractor"].includes(profileType)) {
    throw new Error("Performance reviews are available for People employees and independent contractors.");
  }
  const account = await requireConnectAccount(profileType as ConnectAccount["profileType"], accountId);
  const workerType = profileType as WorkerType;
  const workerColumn = workerType === "employee" ? "employee_id" : "contractor_id";
  const engagement = await db().from("hr_engagements")
    .select("id,person_id")
    .eq("company_id", account.companyId)
    .eq("worker_type", workerType)
    .eq(workerColumn, account.id)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (engagement.error) throw new Error(engagement.error.message);
  return { account, workerType, engagement: engagement.data };
}

async function ownReview(companyId: string, personId: string, reviewId: string) {
  const result = await db().from("hr_performance_reviews")
    .select("*")
    .eq("company_id", companyId)
    .eq("person_id", personId)
    .eq("id", reviewId)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) throw new Error("This performance review is not available for your profile.");
  return result.data;
}

async function recordEvent(input: {
  companyId: string;
  reviewId: string;
  eventType: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  account: ConnectAccount;
}) {
  const result = await db().from("hr_performance_events").insert({
    company_id: input.companyId,
    review_id: input.reviewId,
    event_type: input.eventType,
    from_status: input.fromStatus ?? null,
    to_status: input.toStatus ?? null,
    details: {
      source: "dropx_one",
      profile_type: input.account.profileType,
      account_id: input.account.id
    }
  });
  if (result.error) throw new Error(result.error.message);
}

export async function GET(request: Request) {
  try {
    const context = await ownPerformanceContext(new URL(request.url));
    if (!context.engagement) return NextResponse.json({ configured: false, cycles: [], reviews: [], goals: [], changes: [] });
    const reviewsResult = await db().from("hr_performance_reviews")
      .select("id,cycle_id,worker_name,worker_code,designation_name,department_name,status,self_rating,manager_rating,final_rating,self_comments,manager_comments,calibration_comments,self_submitted_at,manager_submitted_at,acknowledged_at,updated_at")
      .eq("company_id", context.account.companyId)
      .eq("person_id", context.engagement.person_id)
      .order("created_at", { ascending: false });
    if (reviewsResult.error) throw new Error(reviewsResult.error.message);
    const reviews = reviewsResult.data ?? [];
    const cycleIds = [...new Set(reviews.map((item) => item.cycle_id))];
    const reviewIds = reviews.map((item) => item.id);
    const [cycles, goals, changes] = await Promise.all([
      cycleIds.length
        ? db().from("hr_performance_cycles").select("id,code,name,period_start,period_end,self_review_due,manager_review_due,status,rating_scale").eq("company_id", context.account.companyId).in("id", cycleIds)
        : Promise.resolve({ data: [], error: null }),
      reviewIds.length
        ? db().from("hr_performance_goals").select("id,review_id,title,description,metric,target_value,actual_value,weight,progress,manager_score,manager_comments,status").eq("company_id", context.account.companyId).in("review_id", reviewIds).order("sort_order")
        : Promise.resolve({ data: [], error: null }),
      db().from("hr_compensation_changes").select("id,review_id,change_type,previous_pay,proposed_pay,pay_basis,effective_from,reason,status,rejection_reason,approved_at,applied_at").eq("company_id", context.account.companyId).eq("person_id", context.engagement.person_id).order("effective_from", { ascending: false })
    ]);
    const error = cycles.error ?? goals.error ?? changes.error;
    if (error) throw new Error(error.message);
    return NextResponse.json({
      configured: true,
      cycles: cycles.data ?? [],
      reviews,
      goals: goals.data ?? [],
      changes: changes.data ?? []
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load performance reviews." }, { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const context = await ownPerformanceContext(new URL(request.url), body);
    if (!context.engagement) throw new Error("Your People profile is not configured for performance reviews.");
    const action = clean(body.action);
    const reviewId = clean(body.reviewId);
    const review = await ownReview(context.account.companyId, context.engagement.person_id, reviewId);

    if (action === "self_review") {
      if (review.status !== "assigned") throw new Error("This self-review has already been submitted.");
      const cycle = await db().from("hr_performance_cycles").select("rating_scale,status").eq("company_id", context.account.companyId).eq("id", review.cycle_id).maybeSingle();
      if (cycle.error || !cycle.data) throw new Error(cycle.error?.message ?? "Performance cycle is unavailable.");
      if (!["open", "manager_review"].includes(cycle.data.status)) throw new Error("Self-review is not open for this cycle.");
      const selfRating = rating(body.selfRating);
      if (selfRating > Number(cycle.data.rating_scale)) throw new Error(`Rating cannot exceed ${cycle.data.rating_scale}.`);
      const comments = clean(body.comments);
      if (comments.length < 10) throw new Error("Add a short summary of your contribution and development needs.");
      const updated = await db().from("hr_performance_reviews").update({
        self_rating: selfRating,
        self_comments: comments.slice(0, 4000),
        self_submitted_at: new Date().toISOString(),
        status: "self_submitted",
        updated_by: null
      }).eq("company_id", context.account.companyId).eq("id", review.id).eq("status", "assigned").select("id").maybeSingle();
      if (updated.error) throw new Error(updated.error.message);
      if (!updated.data) throw new Error("This review changed while you were submitting. Refresh and try again.");
      await recordEvent({ companyId: context.account.companyId, reviewId: review.id, eventType: "self_review_submitted", fromStatus: review.status, toStatus: "self_submitted", account: context.account });
      return NextResponse.json({ ok: true, notice: "Self-review submitted to your reporting manager." });
    }

    if (action === "acknowledge") {
      if (review.status !== "finalised") throw new Error("The final outcome is not ready for acknowledgement.");
      const updated = await db().from("hr_performance_reviews").update({
        status: "acknowledged",
        acknowledged_at: new Date().toISOString(),
        acknowledged_by: null,
        updated_by: null
      }).eq("company_id", context.account.companyId).eq("id", review.id).eq("status", "finalised").select("id").maybeSingle();
      if (updated.error) throw new Error(updated.error.message);
      if (!updated.data) throw new Error("This outcome changed while you were acknowledging it. Refresh and try again.");
      await recordEvent({ companyId: context.account.companyId, reviewId: review.id, eventType: "outcome_acknowledged", fromStatus: review.status, toStatus: "acknowledged", account: context.account });
      return NextResponse.json({ ok: true, notice: "Performance outcome acknowledged." });
    }

    if (action === "goal_progress") {
      if (["finalised", "acknowledged", "closed"].includes(review.status)) throw new Error("Goals are locked after the performance outcome is finalised.");
      const goalId = clean(body.goalId);
      const progress = Math.round(Number(body.progress));
      const status = clean(body.status);
      if (!Number.isFinite(progress) || progress < 0 || progress > 100) throw new Error("Goal progress must be between 0 and 100.");
      if (!["not_started", "on_track", "at_risk", "blocked", "completed"].includes(status)) throw new Error("Choose a valid goal status.");
      const goal = await db().from("hr_performance_goals").update({
        progress,
        status,
        actual_value: clean(body.actualValue).slice(0, 500) || null,
        updated_by: null
      }).eq("company_id", context.account.companyId).eq("review_id", review.id).eq("id", goalId).select("id").maybeSingle();
      if (goal.error) throw new Error(goal.error.message);
      if (!goal.data) throw new Error("Goal was not found for this review.");
      await recordEvent({ companyId: context.account.companyId, reviewId: review.id, eventType: "goal_progress_updated", fromStatus: review.status, toStatus: review.status, account: context.account });
      return NextResponse.json({ ok: true, notice: "Goal progress updated." });
    }

    throw new Error("Choose a valid performance action.");
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update the performance review." }, { status: 400 });
  }
}
