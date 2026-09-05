import { supabaseAdmin } from "@/lib/supabase-admin";
import type {
  ReviewStatusFollowup,
  ReviewStatusItem,
  ReviewStatusReview,
  ReviewStatusStep,
  ReviewStatusUpdate
} from "@/lib/ops-pulse/review-status";

async function loadReviews(companyId: string, stationCodes: string[], from: string, to: string) {
  const rows: ReviewStatusReview[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const result = await supabaseAdmin!.from("ops_performance_reviews")
      .select("id,source_date,station_id,station_code,source_type,status,current_step_order,review_summary,started_at,closed_at,updated_at")
      .eq("company_id", companyId).eq("review_type", "daily_operations").in("station_code", stationCodes)
      .gte("source_date", from).lte("source_date", to)
      .order("source_date", { ascending: false }).order("station_code").range(offset, offset + pageSize - 1);
    if (result.error) return { rows: [], error: result.error.message };
    rows.push(...((result.data ?? []) as ReviewStatusReview[]));
    if ((result.data ?? []).length < pageSize) break;
  }
  return { rows, error: null };
}

function chunks<T>(rows: T[], size = 200) {
  return Array.from({ length: Math.ceil(rows.length / size) }, (_, index) => rows.slice(index * size, (index + 1) * size));
}

export async function loadReviewStatusDataset(companyId: string, stationCodes: string[], from: string, to: string) {
  const empty = { reviews: [] as ReviewStatusReview[], steps: [] as ReviewStatusStep[], items: [] as ReviewStatusItem[], updates: [] as ReviewStatusUpdate[], followups: [] as ReviewStatusFollowup[], error: null as string | null };
  if (!supabaseAdmin || !stationCodes.length) return { ...empty, error: !supabaseAdmin ? "Review status is unavailable because the database service is not configured." : null };
  const reviewResult = await loadReviews(companyId, stationCodes, from, to);
  if (reviewResult.error || !reviewResult.rows.length) return { ...empty, reviews: reviewResult.rows, error: reviewResult.error };

  const dataset = { ...empty, reviews: reviewResult.rows };
  for (const reviewIds of chunks(reviewResult.rows.map((review) => review.id))) {
    const [steps, items, updates, followups] = await Promise.all([
      supabaseAdmin.from("ops_performance_review_steps").select("id,review_id,step_order,reviewer_name,reviewer_role,status,feedback,completed_at,bypass_reason,bypassed_at,bypassed_by_name,proxy_reviewer_name,proxy_reason,proxy_started_at").eq("company_id", companyId).in("review_id", reviewIds).order("step_order"),
      supabaseAdmin.from("ops_performance_review_items").select("review_id,metric_label,status,root_cause,corrective_action,action_owner,due_date").eq("company_id", companyId).in("review_id", reviewIds),
      supabaseAdmin.from("ops_performance_review_updates").select("review_id,update_type,note,author_name,author_role,stage_label,created_at").eq("company_id", companyId).in("review_id", reviewIds).order("created_at", { ascending: false }),
      supabaseAdmin.from("ops_performance_followups").select("review_id,action_number,title,owner_label,due_date,status").eq("company_id", companyId).in("review_id", reviewIds).order("action_number")
    ]);
    const error = steps.error || items.error || updates.error || followups.error;
    if (error) return { ...dataset, error: error.message };
    dataset.steps.push(...((steps.data ?? []) as ReviewStatusStep[]));
    dataset.items.push(...((items.data ?? []) as ReviewStatusItem[]));
    dataset.updates.push(...((updates.data ?? []) as ReviewStatusUpdate[]));
    dataset.followups.push(...((followups.data ?? []) as ReviewStatusFollowup[]));
  }
  return dataset;
}
