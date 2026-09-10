import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import type { CodLocationRow } from "./cod";
import { ingestEddObservations, loadEddLedger } from "./edd-ledger";
import { summarizeStationEdd, stationEddToday } from "./station-edd";
import { loadOpsStationManpower } from "./station-manpower";
import { isPeopleDesignation } from "./station-opening-punches";
import { buildReviewEddTimeline, buildUtrDiscipline, normalizeReviewRouteCounts, type ReviewEddPoint, type ReviewRouteSnapshot } from "./review-operations";

/** Server components call this only after review permission + station scope resolution. */
export async function loadReviewEddHistory(companyId: string, stationId: string, stationCode: string, date: string) {
  try {
    if (!supabaseAdmin) throw Error("EDD history is unavailable.");
    const [result, routeResult] = await Promise.all([
      supabaseAdmin.from("ops_review_edd_observations")
        .select("observed_at,source_at,backlog_at,performance_at,counts")
        .eq("company_id", companyId).eq("station_id", stationId).eq("work_date", date)
        .order("observed_at").limit(300),
      supabaseAdmin.from("edd_performance_daily")
        .select("date,assigned,delivered,returned,held,yet_to_dispatch,updated_at")
        .eq("station_code", stationCode).eq("date", date).maybeSingle()
    ]);
    if (result.error) throw Error("EDD history could not be loaded. Please retry.");
    const points: ReviewEddPoint[] = (result.data ?? []).map(row => ({ observedAt: row.observed_at,
      sourceAt: row.source_at, backlogAt: row.backlog_at, performanceAt: row.performance_at, counts: row.counts }));
    const routeCounts = routeResult.data ? normalizeReviewRouteCounts({ workDate: String(routeResult.data.date),
      assigned: routeResult.data.assigned, delivered: routeResult.data.delivered, returned: routeResult.data.returned,
      held: routeResult.data.held, yetToDispatch: routeResult.data.yet_to_dispatch }, date) : null;
    const routeFinal: ReviewRouteSnapshot | null = routeCounts?.routeHasSnapshot && routeResult.data?.updated_at
      ? { ...routeCounts, observedAt: routeResult.data.updated_at, source: "daily" } : null;
    return { timeline: buildReviewEddTimeline(date, points, new Date(), routeFinal), error: null,
      routeError: routeResult.error ? "Complete out-on-road totals could not be loaded." : null };
  } catch (error) {
    return { timeline: buildReviewEddTimeline(date, []), error: error instanceof Error ? error.message : "EDD history unavailable.", routeError: null };
  }
}

export async function loadReviewUtrDiscipline(companyId: string, station: CodLocationRow, date: string) {
  try {
    if (!supabaseAdmin) throw Error("Attendance is unavailable.");
    const [manpower, designations, categories] = await Promise.all([
      loadOpsStationManpower(companyId, [station], date, { historical: true }),
      supabaseAdmin.from("designations").select("code,name,designation_category_id,onboarding_categories").eq("company_id", companyId),
      supabaseAdmin.from("designation_categories").select("id,people_module").eq("company_id", companyId)
    ]);
    if (designations.error || categories.error) throw Error("UTR role mapping could not be loaded.");
    const categoryById = new Map((categories.data ?? []).map(c => [c.id, c.people_module]));
    const normalized = (value: string | null) => (value ?? "").trim().toLowerCase();
    const people = manpower.people.flatMap(person => {
      const designation = (designations.data ?? []).find(d => [d.code, d.name].some(value => normalized(value) === normalized(person.designation)))
        ?? (designations.data ?? []).find(d => normalized(d.code) === normalized(person.designationCode));
      return designation && isPeopleDesignation(categoryById.get(designation.designation_category_id), designation.onboarding_categories,
        person.workerType === "employee" ? "employees" : "contractors") ? [{ ...person, designation: designation.name || person.designation }] : [];
    });
    return { discipline: buildUtrDiscipline(people), error: null };
  } catch (error) {
    return { discipline: buildUtrDiscipline([]), error: error instanceof Error ? error.message : "UTR attendance unavailable." };
  }
}

/** Additive, aggregate-only audit. No source refresh or classification mutations.
 * Private cron captures at five-minute resolution; the UI groups half-hour checkpoints.
 * Historical intervals are NEVER backfilled from today's latest package states. */
export async function captureReviewEddHistory() {
  if (!supabaseAdmin) throw Error("EDD history database is unavailable.");
  const db = supabaseAdmin, now = new Date(), date = stationEddToday(now);
  if (now.getTime() < Date.parse(`${date}T06:00:00+05:30`)) return { captured: 0, skipped: "Before 06:00 IST" };
  const [stocks, outcomes] = await Promise.all([
    db.from("edd_station_snapshots").select("station_code,fetched_at"),
    db.from("edd_performance_snapshots").select("station_code,window_from,window_to,fetched_at,assigned,delivered,returned,held,yet_to_dispatch")
  ]);
  if (stocks.error || outcomes.error) throw Error("EDD source timestamps could not be read.");
  const codes = [...new Set([...(stocks.data ?? []).map(s => s.station_code), ...(outcomes.data ?? []).map(s => s.station_code)])];
  if (!codes.length) return { captured: 0 };
  const stations = await db.from("stations").select("id,company_id,station_code").in("station_code", codes);
  if (stations.error) throw Error("EDD station mapping could not be read.");
  // The upstream ledger is code-keyed. Ambiguous cross-company codes cannot be
  // safely attributed, so skip them rather than copying another tenant's data.
  const mapped = (stations.data ?? []).filter(s => s.company_id && (stations.data ?? []).filter(other => other.station_code === s.station_code).length === 1);
  const backlog = new Map((stocks.data ?? []).map(s => [s.station_code, s.fetched_at]));
  const performance = new Map((outcomes.data ?? []).map(s => [s.station_code, s]));
  let captured = 0;
  for (let offset = 0; offset < mapped.length; offset += 6) {
    const batch = mapped.slice(offset, offset + 6), batchCodes = batch.map(s => s.station_code);
    // A successful worker refresh lands in edd_station_snapshots first. Import
    // that exact snapshot before reading the package ledger, otherwise the
    // five-minute review can keep recording yesterday's package cohort even
    // while the live EDD network page already shows today's source totals.
    await ingestEddObservations(batchCodes);
    const ledger = await loadEddLedger(batchCodes);
    const observedAt = new Date();
    if (stationEddToday(observedAt) !== date) break; // Do not cross EOD with a mixed-day sample.
    const rows = batch.map(station => {
      const entry = ledger.get(station.station_code);
      const route = performance.get(station.station_code);
      const summary = summarizeStationEdd(station.station_code, entry?.packages ?? null, entry?.fetchedAt ?? null, date);
      const { todayTotal, todayAtStation, todayOnRoad, todayDelivered, todayHfr, todayAttempted, todayUnverified, todayOther, missingDate, hasSnapshot } = summary;
      const routeCounts = normalizeReviewRouteCounts(route ? { workDate: String(route.window_from), assigned: route.assigned,
        delivered: route.delivered, returned: route.returned, held: route.held, yetToDispatch: route.yet_to_dispatch } : null, date);
      return { company_id: station.company_id, station_id: station.id, station_code: station.station_code, work_date: date,
        captured_slot: new Date(Math.floor(observedAt.getTime() / 300_000) * 300_000).toISOString(), observed_at: observedAt.toISOString(),
        source_at: entry?.fetchedAt ?? null, backlog_at: backlog.get(station.station_code) ?? null, performance_at: route?.fetched_at ?? null,
        counts: { todayTotal, todayAtStation, todayOnRoad, todayDelivered, todayHfr, todayAttempted, todayUnverified, todayOther, missingDate, hasSnapshot, ...routeCounts } };
    });
    const result = await db.from("ops_review_edd_observations").upsert(rows,
      { onConflict: "company_id,station_id,work_date,captured_slot", ignoreDuplicates: true });
    if (result.error) throw Error(`EDD history capture failed: ${result.error.message}`);
    captured += rows.length;
  }
  return { captured, date };
}
