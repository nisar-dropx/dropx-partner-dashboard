import { hawkeyeMetricDefinitions, hawkeyeTargetKey, hawkeyeValue } from "./hawkeye";
import { buildReviewEddTimeline, type ReviewEddPoint } from "./review-operations";
import { isDisciplineRcaKey } from "./review-discipline-rca";
import { isCodRemarkKey, codRemarkMoney } from "./review-cod-rca";
import type { PerformanceTarget } from "./performance-targets";

export type ReportCell = string | number | null;
export type ReportRow = Record<string, ReportCell>;
export type ReviewReportTable = { name: string; columns: string[]; rows: ReportRow[] };
export type ReviewReport = { from: string; to: string; generatedAt: string; stationCount: number; notes: string[]; tables: ReviewReportTable[] };
export type ReportSourceRow = Record<string, any>;
export type ReviewReportSources = Record<"reviews" | "items" | "steps" | "updates" | "followups" | "facts" | "connections" | "emd" | "costs" | "edd", ReportSourceRow[]>;
export type ReportStation = { id: string; station_code: string; station_name: string | null; cluster?: string | null };
export const REVIEW_REPORT_MAX_DAYS = 92;
export function reviewReportDates(from: string, to: string) {
  const valid = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
  const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
  if (!valid(from) || !valid(to) || days < 1 || days > REVIEW_REPORT_MAX_DAYS) throw Error(`Choose a valid date range of up to ${REVIEW_REPORT_MAX_DAYS} days.`);
  return Array.from({ length: days }, (_, i) => new Date(Date.parse(from) + i * 86400000).toISOString().slice(0, 10));
}
export function reportIst(value: unknown): string {
  if (!value) return "";
  const time = Date.parse(String(value));
  return Number.isFinite(time) ? `${new Date(time + 330 * 60000).toISOString().slice(0, 16).replace("T", " ")} IST` : String(value);
}
const number = (v: unknown) => v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
const text = (v: unknown) => v == null ? "" : String(v);
const pct = (v: number | null) => v == null ? "Not recorded" : `${(v * 100).toFixed(1)}%`;
const group = (rows: ReportSourceRow[], key: (r: ReportSourceRow) => string) => {
  const map = new Map<string, ReportSourceRow[]>();
  for (const row of rows) { const k = key(row); map.set(k, [...(map.get(k) ?? []), row]); }
  return map;
};
export function buildReviewReport(from: string, to: string, stations: ReportStation[], data: ReviewReportSources, targets: PerformanceTarget[], now = new Date()): ReviewReport {
  const tables: ReviewReportTable[] = [];
  function table(name: string, columns: string[]) { const item = { name, columns: ["Date", "Station", ...columns], rows: [] as ReportRow[] }; tables.push(item); return item.rows; }
  const summary = table("Review summary", ["Station name", "Cluster", "Review status", "Current reviewer", "Performance misses", "Saved RCA or reasons", "Missing performance RCA", "Open actions", "At station EDD cleared time", "Latest EDD pending", "EDD observation IST", "EMD at noon %", "Review takeaway", "Started IST", "Closed IST", "Last updated IST", "Source coverage"]);
  const metrics = table("Performance scorecard", ["Metric", "Actual", "Target", "Direction", "Result", "Source uploaded IST"]);
  const rca = table("RCA and reasons", ["Issue", "Type", "Actual", "Target", "Reason", "Corrective action", "Owner", "Due date", "Status", "Saved IST", "Carried from item"]);
  const actions = table("Action items", ["Action number", "Title", "Owner", "Due date", "Status", "Progress note", "Completed IST", "Updated by", "Updated IST"]);
  const stages = table("Review stages", ["Stage", "Reviewer", "Role", "Status", "Feedback", "Completed IST", "Proxy reviewer", "Proxy reason", "Bypassed by", "Bypass reason", "Bypassed IST"]);
  const discussion = table("Review discussion", ["Type", "Note", "Author", "Role", "Stage", "Created IST"]);
  const vehicles = table("Vehicle and EMD", ["Vehicle", "Arrival IST", "Unloading complete IST", "Updated by", "Updated IST", "EMD at noon %"]);
  const costs = table("Cost summary", ["Deliveries", "Total cost INR", "Daily CPS INR", "DA pay INR", "DA CPS INR", "UTR cost INR", "Van cost INR", "Fuel cost INR", "Rent cost INR", "Other cost INR", "Updated IST"]);
  const edd = table("EDD checkpoints", ["Checkpoint IST", "Day start EDD", "At station pending", "On road", "Delivered", "HFR", "Attempted", "Unverified", "Other", "Coverage", "Observed IST"]);
  const reviews = group(data.reviews, r => `${r.source_date}|${r.station_code}`);
  const facts = group(data.facts, r => `${r.report_date}|${r.station_code}`);
  const children = Object.fromEntries(["items", "steps", "updates", "followups"].map(k => [k, group(data[k as keyof ReviewReportSources], r => r.review_id)]));
  const stationSources = Object.fromEntries(["connections", "emd", "edd", "costs"].map(k => [k, group(data[k as keyof ReviewReportSources], r => `${r.service_date || r.source_date || r.work_date}|${r.station_id || r.station_code}`)]));
  for (const date of reviewReportDates(from, to).reverse()) for (const station of [...stations].sort((a, b) => a.station_code.localeCompare(b.station_code))) {
    const identity = { Date: date, Station: station.station_code };
    const add = (rows: ReportRow[], row: ReportRow) => rows.push({ ...identity, ...row });
    const key = `${date}|${station.station_code}`, idKey = `${date}|${station.id}`;
    const review = (reviews.get(key) ?? []).sort((a, b) => text(b.updated_at).localeCompare(text(a.updated_at)))[0];
    const fact = (facts.get(key) ?? []).sort((a, b) => text(b.created_at).localeCompare(text(a.created_at)) || text(b.id).localeCompare(text(a.id)))[0];
    const items = children.items.get(review?.id) ?? [];
    const stepRows = [...(children.steps.get(review?.id) ?? [])].sort((a, b) => Number(a.step_order) - Number(b.step_order));
    const followups = [...(children.followups.get(review?.id) ?? [])].sort((a, b) => Number(a.action_number) - Number(b.action_number));
    let misses = 0, missing = 0;
    if (fact) for (const definition of hawkeyeMetricDefinitions) {
      const target = targets.find(t => t.metricKey === hawkeyeTargetKey(definition));
      const actual = hawkeyeValue(fact.values_json, definition.label), goal = target?.target ?? null;
      const missed = actual != null && goal != null && (target?.direction === "lower" ? actual > goal : actual < goal);
      if (missed) {
        misses++;
        if (!items.some(i => i.metric_key === hawkeyeTargetKey(definition) && text(i.root_cause).trim())) missing++;
      }
      add(metrics, { Metric: definition.label, Actual: actual, Target: goal, Direction: goal == null ? "" : target?.direction === "lower" ? "At most" : "At least", Result: actual == null ? "Not recorded" : goal == null ? "Reference" : missed ? "Missed" : "Met", "Source uploaded IST": reportIst(fact.created_at) });
      if (missed && !items.some(i => i.metric_key === hawkeyeTargetKey(definition))) add(rca, { Issue: definition.label, Type: "Performance", Actual: pct(actual), Target: pct(goal), Reason: "Not entered", "Corrective action": "Not entered", Owner: "", "Due date": "", Status: "RCA needed", "Saved IST": "", "Carried from item": "" });
    }
    for (const item of items) {
      const cod = isCodRemarkKey(item.metric_key), delay = isDisciplineRcaKey(item.metric_key);
      const reasonOnly = cod || delay;
      const actual = number(item.actual_value);
      add(rca, { Issue: text(item.metric_label), Type: cod ? "COD remark only" : delay ? "Delay reason only" : "Performance", Actual: cod ? actual == null ? "Not recorded" : codRemarkMoney(actual) : delay ? `${item.actual_value} min late` : pct(actual), Target: cod ? "₹0 aged 2+ days" : delay ? "On time" : pct(number(item.target_value)), Reason: text(item.root_cause) || "Not entered", "Corrective action": reasonOnly ? "Not required" : text(item.corrective_action) || "Not entered", Owner: text(item.action_owner), "Due date": text(item.due_date), Status: text(item.status), "Saved IST": reportIst(item.updated_at), "Carried from item": text(item.carried_from_item_id) });
    }
    for (const item of followups) add(actions, { "Action number": number(item.action_number), Title: text(item.title), Owner: text(item.owner_label), "Due date": text(item.due_date), Status: text(item.status), "Progress note": text(item.progress_note), "Completed IST": reportIst(item.completed_at), "Updated by": text(item.updated_by_name), "Updated IST": reportIst(item.updated_at) });
    for (const item of stepRows) add(stages, { Stage: number(item.step_order), Reviewer: text(item.reviewer_name), Role: text(item.reviewer_role), Status: text(item.status), Feedback: text(item.feedback), "Completed IST": reportIst(item.completed_at), "Proxy reviewer": text(item.proxy_reviewer_name), "Proxy reason": text(item.proxy_reason), "Bypassed by": text(item.bypassed_by_name), "Bypass reason": text(item.bypass_reason), "Bypassed IST": reportIst(item.bypassed_at) });
    for (const item of [...(children.updates.get(review?.id) ?? [])].sort((a, b) => text(a.created_at).localeCompare(text(b.created_at)) || text(a.id).localeCompare(text(b.id)))) add(discussion, { Type: text(item.update_type), Note: text(item.note), Author: text(item.author_name), Role: text(item.author_role), Stage: text(item.stage_label), "Created IST": reportIst(item.created_at) });
    const emd = (stationSources.emd.get(idKey) ?? [])[0];
    for (const item of stationSources.connections.get(idKey) ?? []) add(vehicles, { Vehicle: text(item.label), "Arrival IST": reportIst(item.arrival_at), "Unloading complete IST": reportIst(item.unloading_at), "Updated by": text(item.updated_by_name), "Updated IST": reportIst(item.updated_at), "EMD at noon %": number(emd?.emd_noon_pct) });
    if (emd && !(stationSources.connections.get(idKey) ?? []).length) add(vehicles, { Vehicle: "No vehicle timings entered", "Arrival IST": "", "Unloading complete IST": "", "Updated by": text(emd.updated_by_name), "Updated IST": reportIst(emd.updated_at), "EMD at noon %": number(emd.emd_noon_pct) });
    const cost = (stationSources.costs.get(key) ?? [])[0];
    if (cost) add(costs, { Deliveries: number(cost.total_delivery), "Total cost INR": number(cost.total_cost), "Daily CPS INR": number(cost.overall_cps), "DA pay INR": number(cost.da_pay_cost), "DA CPS INR": number(cost.da_cps), "UTR cost INR": number(cost.utr_cost), "Van cost INR": number(cost.van_cost), "Fuel cost INR": number(cost.fuel_cost), "Rent cost INR": number(cost.rent_cost), "Other cost INR": number(cost.other_cost), "Updated IST": reportIst(cost.updated_at) });
    const points: ReviewEddPoint[] = (stationSources.edd.get(idKey) ?? []).map(r => ({ observedAt: r.observed_at, sourceAt: r.source_at, backlogAt: r.backlog_at, performanceAt: r.performance_at, counts: r.counts }));
    const timeline = buildReviewEddTimeline(date, points, now);
    // No observations: summary says missing; do not manufacture 37 zero rows.
    if (points.length) for (const row of timeline.rows) {
      const counts = row.state === "Recorded" ? row.point?.counts : null;
      add(edd, { "Checkpoint IST": row.label, "Day start EDD": row.dayStart, "At station pending": counts?.todayAtStation ?? null, "On road": counts?.todayOnRoad ?? null, Delivered: counts?.todayDelivered ?? null, HFR: counts?.todayHfr ?? null, HCR: counts?.todayHcr ?? null, "Observed INDUCTED / RECEIVED": counts?.todayObservedAtStation ?? null, Attempted: counts?.todayAttempted ?? null, Unverified: counts?.todayUnverified ?? null, Other: counts?.todayOther ?? null, Coverage: row.state, "Observed IST": reportIst(row.point?.observedAt) });
    }
    const current = stepRows.find(s => s.step_order === review?.current_step_order && s.status === "pending");
    add(summary, { "Station name": station.station_name || station.station_code, Cluster: station.cluster || "Unassigned", "Review status": !review ? "Not started" : review.status === "closed" ? "Completed" : "In progress", "Current reviewer": current ? `${current.reviewer_name} · ${current.reviewer_role}` : "", "Performance misses": fact ? misses : null, "Saved RCA or reasons": items.filter(i => text(i.root_cause).trim()).length, "Missing performance RCA": fact ? missing : null, "Open actions": followups.filter(f => f.status !== "done").length + items.filter(i => !isDisciplineRcaKey(i.metric_key) && i.status !== "done" && text(i.corrective_action).trim()).length, "At station EDD cleared time": timeline.summary, "Latest EDD pending": timeline.latestFresh ? timeline.latest?.counts.todayAtStation ?? null : null, "EDD observation IST": reportIst(timeline.latest?.observedAt), "EMD at noon %": number(emd?.emd_noon_pct), "Review takeaway": text(review?.review_summary), "Started IST": reportIst(review?.started_at), "Closed IST": reportIst(review?.closed_at), "Last updated IST": reportIst(review?.updated_at), "Source coverage": [!fact && "Scorecard not uploaded", !review && "Review not started", !points.length ? "EDD history not recorded" : !timeline.latestFresh && "EDD source stale or incomplete", !cost && "Cost source not loaded"].filter(Boolean).join("; ") || "Review, scorecard, EDD and cost sources available" });
  }
  return { from, to, generatedAt: now.toISOString(), stationCount: stations.length, tables, notes: [
    "Ops Pulse Review Summary · Standard format v1. Dates are performance dates; timestamps are IST. Only permitted selected stations are included.",
    "Saved RCA, reasons, action plans, review stages and comments are reproduced in full. Late opening / UTR entries need a reason only, not a corrective-action plan.",
    "Performance uses the latest Hawkeye upload for each station/date and current review targets. Saved RCA actual/target values remain as recorded; they may differ after a source correction.",
    "Attendance delay reasons are saved review evidence, not a recalculation of historical punch or leave records. Detailed attendance history remains available from each person's review drill-down.",
    "COD remarks apply to positive balances aged 2+ days, not 0–1 days. Saved COD amounts remain as originally recorded from the latest imported position when the exception was first saved, not a historical review-day balance. No action plan is required.",
    "EDD uses recorded observations only, with the same clearance rules as Review Desk. Missing intervals are not backfilled. A missing baseline or source is not zero pendency.",
    "Not started station-days and missing sources remain visible. Review completion does not close open action items. Export reads data only and does not start or update reviews.",
    "Cost values are the selected day's recorded CPS source, not a claim of complete cost mapping. No historical manual vehicle-clearance field is included."
  ] };
}
