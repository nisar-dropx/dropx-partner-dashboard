import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PerformanceStationFilter } from "@/components/performance-station-filter";
import { AmazonWeekNavigator } from "@/components/amazon-week-navigator";
import { PerformanceSortControl } from "@/components/performance-sort-control";
import { PerformanceWorkspaceTabs } from "@/components/performance-workspace-tabs";
import { PerformanceReviewDesk, type ReviewMetric } from "@/components/performance-review-desk";
import "./review-desk.css";
import { hasPermission, requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { formatDashboardDate, formatDashboardDateTime } from "@/lib/date-format";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { resolveOperatingContext } from "@/lib/ops-pulse/operating-context";
import { loadPerformanceTargets, resolvePerformanceTargets, type PerformanceTarget } from "@/lib/performance-targets";
import { loadStationReviewTargets, emptyStationReviewTargets } from "@/lib/ops-pulse/station-review-targets-data";
import { hawkeyeMetricDefinitions, hawkeyeTargetKey, hawkeyeValue, hawkeyeValueForTarget } from "@/lib/ops-pulse/hawkeye";
import { loadPerformanceOperationalSnapshots, loadPerformanceReviewWorkspace, loadPerformanceReviewBacklog, loadPerformanceConnections, resolvePerformanceReviewChain, loadPerformanceFollowups, loadPerformanceNoonEmd, loadReviewStationLeads } from "@/lib/ops-pulse/performance-review";
import { reviewPendingPage } from "@/lib/ops-pulse/review-periods";
import { loadReviewCod } from "@/lib/ops-pulse/review-cod-data";
import { getReviewAccess } from "@/lib/ops-pulse/review-access";
import { legacyConnectionsFromReview } from "@/lib/ops-pulse/review-policy";
import { ACTIVE_DAILY_PERFORMANCE_SOURCE, ACTIVE_DAILY_PERFORMANCE_SOURCE_LABEL, selectActiveDailyBatchRows, selectStationDailyRow } from "@/lib/performance-source-policy";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

type SearchParams = { view?: string; week?: string; date?: string; from?: string; to?: string; stations?: string; sort?: string; trend?: string; review?: string; notice?: string; error?: string; pendingPage?: string };
type MetricFact = {
  batch_id: string;
  source_type: string;
  report_year: number | null;
  report_week: number | null;
  report_date: string | null;
  station_code: string | null;
  row_label: string | null;
  raw_text: string | null;
  values_json: unknown;
  created_at: string;
};
type ShipmentFact = {
  work_date: string;
  station_code: string;
  amazon_delivery: number | string | null;
  c_return: number | string | null;
  mfn: number | string | null;
  mfn_return: number | string | null;
  total_delivery: number | string | null;
};

function today() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

function dateShift(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function validDate(value: string | undefined, fallback: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value ?? "") ? String(value) : fallback;
}

function number(value: unknown) {
  return Number(value ?? 0);
}

function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function standing(raw: string | null) {
  return raw?.match(/\b(FANTASTIC|GREAT|FAIR|POOR)\b/i)?.[1]?.toUpperCase() ?? "—";
}

function isStandingLabel(value: string | null) {
  return /^(FANTASTIC|GREAT|FAIR|POOR)$/i.test(String(value ?? "").trim());
}

function stationCode(value: string | null) {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function metricValues(row: MetricFact) {
  if (Array.isArray(row.values_json)) return row.values_json.map(number);
  if (row.values_json && typeof row.values_json === "object") {
    const payload = row.values_json as Record<string, unknown>;
    const nested = payload.values ?? payload.metrics ?? payload.data;
    if (Array.isArray(nested)) return nested.map(number);
    const numbered = Object.entries(payload)
      .filter(([key]) => /^\d+$/.test(key))
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([, value]) => number(value));
    if (numbered.length) return numbered;
  }
  return [];
}

function dailyMetricValue(row: MetricFact, metric: { metricKey: string; index: number }) {
  return row.source_type === "amazon_hawkeye_daily"
    ? hawkeyeValueForTarget(row.values_json, metric.metricKey)
    : metricValues(row)[metric.index] ?? null;
}

function ragStatus(value: number | null, target: number | null, direction: string) {
  if (value == null || target == null) return "neutral";
  if (direction === "higher") {
    if (value >= target) return "green";
    if (value >= target * .95) return "amber";
    return "red";
  }
  if (value <= target) return "green";
  if (value <= Math.max(target * 2, target + .005)) return "amber";
  return "red";
}

function targetLabel(target: number | null, direction: string) {
  return target == null ? "Reference" : `${direction === "higher" ? "≥" : "≤"} ${percent(target)}`;
}

function slsTargetLabel(metric: PerformanceTarget) {
  if (metric.target == null) return "Reference";
  if (metric.unit === "dpmo") return `${metric.direction === "higher" ? "≥" : "≤"} ${metric.target.toLocaleString("en-IN")} DPMO`;
  if (metric.unit === "ratio") return `${metric.direction === "higher" ? "≥" : "≤"} ${(metric.target * 100).toFixed(0)}% of goal`;
  return targetLabel(metric.target, metric.direction);
}

function slsWeightedAttainment(values: number[], definitions: PerformanceTarget[]) {
  const mapped = definitions.filter((metric) => metric.sourceIndex != null && metric.target != null);
  const availableWeight = mapped.reduce((sum, metric) => sum + metric.weight, 0);
  const achievedWeight = mapped.reduce((sum, metric) => {
    const value = values[metric.sourceIndex as number] ?? 0;
    return sum + (ragStatus(value, metric.target, metric.direction) === "green" ? metric.weight : 0);
  }, 0);
  return { achievedWeight, availableWeight, percentage: availableWeight ? Math.round(achievedWeight / availableWeight * 100) : 0 };
}

function weekDates(year: number, week: number) {
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const firstSunday = new Date(yearStart);
  firstSunday.setUTCDate(firstSunday.getUTCDate() - firstSunday.getUTCDay());
  const start = new Date(firstSunday);
  start.setUTCDate(start.getUTCDate() + (week - 1) * 7);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function amazonWeekNumber(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const firstSunday = new Date(yearStart);
  firstSunday.setUTCDate(firstSunday.getUTCDate() - firstSunday.getUTCDay());
  return Math.floor((date.getTime() - firstSunday.getTime()) / 604800000) + 1;
}

function trendPath(values: number[], width = 240, height = 62) {
  if (!values.length) return "";
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const padding = Math.max((maximum - minimum) * .2, .01);
  const floor = Math.max(0, minimum - padding);
  const ceiling = Math.min(1, maximum + padding);
  const range = Math.max(.01, ceiling - floor);
  return values.map((value, index) => {
    const x = values.length === 1 ? width / 2 : index / (values.length - 1) * width;
    const y = height - Math.max(0, Math.min(1, (value - floor) / range)) * (height - 12) - 6;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

export default async function PerformancePage({ searchParams }: { searchParams?: SearchParams }) {
  const view = searchParams?.view === "sls" ? "sls" : searchParams?.view === "reviews" ? "reviews" : "daily";
  const authorization = await requirePagePermission(view === "reviews" ? "performance_review" : "performance", "access");
  const companyId = requireCompanyId(authorization);
  const targetResult = await loadPerformanceTargets(companyId);
  const allDailyTargets = resolvePerformanceTargets(targetResult.rows, "daily");
  const dailyMetricDefinitions = allDailyTargets.filter((target) => target.sourceIndex != null).map((target) => ({ ...target, index: target.sourceIndex as number }));
  const orderedDailyMetricDefinitions = [...dailyMetricDefinitions].sort((left, right) =>
    Number(right.metricKey === "dsr") - Number(left.metricKey === "dsr") || left.displayOrder - right.displayOrder
  );
  const dsrMetric = dailyMetricDefinitions.find((metric) => metric.metricKey === "dsr");
  const dsrIndex = dsrMetric?.index ?? 20;
  const slsMetricDefinitions = resolvePerformanceTargets(targetResult.rows, "sls");
  const locationsResult = await loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
  const context = resolveOperatingContext(locationsResult.locations);
  // Review Desk / Station Performance must use every authorised station for the
  // active operating model. Do not inherit the Command Center single-station
  // Scope cookie (dropx-ops-locations), or managers with full access only see
  // whichever location was last focused in OpsPulse.
  const permittedLocations = context.modeLocations;
  const permittedByCode = new Map(permittedLocations.map((location) => [stationCode(location.station_code), location]));
  const permittedCodes = permittedLocations.map((location) => location.station_code);
  const requestedCodes = String(searchParams?.stations ?? "")
    .split(",")
    .map((code) => stationCode(code))
    .map((code) => permittedByCode.get(code)?.station_code)
    .filter((code): code is string => Boolean(code));
  const selectedCodes = requestedCodes.length ? [...new Set(requestedCodes)] : permittedCodes;
  const selectedCodeSet = new Set(selectedCodes.map(stationCode));
  const sameStation = (left: string | null | undefined, right: string | null | undefined) => stationCode(left ?? null) === stationCode(right ?? null);
  const defaultDailyDate = dateShift(today(), -1);
  const selectedDate = validDate(searchParams?.date, validDate(searchParams?.to, defaultDailyDate));
  const selectedDailyWeek = amazonWeekNumber(selectedDate);
  const selectedDailyWeekRange = weekDates(Number(selectedDate.slice(0, 4)), selectedDailyWeek);
  const trendFrom = selectedDailyWeekRange.start;
  const trendTo = selectedDailyWeekRange.end < defaultDailyDate ? selectedDailyWeekRange.end : defaultDailyDate;
  const metricSelect = "batch_id,source_type,report_year,report_week,report_date,station_code,row_label,raw_text,values_json,created_at";
  const metricQuery = !supabaseAdmin || !selectedCodes.length
    ? null
    : view === "daily" || view === "reviews"
      ? supabaseAdmin.from("report_metric_facts")
        .select(metricSelect)
        .eq("company_id", companyId)
        .in("station_code", selectedCodes)
        .eq("source_type", ACTIVE_DAILY_PERFORMANCE_SOURCE)
        .gte("report_date", trendFrom)
        .lte("report_date", trendTo)
        .order("created_at", { ascending: false })
        .limit(5000)
      : supabaseAdmin.from("report_metric_facts")
        .select(metricSelect)
        .eq("company_id", companyId)
        .in("station_code", selectedCodes)
        .eq("source_type", "edsp_sls_scorecard")
        .order("created_at", { ascending: false })
        .limit(5000);
  // One-day fetch so stations omitted from the week-window limit still get today's Hawkeye row.
  const selectedDayMetricQuery = !supabaseAdmin || !selectedCodes.length || (view !== "daily" && view !== "reviews")
    ? null
    : supabaseAdmin.from("report_metric_facts")
      .select(metricSelect)
      .eq("company_id", companyId)
      .in("station_code", selectedCodes)
      .eq("source_type", ACTIVE_DAILY_PERFORMANCE_SOURCE)
      .eq("report_date", selectedDate)
      .order("created_at", { ascending: false })
      .limit(5000);

  const [metricResult, dayMetricResult, shipmentResult, dateCoverageResult, latestDailyResult] = !supabaseAdmin || !selectedCodes.length
    ? [
      { data: [] as MetricFact[], error: null },
      { data: [] as MetricFact[], error: null },
      { data: [] as ShipmentFact[], error: null },
      { data: [] as Array<Pick<MetricFact, "batch_id" | "created_at" | "report_date" | "station_code">>, error: null },
      { data: [] as Array<Pick<MetricFact, "report_date">>, error: null }
    ]
    : await Promise.all([
      metricQuery!,
      selectedDayMetricQuery ?? Promise.resolve({ data: [] as MetricFact[], error: null }),
      supabaseAdmin.from("cps_shipment_daily")
        .select("work_date,station_code,amazon_delivery,c_return,mfn,mfn_return,total_delivery")
        .eq("company_id", companyId).in("station_code", selectedCodes)
        .eq("work_date", selectedDate),
      supabaseAdmin.from("report_metric_facts")
        .select("batch_id,created_at,report_date,station_code")
        .eq("company_id", companyId)
        .eq("source_type", ACTIVE_DAILY_PERFORMANCE_SOURCE)
        .eq("report_date", selectedDate)
        .not("station_code", "is", null)
        .limit(2000),
      supabaseAdmin.from("report_metric_facts")
        .select("report_date")
        .eq("company_id", companyId)
        .eq("source_type", ACTIVE_DAILY_PERFORMANCE_SOURCE)
        .not("report_date", "is", null)
        .order("report_date", { ascending: false })
        .limit(1)
    ]);

  const mergedFacts = [...(dayMetricResult.data ?? []), ...(metricResult.data ?? [])] as MetricFact[];
  const seenFactKeys = new Set<string>();
  const allFacts = mergedFacts.filter((row) => {
    const key = `${row.batch_id}|${row.station_code}|${row.report_date}|${row.created_at}`;
    if (seenFactKeys.has(key)) return false;
    seenFactKeys.add(key);
    return true;
  });  const scopedFacts = allFacts.filter((row) => !row.station_code || selectedCodeSet.has(stationCode(row.station_code)));
  const availableWeeks = [...new Set(scopedFacts.filter((row) => row.source_type === "edsp_sls_scorecard" && row.report_week).map((row) => Number(row.report_week)))].sort((a, b) => b - a);
  const selectedWeek = Number(searchParams?.week) || availableWeeks[0] || 1;
  const stationQuery = selectedCodes.length === permittedCodes.length ? "" : `&stations=${encodeURIComponent(selectedCodes.join(","))}`;
  const currentWeek = amazonWeekNumber(today());
  const slsCandidates = scopedFacts.filter((row) => {
    const values = metricValues(row);
    return row.source_type === "edsp_sls_scorecard" && Number(row.report_week) === selectedWeek && row.station_code && selectedCodeSet.has(stationCode(row.station_code)) && values.length > 2 && values[1] > 0 && values[1] <= 1;
  });
  const latestSlsBatch = slsCandidates[0]?.batch_id ?? null;
  const latestSlsBatchRows = latestSlsBatch ? slsCandidates.filter((row) => row.batch_id === latestSlsBatch) : [];
  const slsByStation = new Map<string, MetricFact>();
  latestSlsBatchRows.forEach((row) => {
    const code = stationCode(row.station_code);
    const existing = slsByStation.get(code);
    if (!existing) {
      slsByStation.set(code, row);
      return;
    }
    const quality = (candidate: MetricFact) => {
      const values = metricValues(candidate);
      const populatedMetrics = values.slice(1, 22).filter((value) => value !== 0).length;
      return (isStandingLabel(candidate.row_label) ? 0 : 100) + Math.min(values.length, 30) + populatedMetrics;
    };
    if (quality(row) > quality(existing)) slsByStation.set(code, row);
  });
  const slsRows = [...slsByStation.values()];
  const suppressedSlsRows = Math.max(0, latestSlsBatchRows.length - slsRows.length);
  const dailyCandidates = scopedFacts.filter((row) => {
    return row.source_type === ACTIVE_DAILY_PERFORMANCE_SOURCE
      && row.station_code && selectedCodeSet.has(stationCode(row.station_code))
      && Boolean(hawkeyeValue(row.values_json, "AFN Std PDD DSR%") != null);
  });
  const reportDay = (row: MetricFact) => row.report_date;
  const { rows: dailyRows } = selectActiveDailyBatchRows(dailyCandidates, selectedDate);
  const selectedDailyReportDate = dailyRows[0] ? reportDay(dailyRows[0]) : null;
  const dateCoverageRows = dateCoverageResult.data ?? [];
  const sourceDatesInRange = [...new Set(dateCoverageRows.map((row) => row.report_date).filter(Boolean) as string[])].sort();
  const sourceStationsInRange = [...new Set(dateCoverageRows.map((row) => stationCode(row.station_code)).filter(Boolean))].sort();
  const sourceReportExists = dateCoverageRows.length > 0;
  const latestAvailableDate = latestDailyResult.data?.[0]?.report_date ?? null;
  const dailySort = searchParams?.sort || "exceptions_desc";
  const metricSort = dailySort.match(/^metric_(\d+)_(asc|desc)$/);
  const missedTargets = (row: MetricFact) => (row.source_type === "amazon_hawkeye_daily" ? allDailyTargets : dailyMetricDefinitions).filter((metric) => {
    const value = row.source_type === "amazon_hawkeye_daily" ? hawkeyeValueForTarget(row.values_json,metric.metricKey) : dailyMetricValue(row,{...metric,index:metric.sourceIndex!});
    return value != null && metric.target != null && ragStatus(value, metric.target, metric.direction) !== "green";
  }).length;
  const sortedDailyRows = [...dailyRows].sort((a, b) => {
    if (metricSort) {
      const metric = dailyMetricDefinitions.find((candidate) => candidate.index === Number(metricSort[1]));
      const difference = metric ? (dailyMetricValue(a, metric) ?? 0) - (dailyMetricValue(b, metric) ?? 0) : 0;
      return metricSort[2] === "asc" ? difference : -difference;
    }
    if (dailySort === "exceptions_desc") return missedTargets(b) - missedTargets(a);
    if (dailySort === "station_desc") return String(b.station_code).localeCompare(String(a.station_code));
    if (dailySort === "dsr_low") return (dsrMetric ? dailyMetricValue(a, dsrMetric) ?? 0 : 0) - (dsrMetric ? dailyMetricValue(b, dsrMetric) ?? 0 : 0);
    if (dailySort === "dsr_high") return (dsrMetric ? dailyMetricValue(b, dsrMetric) ?? 0 : 0) - (dsrMetric ? dailyMetricValue(a, dsrMetric) ?? 0 : 0);
    return String(a.station_code).localeCompare(String(b.station_code));
  });
  const slsSort = searchParams?.sort || "score_desc";
  const sortedSlsRows = [...slsRows].sort((a, b) => {
    if (slsSort === "station_asc") return String(a.station_code).localeCompare(String(b.station_code));
    if (slsSort === "station_desc") return String(b.station_code).localeCompare(String(a.station_code));
    if (slsSort === "score_asc") return metricValues(a)[1] - metricValues(b)[1];
    return metricValues(b)[1] - metricValues(a)[1];
  });
  const missingDsrStations = dsrMetric ? dailyRows.filter((row) => Number(dailyMetricValue(row, dsrMetric) ?? 0) === 0).length : 0;
  const metricSortHref = (index: number) => {
    const nextDirection = dailySort === `metric_${index}_asc` ? "desc" : "asc";
    const params = new URLSearchParams({ view: "daily", date: selectedDate, sort: `metric_${index}_${nextDirection}` });
    if (selectedCodes.length !== permittedCodes.length) params.set("stations", selectedCodes.join(","));
    if (searchParams?.trend) params.set("trend", searchParams.trend);
    return `/performance?${params.toString()}`;
  };
  const shipments = (shipmentResult.data ?? []) as ShipmentFact[];
  const locationByCode = new Map(permittedLocations.map((location) => [stationCode(location.station_code), location]));
  const shipmentMap = new Map<string, { delivered: number; cReturn: number; mfn: number; mfnReturn: number; total: number }>();
  shipments.forEach((row) => {
    const code = stationCode(row.station_code);
    const current = shipmentMap.get(code) ?? { delivered: 0, cReturn: 0, mfn: 0, mfnReturn: 0, total: 0 };
    current.delivered += number(row.amazon_delivery);
    current.cReturn += number(row.c_return);
    current.mfn += number(row.mfn);
    current.mfnReturn += number(row.mfn_return);
    current.total += number(row.total_delivery);
    shipmentMap.set(code, current);
  });
  const weekRange = weekDates(Number(selectedDate.slice(0, 4)), selectedWeek);
  const averageSls = slsRows.length ? slsRows.reduce((total, row) => total + metricValues(row)[1], 0) / slsRows.length : 0;
  const standingCounts = ["FANTASTIC", "GREAT", "FAIR", "POOR"].map((label) => ({ label, count: slsRows.filter((row) => standing(row.raw_text) === label).length }));
  const maxStanding = Math.max(...standingCounts.map((entry) => entry.count), 1);
  const totalDelivered = shipments.reduce((total, row) => total + number(row.amazon_delivery), 0);
  const totalCReturn = shipments.reduce((total, row) => total + number(row.c_return), 0);
  const totalMfn = shipments.reduce((total, row) => total + number(row.mfn), 0);
  const coveredStationCodes = new Set(dailyRows.map((row) => stationCode(row.station_code)));
  const missingStationCodes = selectedCodes.filter((code) => !coveredStationCodes.has(stationCode(code)));
  const latestLoadAt = [...dailyRows.map((row) => row.created_at), ...dateCoverageRows.map((row) => row.created_at)].sort().at(-1) ?? null;
  const actionRows = [...dailyRows].filter((row) => missedTargets(row) > 0).sort((a, b) => missedTargets(b) - missedTargets(a)).slice(0, 5);
  const averageDsrValues = dsrMetric ? dailyRows.map((row) => dailyMetricValue(row, dsrMetric) ?? 0).filter((value) => value > 0) : [];
  const averageDsr = averageDsrValues.length ? averageDsrValues.reduce((sum, value) => sum + value, 0) / averageDsrValues.length : null;
  const dateLink = (value: string) => `/performance?view=daily&date=${value}${stationQuery}${searchParams?.trend ? `&trend=${encodeURIComponent(searchParams.trend)}` : ""}`;
  const historyByStationDate = new Map<string, MetricFact>();
  dailyCandidates.forEach((row) => {
    const date = reportDay(row);
    const code = stationCode(row.station_code);
    if (!date || date < trendFrom || date > trendTo) return;
    const key = `${code}|${date}`;
    if (!historyByStationDate.has(key)) historyByStationDate.set(key, row);
  });
  const requestedTrendCode = stationCode(searchParams?.trend ?? null);
  const defaultTrendCode = stationCode(sortedDailyRows[0]?.station_code ?? selectedCodes[0] ?? null);
  const trendStationCode = selectedCodeSet.has(requestedTrendCode) ? requestedTrendCode : defaultTrendCode;
  const trendStationRows = [...historyByStationDate.values()]
    .filter((row) => stationCode(row.station_code) === trendStationCode)
    .sort((left, right) => String(left.report_date).localeCompare(String(right.report_date)));
  const trendMetricKeys = ["dsr", "dot_premium", "dot_standard", "dds_premium", "dds_standard"];
  const trendMetrics = trendMetricKeys.map((key) => dailyMetricDefinitions.find((metric) => metric.metricKey === key)).filter((metric): metric is typeof dailyMetricDefinitions[number] => Boolean(metric));
  const trendStationLocation = locationByCode.get(trendStationCode);
  const trendHref = (code: string) => `/performance?view=daily&date=${selectedDate}${stationQuery}&trend=${encodeURIComponent(code)}#daily-trend`;
  const requestedReviewCode = stationCode(searchParams?.review ?? null);
  const selectedReviewLocation = permittedLocations.find((location) => stationCode(location.station_code) === requestedReviewCode) ?? permittedLocations[0] ?? null;
  const reviewWorkspace = selectedReviewLocation
    ? await loadPerformanceReviewWorkspace(companyId, selectedDate, view === "reviews" ? permittedCodes : [selectedReviewLocation.station_code])
    : { settings: null, reviews: [], previousReviews: [], steps: [], items: [], updates: [], error: "No permitted station is available." };
  const operationalResult = selectedReviewLocation
    ? await loadPerformanceOperationalSnapshots(companyId, selectedDate, [selectedReviewLocation])
    : { rows: new Map(), error: "No permitted station is available." };
  const selectedReviewRow = selectedReviewLocation
    ? selectStationDailyRow(
      scopedFacts.filter((row) => row.source_type === ACTIVE_DAILY_PERFORMANCE_SOURCE),
      selectedDate,
      selectedReviewLocation.station_code,
      stationCode
    )
      ?? dailyRows.find((row) => sameStation(row.station_code, selectedReviewLocation.station_code))
      ?? null
    : null;
  const reviewMetrics: ReviewMetric[] = selectedReviewRow?.source_type === "amazon_hawkeye_daily"
    ? hawkeyeMetricDefinitions.map((definition) => {
      const target = allDailyTargets.find((metric) => metric.metricKey === hawkeyeTargetKey(definition));
      const actual = hawkeyeValue(selectedReviewRow.values_json, definition.label);
      return { actual, direction: target?.direction ?? "higher", key: definition.targetKey || definition.label.toLowerCase().replace(/[^a-z0-9]+/g, "_"), label: definition.label, severity: ragStatus(actual, target?.target ?? null, target?.direction ?? "higher") as ReviewMetric["severity"], short: definition.short, target: target?.target ?? null };
    })
    : selectedReviewRow
      ? orderedDailyMetricDefinitions.map((metric) => ({ actual: dailyMetricValue(selectedReviewRow, metric), direction: metric.direction, key: metric.metricKey, label: metric.label, severity: ragStatus(dailyMetricValue(selectedReviewRow, metric), metric.target, metric.direction) as ReviewMetric["severity"], short: metric.short, target: metric.target }))
      : [];
  const selectedReview = selectedReviewLocation
    ? reviewWorkspace.reviews.find((review) =>
      review.station_id === selectedReviewLocation.id || sameStation(review.station_code, selectedReviewLocation.station_code)
    ) ?? null
    : null;
  const selectedSnapshot = selectedReviewLocation
    ? operationalResult.rows.get(selectedReviewLocation.station_code)
      ?? [...operationalResult.rows.entries()].find(([code]) => sameStation(code, selectedReviewLocation.station_code))?.[1]
      ?? null
    : null;
  const canViewReviews = hasPermission(authorization, "performance_review", "access");
  // Prefer the selected station row — review.station_id can diverge and hide saved timings.
  const connectionStationId = selectedReviewLocation?.id || selectedReview?.station_id || null;
  const [connectionResult, reviewChain, backlog, followups, noonEmd, stationLeads, codData, stationTargets] = selectedReviewLocation && connectionStationId && view === "reviews" ? await Promise.all([
    loadPerformanceConnections(companyId, connectionStationId, selectedDate),
    selectedReview ? Promise.resolve([]) : resolvePerformanceReviewChain(companyId, selectedReviewLocation.id),
    loadPerformanceReviewBacklog(companyId, selectedDate, permittedCodes, reviewPendingPage(searchParams?.pendingPage)),
    loadPerformanceFollowups(companyId,connectionStationId,selectedDate),
    loadPerformanceNoonEmd(companyId,connectionStationId,selectedDate),
    loadReviewStationLeads(companyId,connectionStationId),
    loadReviewCod(companyId,selectedReviewLocation.station_code),
    loadStationReviewTargets(companyId,[connectionStationId])
  ]) : [{connections:[],error:null},[],{rows:[],count:0,page:1,pageSize:15,error:null},{rows:[],count:0,error:null},{row:null,error:null},"Station TL",{snapshot:{stationCode:"",batchId:null,importedAt:null,fileName:null,summary:null,error:null},lines:[]},{rows:[],error:null}];
  const reviewConnections = connectionResult.connections.length
    ? connectionResult.connections
    : legacyConnectionsFromReview(selectedReview);
  const reviewAccess = selectedReviewLocation && view === "reviews" ? await getReviewAccess(authorization,selectedReviewLocation.id,selectedReview,
    selectedReview ? reviewWorkspace.steps.filter(step=>step.review_id===selectedReview.id) : reviewChain.map((step,index)=>({step_order:index+1,reviewer_user_id:step.reviewerUserId,reviewer_role:step.reviewerRole,status:"pending"}))) : null;

  return (
    <AppShell active={view === "reviews" ? "Review Desk" : "Performance"} pageCode={view === "reviews" ? "performance_review" : "performance"}>
      <div className="ops-command-center performance-workspace">
        <PageHead eyebrow="Performance" title="Station Performance" subtitle="Daily metrics, weekly scorecards and delivery data." />
        <PerformanceWorkspaceTabs active={view} canViewReviews={canViewReviews} />
        {view !== "reviews" ? <div className="performance-local-filter-row">
          <PerformanceStationFilter stations={permittedLocations.map((location) => ({ code: location.station_code, name: location.station_name || location.city || location.station_code }))} selectedCodes={selectedCodes} view={view} date={selectedDate} week={selectedWeek} />
        </div> : null}

        {metricResult.error || dayMetricResult.error || shipmentResult.error || dateCoverageResult.error || latestDailyResult.error || targetResult.error ? <section className="panel message-panel error"><div className="panel-body">{metricResult.error?.message ?? dayMetricResult.error?.message ?? shipmentResult.error?.message ?? dateCoverageResult.error?.message ?? latestDailyResult.error?.message ?? targetResult.error}</div></section> : null}

        {view === "reviews" ? (
          selectedReviewLocation ? <PerformanceReviewDesk
            codSnapshot={codData.snapshot}
            canAdd={Boolean(reviewAccess?.canStart)}
            canCompleteStep={Boolean(reviewAccess?.canComplete)}
            canEdit={Boolean(reviewAccess?.canEditRca)}
            canEditConnections={Boolean(reviewAccess?.canEditConnections)}
            canComment={Boolean(reviewAccess?.canComment)}
            canBypass={Boolean(reviewAccess?.canBypass)}
            canProxy={Boolean(reviewAccess?.canProxy)}
            canAccessBypass={Boolean(reviewAccess?.canAccessBypass)}
            canAccessProxy={Boolean(reviewAccess?.canAccessProxy)}
            canManageActions={Boolean(reviewAccess?.canManageActions)}
            followups={followups}
            stationTargets={stationTargets.rows[0]?.targets ?? emptyStationReviewTargets}
            stationTargetsError={stationTargets.error}
            noonEmd={noonEmd}
            stationLeads={stationLeads}
            backlog={backlog}
            pendingExpanded={Boolean(searchParams?.pendingPage)}
            previousDay={defaultDailyDate}
            programManager={Boolean(reviewAccess?.actor.programManager)}
            connections={reviewConnections}
            updates={reviewWorkspace.updates}
            reviewChain={reviewChain}
            routingIssue={reviewAccess?.routingIssue ?? (!reviewChain.length && !selectedReview ? "A review manager needs to be assigned in People for this station. Contact HR so Proxy / Skip and RCA can run." : null)}
            date={selectedDate}
            error={searchParams?.error || reviewWorkspace.error || operationalResult.error || connectionResult.error || (!selectedReviewRow ? "No Amazon performance metrics are loaded for this station on this date. RCA exceptions appear after Hawkeye/EDSP data is imported." : null)}
            items={reviewWorkspace.items}
            locations={permittedLocations}
            metrics={reviewMetrics}
            notice={searchParams?.notice || null}
            previousReviews={reviewWorkspace.previousReviews}
            review={selectedReview}
            reviews={reviewWorkspace.reviews}
            selectedLocation={selectedReviewLocation}
            snapshot={selectedSnapshot ?? {
              adHocCost: null, adHocDaCost: 0, adHocDaRequests: [], adHocVanCost: 0, adHocVanRequests: [],
              activeFeCount: 0, associateDeliveries: [], averageAllocation: null, costBreakdown: [],
              dailyCps: null, dayCost: null, deliveredCount: 0, firstPunchAt: null, firstPunchBy: null,
              openingFirstOtherPunch: null, openingLateMinutes: null, openingShiftName: null, openingShiftSource: null,
              openingWindowEnd: "10:00:00", openingWindowStart: "02:00:00", scheduledOpeningTime: null,
              fuelPay: 0, mgSalaryPay: 0, mtdCost: 0, mtdCps: null, mtdDelivery: 0, overallCps: null,
              salaryDaCost: 0, salaryDaCps: null, unmappedFeCount: 0, variableDaPay: 0
            }}
            sourceBatchId={selectedReviewRow?.batch_id ?? null}
            sourceType={selectedReviewRow?.source_type ?? "operational_data"}
            sourceWeek={selectedDailyWeek}
            steps={reviewWorkspace.steps}
          /> : <section className="panel message-panel error"><div className="panel-body">No permitted station is available for review.</div></section>
        ) : view === "daily" ? (
          <>
            <section className="ops-control-strip performance-day-control">
              <div className="ops-context-summary"><span>Daily review</span><strong>{selectedDate.split("-").reverse().join("/")}</strong><small>{selectedCodes.length} permitted stations</small></div>
              <form className="ops-date-controls"><input type="hidden" name="view" value="daily" />{selectedCodes.length !== permittedCodes.length ? <input type="hidden" name="stations" value={selectedCodes.join(",")} /> : null}<label>Review date<input type="date" name="date" defaultValue={selectedDate} max={today()} /></label><button>View day</button></form>
            </section>
            <section className="performance-source-strip">
              <div><span>{ACTIVE_DAILY_PERFORMANCE_SOURCE_LABEL} source date</span><strong>{selectedDailyReportDate ? formatDashboardDate(selectedDailyReportDate) : (sourceDatesInRange.map((value) => formatDashboardDate(value)).join(", ") || "Not available")}</strong></div>
              <div><span>Loaded</span><strong>{formatDashboardDateTime(latestLoadAt, "—")}</strong></div>
              <div><span>Coverage</span><strong>{coveredStationCodes.size}/{selectedCodes.length} stations</strong></div>
              <nav>
                <Link href={dateLink(dateShift(selectedDate, -1))}>‹ Previous</Link>
                {latestAvailableDate ? <Link href={dateLink(latestAvailableDate)}>Latest report</Link> : null}
                {selectedDate < defaultDailyDate ? <Link href={dateLink(dateShift(selectedDate, 1))}>Next ›</Link> : null}
              </nav>
            </section>
            <section className="performance-summary-grid">
              <article><span>Delivered</span><strong>{totalDelivered.toLocaleString("en-IN")}</strong><small>Delivered packages</small></article>
              <article><span>C-Return</span><strong>{totalCReturn.toLocaleString("en-IN")}</strong><small>Customer returns</small></article>
              <article><span>MFN</span><strong>{totalMfn.toLocaleString("en-IN")}</strong><small>MFN activity</small></article>
              <article><span>Average DSR</span><strong>{averageDsr == null ? "—" : percent(averageDsr)}</strong><small>{averageDsrValues.length}/{dailyRows.length} station values</small></article>
            </section>
            {!dailyRows.length && sourceReportExists ? <section className="performance-data-warning"><div><strong>The {formatDashboardDate(selectedDate)} {ACTIVE_DAILY_PERFORMANCE_SOURCE_LABEL} report is loaded, but {selectedCodes.join(", ")} {selectedCodes.length === 1 ? "is" : "are"} not included.</strong><span>The source contains {sourceStationsInRange.length} station{sourceStationsInRange.length === 1 ? "" : "s"}. Delivery totals are independent and remain visible.</span></div><Link href={`/performance?view=daily&date=${selectedDate}&stations=${encodeURIComponent(sourceStationsInRange.slice(0, 2).join(","))}`}>View covered stations</Link></section> : null}
            {!dailyRows.length && !sourceReportExists ? <section className="performance-data-warning"><div><strong>No {ACTIVE_DAILY_PERFORMANCE_SOURCE_LABEL} report exists for {formatDashboardDate(selectedDate)}.</strong><span>{latestAvailableDate ? `Latest Hawkeye report is ${formatDashboardDate(latestAvailableDate)}. Delivery totals remain available for this day.` : "Upload the dated Amazon Hawkeye Daily Report to populate performance metrics."}</span></div>{latestAvailableDate ? <Link href={dateLink(latestAvailableDate)}>Open latest report</Link> : <a href="https://dashboard.dropxlogistics.com/imports">Open imports</a>}</section> : null}
            {missingDsrStations ? <section className="performance-data-warning"><div><strong>DSR/PSR source value is zero for {missingDsrStations} station{missingDsrStations === 1 ? "" : "s"}.</strong><span>The dashboard is preserving the uploaded report value. Upload a corrected Hawkeye report containing the metric; the system will not manufacture a replacement percentage.</span></div><a href="https://dashboard.dropxlogistics.com/imports">Open report imports</a></section> : null}
            {missingStationCodes.length && dailyRows.length ? <section className="performance-coverage-gap"><div><span>Missing stations</span><strong>{missingStationCodes.join(", ")}</strong></div><small>Selected stations absent from this source report.</small></section> : null}
            {trendStationCode ? <section className="panel performance-daily-trend" id="daily-trend">
              <div className="panel-head"><div><h2>Amazon Week {selectedDailyWeek} station trend</h2><p className="subtle">{trendStationCode} · {trendStationLocation?.station_name || trendStationLocation?.city || trendStationCode} · {selectedDailyWeekRange.start.split("-").reverse().join("/")}–{selectedDailyWeekRange.end.split("-").reverse().join("/")}</p></div><form className="performance-trend-station-form"><input type="hidden" name="view" value="daily"/><input type="hidden" name="date" value={selectedDate}/>{selectedCodes.length !== permittedCodes.length ? <input type="hidden" name="stations" value={selectedCodes.join(",")}/> : null}<label>Station<select name="trend" defaultValue={trendStationCode}>{selectedCodes.map((code) => <option key={code} value={code}>{code} · {locationByCode.get(stationCode(code))?.station_name || locationByCode.get(stationCode(code))?.city || code}</option>)}</select></label><button>View trend</button></form></div>
              {trendStationRows.length ? <div className="performance-trend-grid">{trendMetrics.map((metric) => {
                const points = trendStationRows.map((row) => dailyMetricValue(row, metric) ?? 0);
                const first = points[0] ?? 0;
                const latest = points.at(-1) ?? 0;
                const delta = latest - first;
                const improving = metric.direction === "higher" ? delta > .0005 : delta < -.0005;
                const declining = metric.direction === "higher" ? delta < -.0005 : delta > .0005;
                return <article key={metric.metricKey}><header><span>{metric.short}</span><strong>{percent(latest)}</strong><i className={improving ? "up" : declining ? "down" : "flat"}>{improving ? "↑ Improving" : declining ? "↓ Declining" : "— Stable"} · {delta >= 0 ? "+" : ""}{(delta * 100).toFixed(1)} pp</i></header><svg preserveAspectRatio="none" viewBox="0 0 240 62"><polyline fill="none" points={trendPath(points)}/></svg><footer>{trendStationRows.map((row) => <span key={`${metric.metricKey}-${row.report_date}`} title={`${formatDashboardDate(row.report_date)}: ${percent(dailyMetricValue(row, metric) ?? 0)}`}>{String(row.report_date).slice(8)}</span>)}</footer><small>Target {targetLabel(metric.target, metric.direction)}</small></article>;
              })}</div> : <div className="empty-state">No Hawkeye D-1 history is available for this station in Amazon Week {selectedDailyWeek}.</div>}
            </section> : null}
            {actionRows.length ? <section className="panel performance-action-queue"><div className="panel-head"><div><h2>Action queue</h2><p className="subtle">Highest target misses for {selectedDate.split("-").reverse().join("/")}.</p></div><strong>{actionRows.length} priorities</strong></div><div className="table-wrap"><table><thead><tr><th>Station</th><th>City</th><th>Missed targets</th><th>DSR</th><th></th></tr></thead><tbody>{actionRows.map((row) => {
              const code = stationCode(row.station_code);
              return <tr key={`action-${row.batch_id}-${row.station_code}`}><td><strong>{code}</strong></td><td>{row.row_label || "—"}</td><td><span className="station-attention risk">{missedTargets(row)} misses</span></td><td>{percent(dsrMetric ? dailyMetricValue(row, dsrMetric) ?? 0 : 0)}</td><td><Link href={trendHref(code)}>Trend →</Link></td></tr>;
            })}</tbody></table></div></section> : null}
            <section className="panel performance-matrix-panel">
              <div className="panel-head"><div><h2>Daily performance review</h2><p className="subtle">DSR follows volume. Red needs action, amber is near target and green is achieved.</p></div><div className="panel-head-tools"><strong>{dailyRows.length} stations</strong><PerformanceSortControl value={dailySort} options={[{ label: "Most misses first", value: "exceptions_desc" }, { label: "Station A–Z", value: "station_asc" }, { label: "Station Z–A", value: "station_desc" }, { label: "Lowest DSR first", value: "dsr_low" }, { label: "Highest DSR first", value: "dsr_high" }]} /></div></div>
              <div className="performance-matrix-wrap">
                <table className="performance-matrix">
                  <thead><tr><th className="sticky-rank">#</th><th className="sticky-station">Station</th><th>Review</th><th>Delivered</th><th>C-Return</th><th>MFN</th>{orderedDailyMetricDefinitions.map((metric) => <th key={metric.label} title={metric.label}><span className="metric-sort-heading"><span>{metric.short}</span><Link aria-label={`Sort ${metric.label} ${dailySort === `metric_${metric.index}_asc` ? "descending" : "ascending"}`} className={dailySort.startsWith(`metric_${metric.index}_`) ? "active" : ""} href={metricSortHref(metric.index)} title={`Sort ${dailySort === `metric_${metric.index}_asc` ? "descending" : "ascending"}`}>{dailySort === `metric_${metric.index}_asc` ? "↑" : dailySort === `metric_${metric.index}_desc` ? "↓" : "↕"}</Link></span><small>{targetLabel(metric.target, metric.direction)}</small></th>)}</tr></thead>
                  <tbody>
                    {sortedDailyRows.map((row, index) => {
                      const normalizedCode = stationCode(row.station_code);
                      const shipment = shipmentMap.get(normalizedCode) ?? { delivered: 0, cReturn: 0, mfn: 0, mfnReturn: 0, total: 0 };
                      return <tr key={`${row.batch_id}-${row.station_code}`}>
                        <td className="sticky-rank">{index + 1}</td>
                        <td className="sticky-station"><strong>{normalizedCode}</strong><small>{row.row_label || "—"}</small><Link className="performance-row-trend-link" href={trendHref(normalizedCode)}>Trend</Link></td>
                        <td>{canViewReviews
                          ? <Link className="performance-row-review-link" href={`/performance?view=reviews&date=${selectedDate}&review=${normalizedCode}`}><strong className={missedTargets(row) ? "metric-bad-text" : "metric-good-text"}>{missedTargets(row)} missed</strong><span>Open review →</span></Link>
                          : <strong className={missedTargets(row) ? "metric-bad-text" : "metric-good-text"}>{missedTargets(row)} missed</strong>}</td>
                        <td>{shipment.delivered.toLocaleString("en-IN")}</td><td>{shipment.cReturn.toLocaleString("en-IN")}</td><td>{shipment.mfn.toLocaleString("en-IN")}</td>
                        {orderedDailyMetricDefinitions.map((metric) => {
                          const value = dailyMetricValue(row, metric);
                          const status = ragStatus(value, metric.target, metric.direction);
                          return <td key={metric.label} className={status === "neutral" ? "" : `metric-${status}`} title={`${metric.label} · Target ${targetLabel(metric.target, metric.direction)}`}>{value == null ? "—" : percent(value)}</td>;
                        })}
                      </tr>;
                    })}
                    {!dailyRows.length ? <tr><td colSpan={6 + orderedDailyMetricDefinitions.length} className="empty-cell">Daily performance data is not available for the selected date and stations. Delivery data remains available separately.</td></tr> : null}
                  </tbody>
                </table>
              </div>
            </section>
            {dailyRows.length ? <section className="panel hawkeye-full-scorecard">
              <div className="panel-head"><div><h2>Hawkeye complete metric view</h2><p className="subtle">All fields from Amazon’s D-1 station-level workbook. Expand a station for compact detail.</p></div><strong>{hawkeyeMetricDefinitions.length} fields</strong></div>
              <div className="hawkeye-station-stack">{sortedDailyRows.map((row) => {
                const code = stationCode(row.station_code);
                return <details key={`hawkeye-${row.batch_id}-${code}`} open={sortedDailyRows.length === 1}>
                  <summary><span><strong>{code}</strong><small>{row.row_label || "Station"}</small></span><b>{missedTargets(row)} configured misses</b></summary>
                  {canViewReviews ? <div className="hawkeye-station-actions"><Link href={`/performance?view=reviews&date=${selectedDate}&review=${code}`}>Open review →</Link></div> : null}
                  <div>{hawkeyeMetricDefinitions.map((metric) => {
                  const value = hawkeyeValue(row.values_json, metric.label);
                  const target = allDailyTargets.find((definition) => definition.metricKey === hawkeyeTargetKey(metric));
                  const status = ragStatus(value, target?.target ?? null, target?.direction ?? "higher");
                  return <article className={status} key={metric.label}><span>{metric.short}</span><strong>{value == null ? "—" : percent(value)}</strong><small>{target?.target == null ? "Reference" : targetLabel(target.target, target.direction)}</small></article>;
                })}</div></details>;
              })}</div>
            </section> : null}
          </>
        ) : (
          <>
            <section className="ops-control-strip">
              <div className="ops-context-summary"><span>Amazon SLS review</span><strong>Week {selectedWeek}</strong><small>{weekRange.start} to {weekRange.end} · Sunday–Saturday</small></div>
              <AmazonWeekNavigator selectedWeek={selectedWeek} currentWeek={currentWeek} stations={selectedCodes.length === permittedCodes.length ? "" : selectedCodes.join(",")} />
            </section>
            <section className="performance-summary-grid">
              <article><span>Average SLS score</span><strong>{percent(averageSls)}</strong><small>{slsRows.length} station scores</small></article>
              {standingCounts.slice(0, 3).map((entry) => <article key={entry.label}><span>{entry.label}</span><strong>{entry.count}</strong><small>Stations</small></article>)}
            </section>
            <section className="sls-review-stack">
              <article className="ops-visual-card sls-standing-card">
                <header><div><span>STANDING MIX</span><h2>Week {selectedWeek} distribution</h2></div></header>
                <div className="performance-standing-chart">{standingCounts.map((entry) => <div key={entry.label}><span>{entry.label}</span><i><b style={{ width: `${Math.max(3, entry.count / maxStanding * 100)}%` }} /></i><strong>{entry.count}</strong></div>)}</div>
              </article>
              <article className="ops-visual-card sls-ranking-card">
                <header><div><span>SLS SCORECARD</span><h2>Station ranking</h2></div><div className="panel-head-tools"><strong>{weekRange.start}–{weekRange.end}</strong><PerformanceSortControl value={slsSort} options={[{ label: "Highest SLS first", value: "score_desc" }, { label: "Lowest SLS first", value: "score_asc" }, { label: "Station A–Z", value: "station_asc" }, { label: "Station Z–A", value: "station_desc" }]} /></div></header>
                <div className="table-wrap"><table><thead><tr><th>Rank</th><th>Station</th><th>City</th><th>Standing</th><th>SLS score</th><th>Metrics achieved</th></tr></thead><tbody>
                  {sortedSlsRows.map((row, index) => {
                    const values = metricValues(row);
                    const weighted = slsWeightedAttainment(values, slsMetricDefinitions);
                    const code = stationCode(row.station_code);
                    const location = locationByCode.get(code);
                    return <tr key={`${row.batch_id}-${code}`}><td>{index + 1}</td><td><strong>{code}</strong></td><td>{location?.station_name || location?.city || row.row_label || "—"}</td><td><span className={`performance-standing ${standing(row.raw_text).toLowerCase()}`}>{standing(row.raw_text)}</span></td><td><strong>{percent(values[1])}</strong></td><td><strong>{weighted.percentage}%</strong><small className="achievement-count">{weighted.achievedWeight.toFixed(1)}/{weighted.availableWeight.toFixed(1)} mapped weight</small></td></tr>;
                  })}
                  {!slsRows.length ? <tr><td colSpan={6} className="empty-cell">Data not available for Week {selectedWeek}.</td></tr> : null}
                </tbody></table></div>
              </article>
              {suppressedSlsRows ? <div className="performance-data-note">{suppressedSlsRows} duplicate summary row{suppressedSlsRows === 1 ? "" : "s"} excluded from this week.</div> : null}
              <section className="sls-station-scorecards">
                {sortedSlsRows.map((row) => {
                  const values = metricValues(row);
                  const code = stationCode(row.station_code);
                  const location = locationByCode.get(code);
                  const weighted = slsWeightedAttainment(values, slsMetricDefinitions);
                  const achievement = weighted.percentage;
                  return <details className="sls-station-scorecard" key={`detail-${row.batch_id}-${code}`} open={slsRows.length === 1}>
                    <summary><div><span>{code}</span><strong>{location?.station_name || location?.city || row.row_label || code}</strong></div><div className="sls-score-summary"><span className={`performance-standing ${standing(row.raw_text).toLowerCase()}`}>{standing(row.raw_text)}</span><b>{percent(values[1])} SLS</b><i className={achievement >= 90 ? "green" : achievement >= 70 ? "amber" : "red"}>{achievement}% weighted attainment</i></div><em>⌄</em></summary>
                    <div className="sls-target-legend"><span><i className="green" /> Achieved</span><span><i className="amber" /> Near target</span><span><i className="red" /> Missed</span></div>
                    <div className="sls-target-grid">{slsMetricDefinitions.map((metric) => {
                      const value = metric.sourceIndex == null ? null : values[metric.sourceIndex] ?? 0;
                      const status = value == null ? "neutral" : ragStatus(value, metric.target, metric.direction);
                      return <article className={status} key={metric.label}><span>{metric.label}</span><strong>{value == null ? "Not mapped" : metric.unit === "dpmo" ? value.toLocaleString("en-IN") : value <= 1 ? percent(value) : value.toLocaleString("en-IN")}</strong><small>Target {slsTargetLabel(metric)} · Weight {metric.weight}%</small></article>;
                    })}</div>
                  </details>;
                })}
              </section>
            </section>
          </>
        )}
      </div>
    </AppShell>
  );
}
