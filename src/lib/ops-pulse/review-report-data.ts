import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadPerformanceTargets, resolvePerformanceTargets } from "./performance-targets";
import { buildReviewReport, reviewReportDates, type ReportStation, type ReportSourceRow, type ReviewReportSources } from "./review-report";

export async function reportAllRows<T>(query: (start: number, end: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, cap = 200000) {
  const rows: T[] = [];
  for (let start = 0; start < cap; start += 1000) {
    const result = await query(start, start + 999);
    if (result.error) throw Error(`Report source could not be loaded: ${result.error.message}`);
    rows.push(...(result.data ?? []));
    if ((result.data?.length ?? 0) < 1000) return rows;
  }
  throw Error("This report is too large. Choose fewer locations or a shorter date range; no rows have been omitted.");
}
export async function loadReviewReport(companyId: string, stations: ReportStation[], from: string, to: string) {
  reviewReportDates(from, to);
  if (!supabaseAdmin || !stations.length) throw Error("No available report stations.");
  const db = supabaseAdmin, codes = stations.map(s => s.station_code), ids = stations.map(s => s.id);
  const byDate = (table: string, columns: string, dateColumn: string, stationColumn = "station_code") => reportAllRows<ReportSourceRow>((a, b) => db.from(table).select(columns).eq("company_id", companyId).in(stationColumn, stationColumn === "station_id" ? ids : codes).gte(dateColumn, from).lte(dateColumn, to).order(dateColumn).order(stationColumn).order(table === "ops_performance_daily_inputs" ? "updated_at" : table === "ops_review_edd_observations" ? "captured_slot" : "id").range(a, b) as any);
  const [reviews, facts, connections, emd, costs, edd, targetResult] = await Promise.all([
    reportAllRows<ReportSourceRow>((a,b) => db.from("ops_performance_reviews").select("id,source_date,station_id,station_code,status,current_step_order,review_summary,started_at,closed_at,updated_at").eq("company_id",companyId).eq("review_type","daily_operations").in("station_code",codes).gte("source_date",from).lte("source_date",to).order("source_date").order("id").range(a,b)),
    reportAllRows<ReportSourceRow>((a,b) => db.from("report_metric_facts").select("id,report_date,station_code,values_json,created_at").eq("company_id",companyId).eq("source_type","amazon_hawkeye_daily").in("station_code",codes).gte("report_date",from).lte("report_date",to).order("report_date").order("id").range(a,b)),
    byDate("ops_performance_connections", "id,station_id,service_date,label,arrival_at,unloading_at,updated_by_name,updated_at", "service_date", "station_id"),
    byDate("ops_performance_daily_inputs", "station_id,source_date,emd_noon_pct,updated_at,updated_by_name", "source_date", "station_id"),
    byDate("cps_station_daily", "id,station_code,work_date,total_delivery,total_cost,overall_cps,da_pay_cost,da_cps,utr_cost,van_cost,fuel_cost,rent_cost,other_cost,updated_at", "work_date"),
    byDate("ops_review_edd_observations", "station_id,work_date,captured_slot,observed_at,source_at,backlog_at,performance_at,counts", "work_date", "station_id"),
    loadPerformanceTargets(companyId, { readOnly: true })
  ]);
  if (targetResult.error) throw Error(targetResult.error);
  const data: ReviewReportSources = { reviews, facts, connections, emd, costs, edd, items: [], steps: [], updates: [], followups: [] };
  const children = {
    items: ["ops_performance_review_items", "id,review_id,metric_key,metric_label,actual_value,target_value,target_direction,severity,root_cause,corrective_action,action_owner,due_date,status,carried_from_item_id,updated_at"],
    steps: ["ops_performance_review_steps", "id,review_id,step_order,reviewer_name,reviewer_role,status,feedback,completed_at,bypass_reason,bypassed_at,bypassed_by_name,proxy_reviewer_name,proxy_reason"],
    updates: ["ops_performance_review_updates", "id,review_id,update_type,note,author_name,author_role,stage_label,created_at"],
    followups: ["ops_performance_followups", "id,review_id,action_number,title,owner_label,due_date,status,progress_note,completed_at,updated_by_name,updated_at"]
  };
  // Chunk IDs and paginate every child table: one review may have many comments.
  for (let i = 0; i < reviews.length; i += 100) await Promise.all(Object.entries(children).map(async ([key, [table, columns]]) => {
    const rows = await reportAllRows<ReportSourceRow>((a, b) => db.from(table).select(columns).eq("company_id", companyId).in("review_id", reviews.slice(i, i + 100).map(r => r.id)).order("review_id").order("id").range(a, b) as any);
    data[key as keyof typeof children].push(...rows);
  }));
  return buildReviewReport(from, to, stations, data, resolvePerformanceTargets(targetResult.rows, "daily"));
}
