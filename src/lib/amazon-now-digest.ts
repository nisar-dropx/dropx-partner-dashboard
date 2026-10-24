import type { SupabaseClient } from "@supabase/supabase-js";
import type { DigestBuilder, DigestControl } from "./portal-digest-delivery";
import { adHocOpsRoles, isAmazonNowMailStation, loadAdHocMailScope } from "./adhoc-digest-scope";
import { allRoutingRows, syncPeopleReviewRoutes } from "./ops-pulse/people-review-routing";
import { progress as shiftProgress, normalizeSettings as shiftSettings, nextShift, type SiChecklist } from "./ops-pulse/si-handover/model";
import { progress as storeProgress, normalizeSettings as storeSettings, type StoreOpsChecklist } from "./ops-pulse/store-ops/model";
import { periodCompletions } from "./ops-pulse/store-ops/server";
import { renderNowDigest, shiftDay, type NowDigestRow } from "./amazon-now-digest-view";
export const nowDigestEvents = ["now_review_digest", "now_activity_digest"] as const;
export type NowDigestEvent = typeof nowDigestEvents[number];
export function defaultNowControl(company: string, event: NowDigestEvent, domain: string): DigestControl {
  return { company_id: company, portal: "ops", event_key: event, state: "disabled", paused_until: null,
    subject_template: `Amazon Now · ${event === "now_review_digest" ? "Store review" : "Activities & handover"} | {{month}} {{year}}`,
    config: { data_label: event === "now_review_digest" ? "D−2 review data" : "Previous day and older pending handovers", schedule_time: event === "now_review_digest" ? "19:00" : "07:15", timezone: "Asia/Kolkata", day_offset: 0, thread_mode: "monthly", delivery_window_minutes: 90, email_domain: domain, delivery_ready: false, send_zero_cases: true,
      recipient_role_codes: [...adHocOpsRoles].filter(r => !["OPERATIONS_FLTM", "OPERATIONS_TL", "OPERATIONS_SSA"].includes(r)), manager_reminder: "" } };
}
export async function loadNowMailScope(db: SupabaseClient, control: DigestControl) {
  const domain = String(control.config.email_domain || "");
  if (!domain) throw Error("Company email domain is not configured.");
  const roles = Array.isArray(control.config.recipient_role_codes) ? control.config.recipient_role_codes.map(String) : [];
  if (!roles.length) throw Error("Configure operations recipient roles.");
  return loadAdHocMailScope(db, control.company_id, domain, [], { stationFilter: isAmazonNowMailStation, roleCodes: roles });
}
const query = (db: SupabaseClient, table: string, company: string, select = "*") => db.from(table).select(select).eq("company_id", company);
export const buildAmazonNowDigest: DigestBuilder = async (db, control, date) => {
  const scope = await loadNowMailScope(db, control);
  if (!scope.stations.length) throw Error("No active Amazon Now stores are configured.");
  if (!scope.recipients.length) throw Error("No eligible operations recipients are configured.");
  const ids = scope.stations.map(s => s.id), codes = scope.stations.map(s => s.station_code);
  const review = control.event_key === "now_review_digest", dataDate = shiftDay(date, review ? -2 : -1);
  const checkedAt = new Date().toISOString();
  const rows: NowDigestRow[] = [];
  if (review) {
    await syncPeopleReviewRoutes(control.company_id, { stationCodes: codes, from: dataDate, to: dataDate }, db);
    const [reviews, facts] = await Promise.all([
      allRoutingRows(query(db, "ops_performance_reviews", control.company_id).in("station_id", ids).eq("source_date", dataDate).eq("review_type", "daily_operations").eq("source_type", "qc_store_health_daily").order("id")),
      allRoutingRows(query(db, "report_metric_facts", control.company_id, "station_code,values_json,created_at").in("station_code", codes).eq("report_date", dataDate).eq("source_type", "qc_store_health_daily").order("created_at", { ascending: false }).order("id"))
    ]);
    const reviewIds = reviews.map(r => r.id);
    const steps: any[] = [], actions: any[] = [];
    for (let i = 0; i < reviewIds.length; i += 100) {
      const [s, a] = await Promise.all([
        allRoutingRows(query(db, "ops_performance_review_steps", control.company_id).in("review_id", reviewIds.slice(i,i+100)).is("route_superseded_at", null).order("step_order").order("id")),
        allRoutingRows(query(db, "ops_performance_followups", control.company_id).in("review_id", reviewIds.slice(i,i+100)).order("id"))
      ]); steps.push(...s); actions.push(...a);
    }
    for (const station of scope.stations) {
      const r = reviews.find(r => r.station_id === station.id), fact = facts.find(f => f.station_code === station.station_code);
      const pending = steps.filter(s => s.review_id === r?.id && s.status === "pending");
      const openActions = actions.filter(a => a.review_id === r?.id && !["closed", "completed", "cancelled"].includes(a.status));
      const complete = r?.status === "closed";
      const status = !fact ? "D−2 data missing" : !r ? "Review not started" : complete ? "Review complete" : "Review in progress";
      rows.push({ id: station.id, code: station.station_code, name: station.station_name || "", cells: [fact?.values_json?.score_pct != null ? `${fact.values_json.score_pct}% · ${fact.values_json.band || ""}` : "—", status,
        r?.routing_error ? "People mapping needs attention" : pending[0] ? `${pending[0].proxy_reviewer_name || pending[0].reviewer_name} · ${pending[0].reviewer_role}` : complete ? "—" : "Start / check review route",
        `${openActions.length} open${openActions.some(a => a.due_date && a.due_date < date) ? " · overdue actions" : ""}`], attention: !complete || !fact || openActions.length > 0,
        href: `/performance/review-status?from=${dataDate}&to=${dataDate}&station=${encodeURIComponent(station.id)}` });
    }
  } else {
    const [sm, dm, shifts, days] = await Promise.all([
      query(db, "ops_si_handover_master", control.company_id).maybeSingle(), query(db, "ops_store_ops_master", control.company_id).maybeSingle(),
      allRoutingRows(query(db, "ops_si_shift_checklists", control.company_id).in("location_id", ids).is("deleted_at", null).lte("shift_date", dataDate).or(`shift_date.eq.${dataDate},status.in.(open,submitted,rejected)`).neq("status","cancelled").order("shift_date").order("id")),
      allRoutingRows(query(db, "ops_store_ops_checklists", control.company_id).in("location_id", ids).is("deleted_at", null).lte("work_date", dataDate).or(`work_date.eq.${dataDate},status.eq.open`).neq("status","cancelled").order("work_date").order("id"))
    ]);
    if (sm.error || dm.error || !sm.data || !dm.data) throw Error("Activities masters could not be checked.");
    const ss = shiftSettings(sm.data.settings), ds = storeSettings(dm.data.settings);
    for (const station of scope.stations) {
      const stationShifts = shifts.filter(s => s.location_id === station.id) as SiChecklist[];
      const stationDays = days.filter(d => d.location_id === station.id) as StoreOpsChecklist[];
      const todayShifts = stationShifts.filter(s => s.shift_date === dataDate);
      const expected = ss.shiftSlots.filter(slot => nextShift(dataDate, slot as SiChecklist["shift_slot"], ss.shiftSlots).startMs <= Date.parse(checkedAt));
      const missing = expected.filter(slot => !todayShifts.some(s => s.shift_slot === slot));
      const open = stationShifts.filter(s => ["open", "rejected"].includes(s.status));
      const awaiting = stationShifts.filter(s => s.status === "submitted");
      const d = stationDays.find(d => d.work_date === dataDate);
      let completion = d?.status === "submitted" ? "Submitted" : "Not started";
      if (d?.status === "open") {
        const period = await periodCompletions(control.company_id, station.id, dataDate, d.id);
        const p = storeProgress(d, { city: station.city, settings: ds, weeklyDoneIds: period.weeklyDone, monthlyDoneIds: period.monthlyDone });
        completion = `${p.answered}/${p.total} required · not submitted`;
      }
      const older = stationDays.filter(d => d.work_date < dataDate && d.status === "open").length;
      const pendingNames = [...new Set([...open.map(s => s.outgoing_name), ...awaiting.map(s => s.incoming_name || "Incoming SI not assigned"), ...(d?.status === "open" ? [d.owner_name] : [])].filter(Boolean))];
      const latestOpen = open.at(-1), p = latestOpen && shiftProgress(latestOpen, { city: station.city, settings: ss });
      const shiftCell = `${todayShifts.filter(s => s.status === "accepted").length}/${expected.length} accepted${missing.length ? ` · ${missing.length} not started` : ""}${p ? ` · latest ${p.answered}/${p.total} answered` : ""}`;
      rows.push({ id: station.id, code: station.station_code, name: station.station_name || "", cells: [completion + (older ? ` · ${older} older open` : ""), shiftCell,
        `${awaiting.length} awaiting acceptance · ${open.length} open / returned`, pendingNames.length ? pendingNames.slice(0,3).join(", ") + (pendingNames.length > 3 ? ` +${pendingNames.length-3}` : "") : missing.length || !d ? "Store manager / assigned SI" : "—"],
        attention: !d || d.status !== "submitted" || Boolean(missing.length || open.length || awaiting.length || older), href: `/si-handover/report?from=${dataDate}&to=${dataDate}` });
    }
  }
  return { checkedAt, messages: scope.recipients.map(recipient => {
    const selected = rows.filter(r => recipient.stationIds.includes(r.id)).sort((a,b) => Number(b.attention)-Number(a.attention) || a.code.localeCompare(b.code));
    const rendered = renderNowDigest({ review, rows: selected, date, dataDate, checkedAt, name: recipient.name, subjectTemplate: control.subject_template || "", reminder: String(control.config.manager_reminder || "") });
    return { email: recipient.email, name: recipient.name, ...rendered, scope: { stationIds: selected.map(r=>r.id), dataDate, pending: selected.filter(r=>r.attention).length } };
  }).filter(m => control.config.send_zero_cases === true || m.scope.pending > 0) };
};
