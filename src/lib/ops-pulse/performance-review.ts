import type { AuthorizationContext } from "@/lib/authorization";
import { managerReviewChain } from "@/lib/ops-pulse/review-policy";
import { loadReviewUserLinks } from "@/lib/ops-pulse/review-user-links";
import type { CodLocationRow } from "@/lib/ops-pulse/cod";
import { resolveStationOpeningSchedule, stationOpeningLateMinutes } from "@/lib/ops-pulse/station-opening";
import { loadStationOpeningAttendance } from "@/lib/ops-pulse/station-opening-attendance";
import { loadOpsStationManpower } from "@/lib/ops-pulse/station-manpower";
import { loadPeopleOperationalHierarchy } from "@/lib/people-operational-hierarchy";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { REVIEW_PENDING_PAGE_SIZE } from "@/lib/ops-pulse/review-periods";

export type PerformanceReviewSettings = {
  daily_review_time: string;
  weekly_review_time: string;
  weekly_review_weekday: number;
  stale_after_hours: number;
};

export type PerformanceReview = {
  id: string;
  review_type: "daily_operations" | "weekly_sales";
  source_date: string;
  report_year: number | null;
  report_week: number | null;
  station_id: string;
  station_code: string;
  source_type: string;
  source_batch_id: string | null;
  status: "open" | "in_review" | "closed";
  current_step_order: number;
  vehicle_arrival_time: string | null;
  unloading_complete_time: string | null;
  station_clear_time: string | null;
  review_summary: string | null;
  started_at: string;
  closed_at: string | null;
  updated_at: string;
};

export type PerformanceReviewCarryover = Pick<PerformanceReview, "id" | "station_code" | "source_date" | "status" | "review_summary" | "closed_at" | "updated_at">;

export type PerformanceReviewStep = {
  id: string;
  review_id: string;
  step_order: number;
  reviewer_user_id: string | null;
  reviewer_name: string;
  reviewer_role: string;
  status: "pending" | "completed" | "skipped";
  feedback: string | null;
  completed_at: string | null;
  bypass_reason: string | null;
  bypassed_at: string | null;
  bypassed_by_name: string | null;
  proxy_reviewer_user_id: string | null;
  proxy_reviewer_name: string | null;
  proxy_reason: string | null;
  proxy_started_at: string | null;
};

export type PerformancePendingReview = Pick<PerformanceReview, "id" | "station_code" | "source_date" | "review_type" | "status" | "started_at" | "current_step_order"> & {
  pending_name: string | null;
  pending_role: string | null;
};
export type PerformanceReviewBacklog = { rows: PerformancePendingReview[]; count: number; page: number; pageSize: number; error: string | null };

export type PerformanceFollowup = {
  id: string; review_id: string; station_id: string; source_date: string; action_number: number;
  title: string; owner_label: string; due_date: string; status: "open" | "in_progress" | "blocked" | "done";
  progress_note: string | null; version: number; updated_at: string; updated_by_name: string;
};
export type PerformanceNoonEmd = { emd_noon_pct: number | null; version: number; updated_at: string; updated_by_name: string };

export async function loadPerformanceFollowups(companyId: string, stationId: string, date: string) {
  if (!supabaseAdmin) return { rows: [] as PerformanceFollowup[], count: 0, error: "Station actions are unavailable." };
  const result = await supabaseAdmin.from("ops_performance_followups")
    .select("id,review_id,station_id,source_date,action_number,title,owner_label,due_date,status,progress_note,version,updated_at,updated_by_name", { count: "exact" })
    .eq("company_id", companyId).eq("station_id", stationId).lte("source_date", date)
    .order("is_resolved").order("due_date").order("source_date", { ascending: false }).order("action_number").limit(200);
  return { rows: (result.data ?? []) as PerformanceFollowup[], count: result.count ?? 0,
    error: result.error ? "Station actions could not be loaded. Refresh to try again." : null };
}

export async function loadPerformanceNoonEmd(companyId: string, stationId: string, date: string) {
  if (!supabaseAdmin) return { row: null as PerformanceNoonEmd | null, error: "EMD entry is unavailable." };
  const result = await supabaseAdmin.from("ops_performance_daily_inputs")
    .select("emd_noon_pct,version,updated_at,updated_by_name").eq("company_id", companyId).eq("station_id", stationId).eq("source_date", date).maybeSingle();
  return { row: result.data as PerformanceNoonEmd | null, error: result.error ? "EMD at 12 p.m. could not be loaded. Refresh to try again." : null };
}

export async function loadPerformanceReviewBacklog(companyId: string, date: string, stationCodes: string[], requestedPage = 1): Promise<PerformanceReviewBacklog> {
  const empty = { rows: [], count: 0, page: 1, pageSize: REVIEW_PENDING_PAGE_SIZE, error: null };
  if (!supabaseAdmin || !stationCodes.length) return empty;
  const query = (page: number) => supabaseAdmin!.from("ops_performance_reviews")
    .select("id,station_code,source_date,review_type,status,started_at,current_step_order", { count: "exact" })
    .eq("company_id", companyId).eq("review_type", "daily_operations").in("station_code", stationCodes)
    .lt("source_date", date).in("status", ["open", "in_review"])
    .order("source_date").order("station_code").order("id")
    .range((page - 1) * REVIEW_PENDING_PAGE_SIZE, page * REVIEW_PENDING_PAGE_SIZE - 1);
  let result = await query(requestedPage);
  if (result.error) return { ...empty, error: "Earlier pending reviews could not be loaded. Refresh to try again." };
  const page = Math.min(requestedPage, Math.max(1, Math.ceil((result.count ?? 0) / REVIEW_PENDING_PAGE_SIZE)));
  if (page !== requestedPage) result = await query(page);
  if (result.error) return { ...empty, error: "Earlier pending reviews could not be loaded. Refresh to try again." };
  const reviews = result.data ?? [];
  const steps = reviews.length ? await supabaseAdmin.from("ops_performance_review_steps")
    .select("review_id,step_order,reviewer_name,reviewer_role,status,proxy_reviewer_name").eq("company_id", companyId)
    .in("review_id", reviews.map(row => row.id)).eq("status", "pending") : { data: [], error: null };
  if (steps.error) return { ...empty, error: "Earlier review dependencies could not be loaded. Refresh to try again." };
  return {
    rows: reviews.map(row => {
      const step = steps.data?.find(step => step.review_id === row.id && step.step_order === row.current_step_order);
      return { ...row, pending_name: step?.proxy_reviewer_name || step?.reviewer_name || null, pending_role: step?.reviewer_role ?? null } as PerformancePendingReview;
    }), count: result.count ?? 0, page, pageSize: REVIEW_PENDING_PAGE_SIZE, error: null
  };
}

export type PerformanceReviewItem = {
  id: string;
  review_id: string;
  metric_key: string;
  metric_label: string;
  actual_value: number | string | null;
  target_value: number | string | null;
  target_direction: "higher" | "lower" | null;
  severity: "amber" | "red";
  root_cause: string | null;
  corrective_action: string | null;
  action_owner: string | null;
  due_date: string | null;
  status: "open" | "in_progress" | "blocked" | "done";
  created_at: string;
  updated_at: string;
};

export type PerformanceReviewUpdate = {
  id: string;
  review_id: string;
  review_item_id: string | null;
  update_type: string;
  note: string;
  created_at: string;
  created_by: string | null;
  author_name: string | null;
  author_role: string | null;
  stage_label: string | null;
};

export type PerformanceConnection = {
  id: string;
  station_id: string;
  service_date: string;
  label: string;
  arrival_at: string;
  unloading_at: string | null;
  clearance_at: string | null;
  version: number;
  updated_by_name: string;
  updated_at: string;
};

export async function loadPerformanceConnections(companyId: string, stationId: string, date: string) {
  if (!supabaseAdmin) return { connections: [] as PerformanceConnection[], error: "Database service is unavailable." };
  const result = await supabaseAdmin.from("ops_performance_connections")
    .select("id,station_id,service_date,label,arrival_at,unloading_at,clearance_at,version,updated_by_name,updated_at")
    .eq("company_id", companyId).eq("station_id", stationId).eq("service_date", date).order("arrival_at");
  return { connections: (result.data ?? []) as PerformanceConnection[], error: result.error?.message ?? null };
}

export type PerformanceOperationalSnapshot = {
  adHocCost: number | null;
  adHocDaCost: number;
  adHocDaRequests: PerformanceCostRequest[];
  adHocVanCost: number;
  adHocVanRequests: PerformanceCostRequest[];
  activeFeCount: number;
  associateDeliveries: PerformanceAssociateDelivery[];
  averageAllocation: number | null;
  costBreakdown: PerformanceCostBreakdown[];
  dailyCps: number | null;
  dayCost: number | null;
  deliveredCount: number;
  firstPunchAt: string | null;
  firstPunchBy: string | null;
  openingFirstOtherPunch: { time: string; name: string; profileLabel: string; workerCode: string } | null;
  openingLateMinutes: number | null;
  openingShiftName: string | null;
  openingShiftSource: string | null;
  openingWindowEnd: string;
  openingWindowStart: string;
  scheduledOpeningTime: string | null;
  fuelPay: number;
  mgSalaryPay: number;
  mtdCost: number;
  mtdCps: number | null;
  mtdDelivery: number;
  overallCps: number | null;
  salaryDaCost: number;
  salaryDaCps: number | null;
  unmappedFeCount: number;
  variableDaPay: number;
};

export type PerformanceAssociateDelivery = {
  assigned: number | null;
  associateId: string;
  delivered: number;
  name: string;
  paymentScheme: string | null;
  paymentSetupStatus: string | null;
  rateCard: string | null;
  totalPay: number | null;
};

export type PerformanceCostRequest = {
  amount: number;
  category: "DA" | "Van" | "Other";
  head: string;
  reason: string;
  requestNo: string;
};

export type PerformanceCostBreakdown = {
  amount: number;
  count: number;
  cps: number;
  head: string;
  source: string;
  subHead: string;
};

export type PerformanceReviewChainStep = {
  reviewerName: string;
  reviewerRole: string;
  reviewerUserId: string | null;
};

type Relation<T> = T | T[] | null | undefined;

function one<T>(relation: Relation<T>) {
  return Array.isArray(relation) ? relation[0] ?? null : relation ?? null;
}

function normalized(value: unknown) {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function numberOrNull(value: unknown) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function istClockMinutes(value: string | null | undefined) {
  if (!value) return null;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZone: "Asia/Kolkata"
  }).formatToParts(instant);
  const hours = Number(parts.find((part) => part.type === "hour")?.value);
  const minutes = Number(parts.find((part) => part.type === "minute")?.value);
  return Number.isFinite(hours) && Number.isFinite(minutes) ? hours * 60 + minutes : null;
}

function missingSchema(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? error ?? "").toLowerCase();
  return message.includes("ops_performance_review") && (message.includes("does not exist") || message.includes("schema cache"));
}

export async function loadPerformanceReviewWorkspace(companyId: string, sourceDate: string, stationCodes: string[]) {
  const fallback: PerformanceReviewSettings = {
    daily_review_time: "10:00:00",
    weekly_review_time: "16:00:00",
    weekly_review_weekday: 4,
    stale_after_hours: 24
  };
  if (!supabaseAdmin || !stationCodes.length) {
    return { settings: fallback, reviews: [] as PerformanceReview[], previousReviews: [] as PerformanceReviewCarryover[], steps: [] as PerformanceReviewStep[], items: [] as PerformanceReviewItem[], updates: [] as PerformanceReviewUpdate[], error: supabaseAdmin ? null : "Database service is unavailable." };
  }

  const [settingsResult, reviewsResult, historicalReviewsResult] = await Promise.all([
    supabaseAdmin.from("ops_performance_review_settings")
      .select("daily_review_time,weekly_review_time,weekly_review_weekday,stale_after_hours")
      .eq("company_id", companyId).maybeSingle(),
    supabaseAdmin.from("ops_performance_reviews")
      .select("id,review_type,source_date,report_year,report_week,station_id,station_code,source_type,source_batch_id,status,current_step_order,vehicle_arrival_time,unloading_complete_time,station_clear_time,review_summary,started_at,closed_at,updated_at")
      .eq("company_id", companyId).eq("review_type", "daily_operations").eq("source_date", sourceDate).in("station_code", stationCodes),
    supabaseAdmin.from("ops_performance_reviews")
      .select("id,station_code,source_date,status,review_summary,closed_at,updated_at")
      .eq("company_id", companyId).eq("review_type", "daily_operations").in("station_code", stationCodes).lt("source_date", sourceDate).order("source_date", { ascending: false }).limit(Math.max(400, stationCodes.length * 21))
  ]);
  const schemaError = [settingsResult.error, reviewsResult.error, historicalReviewsResult.error].find((error) => error && missingSchema(error));
  if (schemaError) return { settings: fallback, reviews: [] as PerformanceReview[], previousReviews: [] as PerformanceReviewCarryover[], steps: [] as PerformanceReviewStep[], items: [] as PerformanceReviewItem[], updates: [] as PerformanceReviewUpdate[], error: "Performance review setup is being activated." };
  const error = settingsResult.error ?? reviewsResult.error ?? historicalReviewsResult.error;
  if (error) return { settings: fallback, reviews: [] as PerformanceReview[], previousReviews: [] as PerformanceReviewCarryover[], steps: [] as PerformanceReviewStep[], items: [] as PerformanceReviewItem[], updates: [] as PerformanceReviewUpdate[], error: error.message };

  const historicalReviewIds = (historicalReviewsResult.data ?? []).map((review) => review.id);
  const selectedReviewIds = (reviewsResult.data ?? []).map((review) => review.id);
  const itemReviewIds = [...new Set([...selectedReviewIds, ...historicalReviewIds])];
  const [stepsResult, itemsResult, updatesResult] = await Promise.all([
    selectedReviewIds.length
      ? supabaseAdmin.from("ops_performance_review_steps").select("id,review_id,step_order,reviewer_user_id,reviewer_name,reviewer_role,status,feedback,completed_at,bypass_reason,bypassed_at,bypassed_by_name,proxy_reviewer_user_id,proxy_reviewer_name,proxy_reason,proxy_started_at").eq("company_id", companyId).in("review_id", selectedReviewIds).order("step_order")
      : Promise.resolve({ data: [] as PerformanceReviewStep[], error: null }),
    itemReviewIds.length
      ? supabaseAdmin.from("ops_performance_review_items").select("id,review_id,metric_key,metric_label,actual_value,target_value,target_direction,severity,root_cause,corrective_action,action_owner,due_date,status,created_at,updated_at").eq("company_id", companyId).in("review_id", itemReviewIds).order("created_at", { ascending: false }).limit(1000)
      : Promise.resolve({ data: [] as PerformanceReviewItem[], error: null }),
    selectedReviewIds.length
      ? supabaseAdmin.from("ops_performance_review_updates").select("id,review_id,review_item_id,update_type,note,created_at,created_by,author_name,author_role,stage_label").eq("company_id", companyId).in("review_id", selectedReviewIds).order("created_at", { ascending: false }).limit(500)
      : Promise.resolve({ data: [] as PerformanceReviewUpdate[], error: null })
  ]);
  const childError = stepsResult.error ?? itemsResult.error ?? updatesResult.error;
  return {
    settings: (settingsResult.data ?? fallback) as PerformanceReviewSettings,
    reviews: (reviewsResult.data ?? []) as PerformanceReview[],
    previousReviews: (historicalReviewsResult.data ?? []) as PerformanceReviewCarryover[],
    steps: (stepsResult.data ?? []) as PerformanceReviewStep[],
    items: (itemsResult.data ?? []) as PerformanceReviewItem[],
    updates: (updatesResult.data ?? []) as PerformanceReviewUpdate[],
    error: childError?.message ?? null
  };
}

export function isAdHocHead(head: { code: string | null; name: string | null }) {
  const candidate = `${normalized(head.code)}_${normalized(head.name)}`;
  return candidate.includes("ADHOC") || candidate.includes("AD_HOC") || candidate.includes("SPOT_MANPOWER");
}

export function adHocCategory(head: { code: string | null; name: string | null }): PerformanceCostRequest["category"] {
  const candidate = `${normalized(head.code)}_${normalized(head.name)}`;
  if (candidate.includes("VAN") || candidate.includes("VEHICLE")) return "Van";
  if (candidate.includes("_DA") || candidate.includes("DRIVER") || candidate.includes("ASSOCIATE") || candidate.includes("MANPOWER")) return "DA";
  return "Other";
}

export function paymentReason(row: { remarks?: string | null; notes?: string | null; details?: unknown }) {
  if (row.remarks?.trim()) return row.remarks.trim();
  if (row.notes?.trim()) return row.notes.trim();
  if (row.details && typeof row.details === "object" && !Array.isArray(row.details)) {
    const details = row.details as Record<string, unknown>;
    for (const key of ["reason", "purpose", "remarks", "description", "deployment_reason"]) {
      const value = String(details[key] ?? "").trim();
      if (value) return value;
    }
  }
  return "Reason not recorded in the request";
}

export function isApprovedPayment(request: { status: string | null; approval_status: string | null; current_approver_user_id: string | null; current_approver_role_id: string | null }) {
  const status = normalized(request.status);
  const approval = normalized(request.approval_status);
  if ([status, approval].some((value) => ["REJECTED", "RETURNED", "CANCELLED"].includes(value))) return false;
  if ([status, approval].some((value) => ["APPROVED", "PROCESSING", "PROCESSED", "PAID"].includes(value))) return true;
  return (status.endsWith("_APPROVED") || approval.endsWith("_APPROVED"))
    && !request.current_approver_user_id && !request.current_approver_role_id;
}

function readablePayType(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw || normalized(raw) === "UNALLOCATED") return null;
  return raw.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function associateRateCard(row: Record<string, unknown>) {
  const rates: string[] = [];
  const add = (label: string, value: unknown) => {
    const amount = numberOrNull(value);
    if (amount != null && amount > 0) rates.push(`${label} ₹${amount.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);
  };
  add("Delivery", row.del_rate);
  add("C-return", row.c_return_rate);
  add("MFN", row.mfn_rate);
  add("MFN return", row.mfn_return_rate);
  add("MG", row.mg_salary);
  add("Fuel", row.fuel_rate);
  return rates.length ? rates.join(" · ") : null;
}

export async function loadPerformanceOperationalSnapshots(companyId: string, sourceDate: string, locations: CodLocationRow[]) {
  const empty = new Map<string, PerformanceOperationalSnapshot>();
  if (!supabaseAdmin || !locations.length) return { rows: empty, error: supabaseAdmin ? null : "Database service is unavailable." };
  const stationCodes = locations.map((location) => location.station_code);
  const locationIds = locations.map((location) => location.id);
  const monthFrom = `${sourceDate.slice(0, 7)}-01`;
  const [costResult, monthCostResult, breakupResult, shipmentResult, detailResult, capacityResult, monthCapacityResult, headsResult, openingResult, manpowerResult] = await Promise.all([
    supabaseAdmin.from("cps_station_daily")
      .select("station_code,total_delivery,total_cost,overall_cps,da_pay_cost,da_cps").eq("company_id", companyId).eq("work_date", sourceDate).in("station_code", stationCodes),
    supabaseAdmin.from("cps_station_daily")
      .select("station_code,total_delivery,total_cost").eq("company_id", companyId).gte("work_date", monthFrom).lte("work_date", sourceDate).in("station_code", stationCodes),
    supabaseAdmin.from("cps_cost_breakup_daily")
      .select("station_code,head,sub_head,source,amount,count,cps").eq("company_id", companyId).eq("work_date", sourceDate).in("station_code", stationCodes),
    supabaseAdmin.from("cps_shipment_daily")
      .select("station_code,provider_employee_id,provider_employee_name,dropx_name,pay_type,total_delivery,assigned_count,del_rate,c_return_rate,mfn_rate,mfn_return_rate,mg_salary,fuel_rate,variable_pay,mg_pay,fuel_pay,da_total_pay,mapping_status")
      .eq("company_id", companyId).eq("work_date", sourceDate).in("station_code", stationCodes),
    supabaseAdmin.from("delivered_shipment_facts")
      .select("station_code,driver_id,driver_name,package_count").eq("company_id", companyId).eq("work_date", sourceDate).in("station_code", stationCodes),
    supabaseAdmin.from("capacity_station_daily_cache")
      .select("station_code,delivered,active_ids").eq("company_id", companyId).eq("work_date", sourceDate).in("station_code", stationCodes),
    supabaseAdmin.from("capacity_station_daily_cache")
      .select("station_code,delivered").eq("company_id", companyId).gte("work_date", monthFrom).lte("work_date", sourceDate).in("station_code", stationCodes),
    supabaseAdmin.from("payment_heads").select("id,code,name").eq("company_id", companyId),
    supabaseAdmin.from("ops_performance_station_settings")
      .select("station_id,opening_window_start,opening_window_end").eq("company_id", companyId).in("station_id", locationIds),
    loadOpsStationManpower(companyId, locations, sourceDate).catch(() => null)
  ]);
  const error = costResult.error ?? monthCostResult.error ?? breakupResult.error ?? shipmentResult.error ?? detailResult.error ?? capacityResult.error ?? monthCapacityResult.error ?? headsResult.error ?? openingResult.error;
  if (error) return { rows: empty, error: error.message };
  const adHocHeads = (headsResult.data ?? []).filter(isAdHocHead);
  const adHocHeadIds = adHocHeads.map((head) => head.id);
  const adHocHeadById = new Map(adHocHeads.map((head) => [head.id, head]));
  const paymentsResult = adHocHeadIds.length
    ? await supabaseAdmin.from("payment_requests")
      .select("request_no,payment_head_id,station_code,location_code,amount,amount_approved,amount_requested,status,approval_status,current_approver_user_id,current_approver_role_id,remarks,notes,details")
      .eq("company_id", companyId).eq("work_date", sourceDate).in("payment_head_id", adHocHeadIds)
    : { data: [], error: null };
  if (paymentsResult.error) return { rows: empty, error: paymentsResult.error.message };

  const openingByStationId = new Map((openingResult.data ?? []).map((row) => [row.station_id, {
    end: String(row.opening_window_end ?? "10:00:00"),
    start: String(row.opening_window_start ?? "02:00:00")
  }]));
  const stationIdByCode = new Map(locations.map((location) => [location.station_code, location.id]));
  const blank = (code: string): PerformanceOperationalSnapshot => {
    const opening = openingByStationId.get(stationIdByCode.get(code) ?? "") ?? { end: "10:00:00", start: "02:00:00" };
    return ({
    adHocCost: null,
    adHocDaCost: 0,
    adHocDaRequests: [],
    adHocVanCost: 0,
    adHocVanRequests: [],
    activeFeCount: 0,
    associateDeliveries: [],
    averageAllocation: null,
    costBreakdown: [],
    dailyCps: null,
    dayCost: null,
    deliveredCount: 0,
    firstPunchAt: null,
    firstPunchBy: null,
    openingFirstOtherPunch: null,
    openingLateMinutes: null,
    openingShiftName: null,
    openingShiftSource: null,
    openingWindowEnd: opening.end,
    openingWindowStart: opening.start,
    scheduledOpeningTime: null,
    fuelPay: 0,
    mgSalaryPay: 0,
    mtdCost: 0,
    mtdCps: null,
    mtdDelivery: 0,
    overallCps: null,
    salaryDaCost: 0,
    salaryDaCps: null,
    unmappedFeCount: 0,
    variableDaPay: 0
  });
  };
  stationCodes.forEach((code) => empty.set(code, blank(code)));
  if (manpowerResult) {
    stationCodes.forEach((code) => {
      const current = empty.get(code)!;
      const locationId = stationIdByCode.get(code);
      if (!locationId) return;
      const schedule = resolveStationOpeningSchedule(
        manpowerResult.people,
        locationId,
        current.openingWindowStart,
        current.openingWindowEnd
      );
      current.scheduledOpeningTime = schedule.scheduledTime;
      current.openingShiftName = schedule.shiftName;
      current.openingShiftSource = schedule.shiftSource;
    });
  }
  (costResult.data ?? []).forEach((row) => {
    const current = empty.get(row.station_code) ?? blank(row.station_code);
    current.dayCost = numberOrNull(row.total_cost);
    current.overallCps = numberOrNull(row.overall_cps);
    current.dailyCps = numberOrNull(row.overall_cps);
    current.salaryDaCost = numberOrNull(row.da_pay_cost) ?? 0;
    current.salaryDaCps = numberOrNull(row.da_cps);
    empty.set(row.station_code, current);
  });
  (monthCostResult.data ?? []).forEach((row) => {
    const current = empty.get(row.station_code);
    if (!current) return;
    current.mtdCost += numberOrNull(row.total_cost) ?? 0;
    current.mtdDelivery += numberOrNull(row.total_delivery) ?? 0;
    current.mtdCps = current.mtdDelivery ? current.mtdCost / current.mtdDelivery : null;
  });
  (breakupResult.data ?? []).forEach((row) => {
    const current = empty.get(row.station_code);
    if (!current) return;
    current.costBreakdown.push({
      amount: numberOrNull(row.amount) ?? 0,
      count: numberOrNull(row.count) ?? 0,
      cps: numberOrNull(row.cps) ?? 0,
      head: row.head || "Other CPS",
      source: row.source || "OpsPulse",
      subHead: row.sub_head || "Operating cost"
    });
  });
  type MutableAssociate = PerformanceAssociateDelivery & { hasDetailedDelivery: boolean };
  const associatesByStation = new Map<string, Map<string, MutableAssociate>>();
  const associateMap = (stationCode: string) => {
    const existing = associatesByStation.get(stationCode);
    if (existing) return existing;
    const created = new Map<string, MutableAssociate>();
    associatesByStation.set(stationCode, created);
    return created;
  };
  const detailFeByStation = new Map<string, Set<string>>();
  (detailResult.data ?? []).forEach((row) => {
    const current = empty.get(row.station_code);
    if (!current) return;
    current.deliveredCount += numberOrNull(row.package_count) ?? 1;
    const drivers = detailFeByStation.get(row.station_code) ?? new Set<string>();
    const associateId = normalized(row.driver_id) || `NAME_${normalized(row.driver_name)}`;
    if (associateId) {
      drivers.add(associateId);
      const people = associateMap(row.station_code);
      const person = people.get(associateId) ?? {
        assigned: null,
        associateId: String(row.driver_id || "—"),
        delivered: 0,
        hasDetailedDelivery: true,
        name: String(row.driver_name || row.driver_id || "Unidentified associate"),
        paymentScheme: null,
        paymentSetupStatus: null,
        rateCard: null,
        totalPay: null
      };
      person.delivered += numberOrNull(row.package_count) ?? 1;
      person.hasDetailedDelivery = true;
      if ((!person.name || person.name === "Unidentified associate") && row.driver_name) person.name = row.driver_name;
      people.set(associateId, person);
    }
    detailFeByStation.set(row.station_code, drivers);
  });
  (capacityResult.data ?? []).forEach((row) => {
    const current = empty.get(row.station_code);
    if (!current) return;
    const delivered = numberOrNull(row.delivered) ?? 0;
    const activeIds = numberOrNull(row.active_ids) ?? 0;
    if (delivered) current.deliveredCount = delivered;
    if (activeIds) current.activeFeCount = activeIds;
  });
  const daCostByStation = new Map<string, number>();
  const shipmentDeliveryByStation = new Map<string, number>();
  (shipmentResult.data ?? []).forEach((row) => {
    const current = empty.get(row.station_code);
    if (!current) return;
    const delivered = numberOrNull(row.total_delivery) ?? 0;
    shipmentDeliveryByStation.set(row.station_code, (shipmentDeliveryByStation.get(row.station_code) ?? 0) + delivered);
    current.variableDaPay += numberOrNull(row.variable_pay) ?? 0;
    current.mgSalaryPay += numberOrNull(row.mg_pay) ?? 0;
    current.fuelPay += numberOrNull(row.fuel_pay) ?? 0;
    daCostByStation.set(row.station_code, (daCostByStation.get(row.station_code) ?? 0) + (numberOrNull(row.da_total_pay) ?? 0));
    if (normalized(row.mapping_status) !== "MAPPED") current.unmappedFeCount += 1;
    const associateId = normalized(row.provider_employee_id) || `NAME_${normalized(row.dropx_name || row.provider_employee_name)}`;
    if (associateId) {
      const people = associateMap(row.station_code);
      const person = people.get(associateId) ?? {
        assigned: null,
        associateId: String(row.provider_employee_id || "—"),
        delivered: 0,
        hasDetailedDelivery: false,
        name: String(row.dropx_name || row.provider_employee_name || row.provider_employee_id || "Unidentified associate"),
        paymentScheme: null,
        paymentSetupStatus: null,
        rateCard: null,
        totalPay: null
      };
      if (!person.hasDetailedDelivery) person.delivered += delivered;
      person.assigned = (person.assigned ?? 0) + (numberOrNull(row.assigned_count) ?? 0);
      person.name = String(row.dropx_name || row.provider_employee_name || person.name);
      person.paymentScheme = readablePayType(row.pay_type) ?? person.paymentScheme;
      person.paymentSetupStatus = String(row.mapping_status || "").trim() || person.paymentSetupStatus;
      person.rateCard = associateRateCard(row as Record<string, unknown>) ?? person.rateCard;
      const totalPay = numberOrNull(row.da_total_pay);
      if (totalPay != null && (person.paymentScheme || person.rateCard || totalPay > 0)) person.totalPay = (person.totalPay ?? 0) + totalPay;
      people.set(associateId, person);
    }
  });
  stationCodes.forEach((code) => {
    const current = empty.get(code)!;
    const detailDrivers = detailFeByStation.get(code)?.size ?? 0;
    const shipmentDrivers = new Set((shipmentResult.data ?? []).filter((row) => row.station_code === code && row.provider_employee_id).map((row) => normalized(row.provider_employee_id))).size;
    current.activeFeCount = current.activeFeCount || detailDrivers || shipmentDrivers;
    if (!current.deliveredCount) current.deliveredCount = shipmentDeliveryByStation.get(code) ?? 0;
    if ((daCostByStation.get(code) ?? 0) > 0) current.salaryDaCost = daCostByStation.get(code) ?? 0;
    current.averageAllocation = current.activeFeCount ? current.deliveredCount / current.activeFeCount : null;
    current.salaryDaCps = current.deliveredCount ? current.salaryDaCost / current.deliveredCount : null;
    current.associateDeliveries = [...(associatesByStation.get(code)?.values() ?? [])]
      .map((person) => ({
        assigned: person.assigned,
        associateId: person.associateId,
        delivered: person.delivered,
        name: person.name,
        paymentScheme: person.paymentScheme,
        paymentSetupStatus: person.paymentSetupStatus,
        rateCard: person.rateCard,
        totalPay: person.totalPay
      }))
      .filter((person) => person.delivered > 0 || (person.assigned ?? 0) > 0)
      .sort((left, right) => right.delivered - left.delivered || left.name.localeCompare(right.name));
  });
  const deliveredMtdByStation = new Map<string, number>();
  (monthCapacityResult.data ?? []).forEach((row) => deliveredMtdByStation.set(row.station_code, (deliveredMtdByStation.get(row.station_code) ?? 0) + (numberOrNull(row.delivered) ?? 0)));
  stationCodes.forEach((code) => {
    const current = empty.get(code)!;
    if ((deliveredMtdByStation.get(code) ?? 0) > 0) current.mtdDelivery = deliveredMtdByStation.get(code) ?? current.mtdDelivery;
    current.mtdCps = current.mtdDelivery ? current.mtdCost / current.mtdDelivery : null;
  });
  try {
    const openings = await loadStationOpeningAttendance(companyId, sourceDate, locations,
      new Map(locations.map((location) => {
        const current = empty.get(location.station_code)!;
        return [location.id, { start: current.openingWindowStart, end: current.openingWindowEnd }];
      })));
    for (const location of locations) {
      const opening = openings.get(location.id);
      const current = empty.get(location.station_code)!;
      const other = opening?.firstOtherPunch;
      if (other) current.openingFirstOtherPunch = {
        time: other.time, name: other.name || other.workerCode || `Biometric ID ${other.enrolmentId}`,
        profileLabel: other.profileLabel || "Unverified profile", workerCode: other.workerCode || `Biometric ID ${other.enrolmentId}`
      };
      const punch = opening?.peoplePunch;
      if (!punch) continue;
      current.firstPunchAt = punch.time;
      current.firstPunchBy = punch.name || punch.workerCode || `Biometric ID ${punch.enrolmentId}`;
      current.openingLateMinutes = stationOpeningLateMinutes(
        istClockMinutes(punch.time), current.scheduledOpeningTime, current.openingWindowStart
      );
    }
  } catch (error) {
    return { rows: new Map<string, PerformanceOperationalSnapshot>(), error: error instanceof Error ? error.message : "Station opening attendance is unavailable." };
  }
  (paymentsResult.data ?? []).filter(isApprovedPayment).forEach((row) => {
    const code = normalized(row.station_code || row.location_code);
    const current = empty.get(code);
    if (!current) return;
    const amount = numberOrNull(row.amount_approved) ?? numberOrNull(row.amount) ?? numberOrNull(row.amount_requested) ?? 0;
    current.adHocCost = (current.adHocCost ?? 0) + amount;
    const head = adHocHeadById.get(row.payment_head_id);
    const category = adHocCategory(head ?? { code: null, name: null });
    const request = { amount, category, head: head?.name || head?.code || "Ad-hoc request", reason: paymentReason(row), requestNo: row.request_no || "Request" };
    if (category === "Van") {
      current.adHocVanCost += amount;
      current.adHocVanRequests.push(request);
    } else {
      current.adHocDaCost += amount;
      current.adHocDaRequests.push(request);
    }
  });
  return { rows: empty, error: null };
}

export async function resolvePerformanceReviewChain(companyId: string, stationId: string, _authorization?: AuthorizationContext): Promise<PerformanceReviewChainStep[]> {
  if (!supabaseAdmin) return [];
  const hierarchy = await loadPeopleOperationalHierarchy(companyId, [stationId]);
  if (hierarchy.error) throw new Error(hierarchy.error);
  const stationHierarchy = hierarchy.byLocation.get(stationId);
  const peopleChain = managerReviewChain(stationHierarchy?.managerReportingChain.length
    ? stationHierarchy.managerReportingChain : stationHierarchy?.primaryReportingChain ?? []);
  if (!peopleChain.length) return [];
  const userByPerson = await loadReviewUserLinks(supabaseAdmin,companyId,peopleChain.map(person=>person.personId));
  return peopleChain.map((person) => ({
    reviewerName: person.name,
    reviewerRole: person.role,
    reviewerUserId: userByPerson.get(person.personId) ?? null
  }));
}

export async function loadReviewStationLeads(companyId: string, stationId: string) {
  const hierarchy = await loadPeopleOperationalHierarchy(companyId, [stationId]);
  if (hierarchy.error) return "Station TL · unavailable";
  const leads = hierarchy.byLocation.get(stationId)?.stationLeads ?? [];
  return leads.length ? leads.map(person => `${person.name} · ${person.role}`).join(", ") : "Station TL · not assigned in People";
}
