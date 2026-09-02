import type { AuthorizationContext } from "@/lib/authorization";
import type { CodLocationRow } from "@/lib/ops-pulse/cod";
import { supabaseAdmin } from "@/lib/supabase-admin";

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
};

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
};

export type PerformanceOperationalSnapshot = {
  adHocCost: number | null;
  adHocDaCost: number;
  adHocDaRequests: PerformanceCostRequest[];
  adHocVanCost: number;
  adHocVanRequests: PerformanceCostRequest[];
  activeFeCount: number;
  averageAllocation: number | null;
  costBreakdown: PerformanceCostBreakdown[];
  dailyCps: number | null;
  dayCost: number | null;
  deliveredCount: number;
  firstPunchAt: string | null;
  firstPunchBy: string | null;
  openingWindowEnd: string;
  openingWindowStart: string;
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
type RoleRelation = { code?: string | null; name?: string | null };

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

function clockMinutes(value: string | null | undefined) {
  const match = String(value ?? "").match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60 ? hours * 60 + minutes : null;
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

function isWithinOpeningWindow(value: string | null, start: string, end: string) {
  const minute = istClockMinutes(value);
  const from = clockMinutes(start);
  const to = clockMinutes(end);
  if (minute == null || from == null || to == null) return false;
  return from <= to ? minute >= from && minute <= to : minute >= from || minute <= to;
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
      .eq("company_id", companyId).eq("source_date", sourceDate).in("station_code", stationCodes),
    supabaseAdmin.from("ops_performance_reviews")
      .select("id,station_code,source_date,status,review_summary,closed_at,updated_at")
      .eq("company_id", companyId).in("station_code", stationCodes).lt("source_date", sourceDate).order("source_date", { ascending: false }).limit(200)
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
      ? supabaseAdmin.from("ops_performance_review_steps").select("id,review_id,step_order,reviewer_user_id,reviewer_name,reviewer_role,status,feedback,completed_at").eq("company_id", companyId).in("review_id", selectedReviewIds).order("step_order")
      : Promise.resolve({ data: [] as PerformanceReviewStep[], error: null }),
    itemReviewIds.length
      ? supabaseAdmin.from("ops_performance_review_items").select("id,review_id,metric_key,metric_label,actual_value,target_value,target_direction,severity,root_cause,corrective_action,action_owner,due_date,status,created_at,updated_at").eq("company_id", companyId).in("review_id", itemReviewIds).order("created_at", { ascending: false }).limit(1000)
      : Promise.resolve({ data: [] as PerformanceReviewItem[], error: null }),
    selectedReviewIds.length
      ? supabaseAdmin.from("ops_performance_review_updates").select("id,review_id,review_item_id,update_type,note,created_at,created_by").eq("company_id", companyId).in("review_id", selectedReviewIds).order("created_at", { ascending: false }).limit(500)
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

function isAdHocHead(head: { code: string | null; name: string | null }) {
  const candidate = `${normalized(head.code)}_${normalized(head.name)}`;
  return candidate.includes("ADHOC") || candidate.includes("AD_HOC") || candidate.includes("SPOT_MANPOWER");
}

function adHocCategory(head: { code: string | null; name: string | null }): PerformanceCostRequest["category"] {
  const candidate = `${normalized(head.code)}_${normalized(head.name)}`;
  if (candidate.includes("VAN") || candidate.includes("VEHICLE")) return "Van";
  if (candidate.includes("_DA") || candidate.includes("DRIVER") || candidate.includes("ASSOCIATE") || candidate.includes("MANPOWER")) return "DA";
  return "Other";
}

function paymentReason(row: { remarks?: string | null; notes?: string | null; details?: unknown }) {
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

function isApprovedPayment(request: { status: string | null; approval_status: string | null; current_approver_user_id: string | null; current_approver_role_id: string | null }) {
  const status = normalized(request.status);
  const approval = normalized(request.approval_status);
  if ([status, approval].some((value) => ["REJECTED", "RETURNED", "CANCELLED"].includes(value))) return false;
  if ([status, approval].some((value) => ["APPROVED", "PROCESSING", "PROCESSED", "PAID"].includes(value))) return true;
  return (status.endsWith("_APPROVED") || approval.endsWith("_APPROVED"))
    && !request.current_approver_user_id && !request.current_approver_role_id;
}

export async function loadPerformanceOperationalSnapshots(companyId: string, sourceDate: string, locations: CodLocationRow[]) {
  const empty = new Map<string, PerformanceOperationalSnapshot>();
  if (!supabaseAdmin || !locations.length) return { rows: empty, error: supabaseAdmin ? null : "Database service is unavailable." };
  const stationCodes = locations.map((location) => location.station_code);
  const locationIds = locations.map((location) => location.id);
  const monthFrom = `${sourceDate.slice(0, 7)}-01`;
  const [costResult, monthCostResult, breakupResult, shipmentResult, detailResult, capacityResult, monthCapacityResult, attendanceResult, headsResult, openingResult] = await Promise.all([
    supabaseAdmin.from("cps_station_daily")
      .select("station_code,total_delivery,total_cost,overall_cps,da_pay_cost,da_cps").eq("company_id", companyId).eq("work_date", sourceDate).in("station_code", stationCodes),
    supabaseAdmin.from("cps_station_daily")
      .select("station_code,total_delivery,total_cost").eq("company_id", companyId).gte("work_date", monthFrom).lte("work_date", sourceDate).in("station_code", stationCodes),
    supabaseAdmin.from("cps_cost_breakup_daily")
      .select("station_code,head,sub_head,source,amount,count,cps").eq("company_id", companyId).eq("work_date", sourceDate).in("station_code", stationCodes),
    supabaseAdmin.from("cps_shipment_daily")
      .select("station_code,provider_employee_id,total_delivery,assigned_count,variable_pay,mg_pay,fuel_pay,da_total_pay,mapping_status")
      .eq("company_id", companyId).eq("work_date", sourceDate).in("station_code", stationCodes),
    supabaseAdmin.from("delivered_shipment_facts")
      .select("station_code,driver_id,package_count").eq("company_id", companyId).eq("work_date", sourceDate).in("station_code", stationCodes),
    supabaseAdmin.from("capacity_station_daily_cache")
      .select("station_code,delivered,active_ids").eq("company_id", companyId).eq("work_date", sourceDate).in("station_code", stationCodes),
    supabaseAdmin.from("capacity_station_daily_cache")
      .select("station_code,delivered").eq("company_id", companyId).gte("work_date", monthFrom).lte("work_date", sourceDate).in("station_code", stationCodes),
    supabaseAdmin.from("attendance_daily")
      .select("location_id,station_code,in_time,worker_name,employee_code").eq("company_id", companyId).eq("punch_date", sourceDate).in("location_id", locationIds).not("in_time", "is", null).order("in_time"),
    supabaseAdmin.from("payment_heads").select("id,code,name").eq("company_id", companyId),
    supabaseAdmin.from("ops_performance_station_settings")
      .select("station_id,opening_window_start,opening_window_end").eq("company_id", companyId).in("station_id", locationIds)
  ]);
  const error = costResult.error ?? monthCostResult.error ?? breakupResult.error ?? shipmentResult.error ?? detailResult.error ?? capacityResult.error ?? monthCapacityResult.error ?? attendanceResult.error ?? headsResult.error ?? openingResult.error;
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
    averageAllocation: null,
    costBreakdown: [],
    dailyCps: null,
    dayCost: null,
    deliveredCount: 0,
    firstPunchAt: null,
    firstPunchBy: null,
    openingWindowEnd: opening.end,
    openingWindowStart: opening.start,
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
  const detailFeByStation = new Map<string, Set<string>>();
  (detailResult.data ?? []).forEach((row) => {
    const current = empty.get(row.station_code);
    if (!current) return;
    current.deliveredCount += numberOrNull(row.package_count) ?? 1;
    const drivers = detailFeByStation.get(row.station_code) ?? new Set<string>();
    if (row.driver_id) drivers.add(normalized(row.driver_id));
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
  (shipmentResult.data ?? []).forEach((row) => {
    const current = empty.get(row.station_code);
    if (!current) return;
    if (!current.deliveredCount) current.deliveredCount += numberOrNull(row.total_delivery) ?? 0;
    current.variableDaPay += numberOrNull(row.variable_pay) ?? 0;
    current.mgSalaryPay += numberOrNull(row.mg_pay) ?? 0;
    current.fuelPay += numberOrNull(row.fuel_pay) ?? 0;
    daCostByStation.set(row.station_code, (daCostByStation.get(row.station_code) ?? 0) + (numberOrNull(row.da_total_pay) ?? 0));
    if (normalized(row.mapping_status) !== "MAPPED") current.unmappedFeCount += 1;
  });
  stationCodes.forEach((code) => {
    const current = empty.get(code)!;
    const detailDrivers = detailFeByStation.get(code)?.size ?? 0;
    const shipmentDrivers = new Set((shipmentResult.data ?? []).filter((row) => row.station_code === code && row.provider_employee_id).map((row) => normalized(row.provider_employee_id))).size;
    current.activeFeCount = current.activeFeCount || detailDrivers || shipmentDrivers;
    if ((daCostByStation.get(code) ?? 0) > 0) current.salaryDaCost = daCostByStation.get(code) ?? 0;
    current.averageAllocation = current.activeFeCount ? current.deliveredCount / current.activeFeCount : null;
    current.salaryDaCps = current.deliveredCount ? current.salaryDaCost / current.deliveredCount : null;
  });
  const deliveredMtdByStation = new Map<string, number>();
  (monthCapacityResult.data ?? []).forEach((row) => deliveredMtdByStation.set(row.station_code, (deliveredMtdByStation.get(row.station_code) ?? 0) + (numberOrNull(row.delivered) ?? 0)));
  stationCodes.forEach((code) => {
    const current = empty.get(code)!;
    if ((deliveredMtdByStation.get(code) ?? 0) > 0) current.mtdDelivery = deliveredMtdByStation.get(code) ?? current.mtdDelivery;
    current.mtdCps = current.mtdDelivery ? current.mtdCost / current.mtdDelivery : null;
  });
  const codeByLocation = new Map(locations.map((location) => [location.id, location.station_code]));
  (attendanceResult.data ?? []).forEach((row) => {
    const code = codeByLocation.get(row.location_id) ?? normalized(row.station_code);
    const current = empty.get(code);
    if (!current || current.firstPunchAt || !isWithinOpeningWindow(row.in_time, current.openingWindowStart, current.openingWindowEnd)) return;
    current.firstPunchAt = row.in_time;
    current.firstPunchBy = row.worker_name || row.employee_code || "Recorded employee";
  });
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

function roleText(role: Relation<RoleRelation>, fallback = "Reviewer") {
  const resolved = one(role);
  return String(resolved?.name || resolved?.code || fallback).trim();
}

function rolePriority(value: string) {
  const text = normalized(value);
  if (text.includes("TEAM_LEAD") || text === "TL") return 0;
  if (text.includes("STATION_MANAGER") || text.includes("HUB_INCHARGE")) return 1;
  if (text === "LOCATION" || text.includes("LOCATION_ACCOUNT")) return 2;
  if (text.includes("SSA") || text.includes("SUPPORT_ASSOCIATE")) return 3;
  if (text.includes("CLUSTER")) return 4;
  return 10;
}

export async function resolvePerformanceReviewChain(companyId: string, stationId: string, authorization: AuthorizationContext): Promise<PerformanceReviewChainStep[]> {
  if (!supabaseAdmin) return [];
  const day = new Date().toISOString().slice(0, 10);
  const [positionsResult, assignmentsResult, profilesResult] = await Promise.all([
    supabaseAdmin.from("org_positions")
      .select("id,name,reports_to_position_id,location_access_mode,location_scope_ids,user_roles(name,code)")
      .eq("company_id", companyId).eq("is_active", true),
    supabaseAdmin.from("position_assignments")
      .select("position_id,profile_id,assignment_type,valid_from,valid_until,is_active")
      .eq("company_id", companyId).eq("is_active", true),
    supabaseAdmin.from("profiles")
      .select("id,full_name,reports_to_user_id,location_scope_ids,is_active,user_roles(name,code)")
      .eq("company_id", companyId).eq("is_active", true)
  ]);
  if (profilesResult.error) throw new Error(profilesResult.error.message);
  const profiles = profilesResult.data ?? [];
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));

  if (!positionsResult.error && !assignmentsResult.error && (positionsResult.data ?? []).length) {
    const positions = positionsResult.data ?? [];
    const positionById = new Map(positions.map((position) => [position.id, position]));
    const assignments = (assignmentsResult.data ?? []).filter((assignment) => assignment.valid_from <= day && (!assignment.valid_until || assignment.valid_until >= day));
    const occupantByPosition = new Map<string, typeof assignments[number]>();
    [...assignments].sort((left, right) => Number(left.assignment_type === "permanent") - Number(right.assignment_type === "permanent")).forEach((assignment) => {
      if (!occupantByPosition.has(assignment.position_id)) occupantByPosition.set(assignment.position_id, assignment);
    });
    const starts = positions.filter((position) => (
      position.location_access_mode !== "all_locations"
      && (position.location_scope_ids ?? []).includes(stationId)
    )).sort((left, right) => rolePriority(`${left.name} ${roleText(left.user_roles)}`) - rolePriority(`${right.name} ${roleText(right.user_roles)}`));
    const start = starts.find((position) => occupantByPosition.has(position.id) && rolePriority(`${position.name} ${roleText(position.user_roles)}`) < 5)
      ?? starts.find((position) => rolePriority(`${position.name} ${roleText(position.user_roles)}`) < 5);
    if (start) {
      const chain: PerformanceReviewChainStep[] = [];
      const seen = new Set<string>();
      let current: typeof start | undefined = start;
      while (current && chain.length < 7 && !seen.has(current.id)) {
        seen.add(current.id);
        const assignment = occupantByPosition.get(current.id);
        const profile = assignment ? profileById.get(assignment.profile_id) : null;
        const reviewerRole = roleText(current.user_roles, current.name);
        if (profile) chain.push({ reviewerName: profile.full_name || "Assigned reviewer", reviewerRole, reviewerUserId: profile.id });
        if (/national head|owner/i.test(reviewerRole)) break;
        current = current.reports_to_position_id ? positionById.get(current.reports_to_position_id) : undefined;
      }
      if (chain.length) return chain;
    }
  }

  const starts = profiles.filter((profile) => (profile.location_scope_ids ?? []).includes(stationId)).sort((left, right) => (
    rolePriority(roleText(left.user_roles)) - rolePriority(roleText(right.user_roles))
  ));
  const start = starts.find((profile) => rolePriority(roleText(profile.user_roles)) < 5) ?? starts[0];
  if (start) {
    const chain: PerformanceReviewChainStep[] = [];
    const seen = new Set<string>();
    let current: typeof start | undefined = start;
    while (current && chain.length < 7 && !seen.has(current.id)) {
      seen.add(current.id);
      const reviewerRole = roleText(current.user_roles);
      chain.push({ reviewerName: current.full_name || "Assigned reviewer", reviewerRole, reviewerUserId: current.id });
      if (/national head|owner/i.test(reviewerRole)) break;
      current = current.reports_to_user_id ? profileById.get(current.reports_to_user_id) : undefined;
    }
    if (chain.length) return chain;
  }

  return [{ reviewerName: authorization.fullName || "Review owner", reviewerRole: authorization.roleName || "Reviewer", reviewerUserId: authorization.userId }];
}
