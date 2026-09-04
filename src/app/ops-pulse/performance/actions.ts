"use server";

import { revalidatePath } from "next/cache";
import { requirePagePermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { resolvePerformanceReviewChain } from "@/lib/ops-pulse/performance-review";
import { getReviewAccess } from "@/lib/ops-pulse/review-access";
import { reviewBypassReason, visibleReviewStep, noonEmdValue, stationTimingClocks } from "@/lib/ops-pulse/review-policy";
import { supabaseAdmin } from "@/lib/supabase-admin";

export type ReviewActionResult = { error?: string; notice?: string };
const text = (data: FormData, key: string) => String(data.get(key) ?? "").trim();
function dateValue(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error("Select a valid date.");
  return value;
}
function limited(data: FormData, key: string, max = 4000, required = false) {
  const value = text(data, key);
  if (required && !value) throw new Error("Complete the required fields.");
  if (value.length > max) throw new Error(`Keep this entry within ${max} characters.`);
  return value;
}
function finish(notice: string): ReviewActionResult {
  revalidatePath("/ops-pulse/performance");
  revalidatePath("/performance");
  return { notice };
}
function failure(error: unknown): ReviewActionResult {
  return { error: error instanceof Error ? error.message : "Unable to save this update. Please try again." };
}
function rpcError(error: { message: string; code?: string } | null) {
  if (!error) return;
  if (error.code === "P0001") throw new Error(error.message);
  console.error("Performance review save failed", error.code, error.message);
  throw new Error("Unable to save this update. Please refresh and try again.");
}
async function stationForAction(authorization: AuthorizationContext, stationCode: string) {
  if (!supabaseAdmin) throw new Error("Review service is unavailable.");
  const result = await supabaseAdmin.from("stations").select("id,station_code")
    .eq("company_id", requireCompanyId(authorization)).eq("station_code", stationCode).eq("is_active", true).maybeSingle();
  if (result.error || !result.data || !(authorization.hasAllLocationAccess || authorization.locationScopeIds.includes(result.data.id))) throw new Error("This station is outside your location access.");
  return result.data;
}
async function context(authorization: AuthorizationContext, data: FormData) {
  if (!supabaseAdmin) throw new Error("Review service is unavailable.");
  const companyId = requireCompanyId(authorization);
  const station = await stationForAction(authorization, text(data, "station_code").toUpperCase());
  const date = dateValue(text(data, "source_date"));
  const result = await supabaseAdmin.from("ops_performance_reviews")
    .select("id,station_id,station_code,source_date,current_step_order,status,updated_at")
    .eq("company_id", companyId).eq("id", text(data, "review_id")).eq("station_id", station.id).eq("source_date", date).maybeSingle();
  if (result.error || !result.data) throw new Error("This review is unavailable. Refresh and try again.");
  const steps = await supabaseAdmin.from("ops_performance_review_steps").select("id,step_order,reviewer_user_id,reviewer_role,status,bypassed_at,proxy_reviewer_user_id")
    .eq("company_id", companyId).eq("review_id", result.data.id).order("step_order");
  if (steps.error) throw new Error("Unable to check the current review stage.");
  const access = await getReviewAccess(authorization, station.id, result.data, steps.data ?? []);
  return { companyId, review: result.data, access, steps: steps.data ?? [] };
}
function author(authorization: AuthorizationContext, role: string) {
  return { author_name: authorization.fullName || "Reviewer", author_role: role };
}

export async function startPerformanceReview(data: FormData): Promise<ReviewActionResult> {
  const authorization = await requirePagePermission("performance_review", "access");
  try {
    const companyId = requireCompanyId(authorization);
    const station = await stationForAction(authorization, text(data, "station_code").toUpperCase());
    const sourceDate = dateValue(text(data, "source_date"));
    const chain = await resolvePerformanceReviewChain(companyId, station.id);
    if (!chain.length) throw new Error("The station review manager is not assigned in People. Contact your administrator.");
    const access = await getReviewAccess(authorization, station.id, null, chain.map((step, index) => ({ step_order: index+1,reviewer_user_id:step.reviewerUserId,reviewer_role:step.reviewerRole,status:"pending" })));
    if (!access.canStart) throw new Error("Only the first review manager or authorised oversight team can start this review.");
    const result = await supabaseAdmin!.rpc("ops_start_manager_review", {
      p_company: companyId,p_actor:authorization.userId,p_station:station.id,p_chain:chain,
      p_data:{source_date:sourceDate,source_type:text(data,"source_type") || "operational_data",source_batch_id:text(data,"source_batch_id"),report_week:text(data,"report_week") || null}
    });
    rpcError(result.error);
    return finish("Review started.");
  } catch (error) { return failure(error); }
}

export async function savePerformanceReviewOperations(data: FormData): Promise<ReviewActionResult> {
  const authorization = await requirePagePermission("performance_review", "access");
  try {
    const { companyId,review,access } = await context(authorization,data);
    if (!access.canEditRca) throw new Error("Only the first review manager during their stage, or Program Manager, can edit the takeaway.");
    const result=await supabaseAdmin!.rpc("ops_mutate_manager_review",{p_company:companyId,p_actor:authorization.userId,p_review:review.id,p_action:"summary",p_data:{summary:limited(data,"review_summary"),expected_review_version:text(data,"review_version"),...author(authorization,access.actor.label)}});
    rpcError(result.error);
    return finish("Takeaway saved.");
  } catch(error) { return failure(error); }
}

export async function savePerformanceReviewItem(data: FormData): Promise<ReviewActionResult> {
  const authorization = await requirePagePermission("performance_review", "access");
  try {
    const { companyId,review,access }=await context(authorization,data);
    if (!access.canEditRca) throw new Error("RCA and actions are editable by the first review manager during their stage, or Program Manager.");
    const metricKey=limited(data,"metric_key",150,true);
    if (!/^[a-zA-Z0-9_ -]+$/.test(metricKey)) throw new Error("Select a valid review metric.");
    const status=text(data,"status");
    if (!["open","in_progress","blocked","done"].includes(status)) throw new Error("Select a valid action status.");
    const numberValue=(key:string) => {const value=text(data,key);return value && Number.isFinite(Number(value)) ? Number(value) : null;};
    const result=await supabaseAdmin!.rpc("ops_mutate_manager_review",{p_company:companyId,p_actor:authorization.userId,p_review:review.id,p_action:"item",p_data:{
      metric_key:metricKey,metric_label:limited(data,"metric_label",250,true),root_cause:limited(data,"root_cause",4000,true),
      corrective_action:limited(data,"corrective_action",4000,true),action_owner:limited(data,"action_owner",250,true),due_date:dateValue(text(data,"due_date")),
      status,severity:text(data,"severity")==="amber"?"amber":"red",actual_value:numberValue("actual_value"),target_value:numberValue("target_value"),target_direction:text(data,"target_direction")==="lower"?"lower":"higher",
      expected_review_version:text(data,"review_version"),...author(authorization,access.actor.label)
    }});
    rpcError(result.error);
    return finish("RCA and action saved.");
  } catch(error) {return failure(error);}
}

/** One common comment box: save a note, or complete the assigned stage with that note. */
export async function savePerformanceReviewComment(data:FormData):Promise<ReviewActionResult> {
  const authorization=await requirePagePermission("performance_review","access");
  try {
    const { companyId,review,access,steps }=await context(authorization,data);
    const complete=text(data,"intent")==="complete";
    if (complete && access.routingIssue) throw new Error(access.routingIssue);
    if (complete ? !access.canComplete : !access.canComment) throw new Error(complete ? "Only the assigned manager can complete this review stage." : "You can add comments when the review reaches your stage. Program Managers can comment at any stage.");
    const note=limited(data,"feedback",4000,!complete);
    const step=steps.find((entry)=>entry.step_order===review.current_step_order && entry.status==="pending");
    if (complete && text(data,"step_id")!==step?.id) throw new Error("The review has moved to another stage. Refresh to continue.");
    const result=await supabaseAdmin!.rpc("ops_mutate_manager_review",{p_company:companyId,p_actor:authorization.userId,p_review:review.id,p_action:complete?"complete":"comment",p_data:{note,step_id:step?.id,expected_review_version:review.updated_at,...author(authorization,access.actor.label)}});
    rpcError(result.error);
    return finish(complete?"Your review is complete. The next manager can now review.":"Comment added.");
  }catch(error){return failure(error);}
}

export async function savePerformanceConnection(data:FormData):Promise<ReviewActionResult> {
  const authorization=await requirePagePermission("performance_review","access");
  try {
    const companyId=requireCompanyId(authorization);
    const station=await stationForAction(authorization,text(data,"station_code").toUpperCase());
    const date=dateValue(text(data,"source_date"));
    const reviewResult = await supabaseAdmin!.from("ops_performance_reviews")
      .select("id,station_id,station_code,source_date,current_step_order,status,updated_at")
      .eq("company_id", companyId).eq("station_id", station.id).eq("source_date", date).maybeSingle();
    if (reviewResult.error) throw new Error("Unable to check review access for connection timings.");
    const review = reviewResult.data;
    const stepsResult = review
      ? await supabaseAdmin!.from("ops_performance_review_steps").select("id,step_order,reviewer_user_id,reviewer_role,status,bypassed_at,proxy_reviewer_user_id")
          .eq("company_id", companyId).eq("review_id", review.id).order("step_order")
      : { data: [] as { id: string; step_order: number; reviewer_user_id: string | null; reviewer_role: string; status: string; bypassed_at?: string | null; proxy_reviewer_user_id?: string | null }[], error: null };
    if (stepsResult.error) throw new Error("Unable to check the current review stage.");
    const access=await getReviewAccess(authorization,station.id,review,stepsResult.data ?? []);
    if (!access.canEditConnections) throw new Error("Only the station team, first review manager on their stage, or Program Manager can edit connection timings.");
    const times = stationTimingClocks({ arrival: text(data, "arrival"), unloading: text(data, "unloading"), clearance: text(data, "clearance") }, date);
    const result = await supabaseAdmin!.rpc("ops_save_review_connection", {
      p_company: companyId, p_actor: authorization.userId, p_station: station.id, p_data: {
        ...times,
        id: text(data, "connection_id"),
        version: Number(text(data, "version")) || 1,
        service_date: date,
        label: "Vehicle",
        ...author(authorization, access.actor.label)
      }
    });
    rpcError(result.error);
    return finish("Station timings saved.");
  }catch(error){return failure(error);}
}

/** Explicit exception for one level of one station/day. Never changes the People hierarchy. */
export async function bypassPerformanceReviewLevel(data: FormData): Promise<ReviewActionResult> {
  const authorization = await requirePagePermission("performance_review", "access");
  try {
    const { companyId, review, access, steps } = await context(authorization, data);
    if (!access.canBypass) throw new Error("Only Program Manager, National Head, Owner or Tech can skip a review level within their station access.");
    const step = steps.find(entry => entry.id === text(data, "step_id") && entry.status === "pending" && visibleReviewStep(entry));
    if (!step) throw new Error("This review level is no longer pending. Refresh to continue.");
    const reason = reviewBypassReason(text(data, "reason"));
    const result = await supabaseAdmin!.rpc("ops_bypass_review_level", {
      p_company: companyId, p_actor: authorization.userId, p_review: review.id, p_step: step.id,
      p_reason: reason, p_expected_version: text(data, "review_version") || null,
    });
    rpcError(result.error);
    return finish("Review level skipped. The reason is recorded; other station reviews are unchanged.");
  } catch (error) { return failure(error); }
}

export async function proxyPerformanceReview(data: FormData): Promise<ReviewActionResult> {
  const authorization = await requirePagePermission("performance_review", "access");
  try {
    const { companyId, review, access, steps } = await context(authorization, data);
    if (!access.canProxy) throw new Error("This review can be covered by a higher assigned manager or authorised oversight. Refresh if it is already being covered.");
    const step = steps.find(entry => entry.id === text(data,"step_id") && entry.step_order === review.current_step_order && entry.status === "pending");
    if (!step) throw new Error("The review has moved to another stage. Refresh to continue.");
    const reason = limited(data,"reason",2000,true);
    if (reason.length < 5) throw new Error("Explain why the assigned manager cannot conduct this review.");
    const result = await supabaseAdmin!.rpc("ops_take_proxy_review", {p_company:companyId,p_actor:authorization.userId,p_review:review.id,p_step:step.id,p_reason:reason,p_expected_version:text(data,"review_version") || null});
    rpcError(result.error);
    return finish("You are now conducting this review on the assigned manager’s behalf. Add your inputs, then complete the review.");
  } catch(error) { return failure(error); }
}

export async function savePerformanceNoonEmd(data: FormData): Promise<ReviewActionResult> {
  const authorization = await requirePagePermission("performance_review", "access");
  try {
    const companyId = requireCompanyId(authorization);
    const station = await stationForAction(authorization,text(data,"station_code").toUpperCase());
    const date = dateValue(text(data,"source_date"));
    const reviewResult = await supabaseAdmin!.from("ops_performance_reviews")
      .select("id,station_id,station_code,source_date,current_step_order,status,updated_at")
      .eq("company_id", companyId).eq("station_id", station.id).eq("source_date", date).maybeSingle();
    if (reviewResult.error) throw new Error("Unable to check review access for station inputs.");
    const review = reviewResult.data;
    const stepsResult = review
      ? await supabaseAdmin!.from("ops_performance_review_steps").select("id,step_order,reviewer_user_id,reviewer_role,status,bypassed_at,proxy_reviewer_user_id")
          .eq("company_id", companyId).eq("review_id", review.id).order("step_order")
      : { data: [] as { id: string; step_order: number; reviewer_user_id: string | null; reviewer_role: string; status: string; bypassed_at?: string | null; proxy_reviewer_user_id?: string | null }[], error: null };
    if (stepsResult.error) throw new Error("Unable to check the current review stage.");
    const access = await getReviewAccess(authorization,station.id,review,stepsResult.data ?? []);
    if (!access.canEditConnections) throw new Error("Only the station team, first review manager on their stage, or Program Manager can update station inputs.");
    const value = noonEmdValue(text(data,"emd_noon_pct"));
    if (value === null) throw new Error("Enter EMD at 12 p.m. (0 to 100%).");
    const version = Number(text(data,"version"));
    if (!Number.isInteger(version) || version < 0) throw new Error("Refresh this entry before saving.");
    const result = await supabaseAdmin!.rpc("ops_save_review_noon_emd", {p_company:companyId,p_actor:authorization.userId,p_station:station.id,p_date:date,p_value:value,p_version:version});
    rpcError(result.error);
    return finish("EMD at 12 p.m. saved.");
  } catch(error) { return failure(error); }
}

export async function savePerformanceFollowup(data: FormData): Promise<ReviewActionResult> {
  const authorization = await requirePagePermission("performance_review", "access");
  try {
    const { companyId, review, access } = await context(authorization,data);
    const id = text(data,"id");
    if (id ? !access.canManageActions : !access.canEditRca) throw new Error("Only the review managers or Program Manager can update station actions.");
    const status = text(data,"status") || "open";
    if (!["open","in_progress","blocked","done"].includes(status)) throw new Error("Select a valid action status.");
    const result = await supabaseAdmin!.rpc("ops_save_review_followup", {p_company:companyId,p_actor:authorization.userId,p_station:review.station_id,p_view_date:review.source_date,p_data:{id,review_id:review.id,version:Number(text(data,"version")),title:limited(data,"title",2000,true),owner_label:limited(data,"owner_label",250,true),due_date:dateValue(text(data,"due_date")),status,progress_note:limited(data,"progress_note",2000),...author(authorization,access.actor.label)}});
    rpcError(result.error);
    return finish(id ? "Action updated. It remains visible in the station’s reviews." : "Action added with an owner and ETA.");
  } catch(error) { return failure(error); }
}

export async function updateCarriedReviewAction(data:FormData):Promise<ReviewActionResult> {
  const authorization=await requirePagePermission("performance_review","access");
  try {
    const {companyId,review,access}=await context(authorization,data);
    if(!access.canManageActions) throw new Error("Only the review managers or Program Manager can update action progress.");
    const status=text(data,"status");
    if(!["open","in_progress","blocked","done"].includes(status)) throw new Error("Select an action status.");
    const result=await supabaseAdmin!.rpc("ops_progress_review_item",{p_company:companyId,p_actor:authorization.userId,p_station:review.station_id,p_date:review.source_date,p_item:text(data,"item_id"),p_version:text(data,"item_version"),p_status:status,p_note:limited(data,"progress_note",2000,true)});
    rpcError(result.error);
    return finish("Action progress saved.");
  } catch(error) { return failure(error); }
}
