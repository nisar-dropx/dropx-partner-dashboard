import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import type { CodLocationRow } from "./cod";
import { loadEddLedger } from "./edd-ledger";
import { fetchEddStation, fetchEddPerformanceStation } from "./edd-worker";
import { mergeReviewEddCohort } from "./review-edd-cohort";
import { summarizeStationEdd, stationEddToday } from "./station-edd";
import { loadOpsStationManpower } from "./station-manpower";
import { isPeopleDesignation } from "./station-opening-punches";
import { buildReviewEddTimeline, buildUtrDiscipline, normalizeReviewRouteCounts, reviewEddSourceFresh, type ReviewEddPoint, type ReviewRouteSnapshot, type ReviewEddRefreshSource } from "./review-operations";

/** Server components call this only after review permission + station scope resolution. */
export async function loadReviewEddHistory(companyId: string, stationId: string, stationCode: string, date: string) {
  try {
    if (!supabaseAdmin) throw Error("EDD history is unavailable.");
    const [result, routeResult, collectionResult] = await Promise.all([
      supabaseAdmin.from("ops_review_edd_observations")
        .select("observed_at,source_at,backlog_at,performance_at,counts")
        .eq("company_id", companyId).eq("station_id", stationId).eq("work_date", date)
        .order("observed_at").limit(300),
      supabaseAdmin.from("edd_performance_daily")
        .select("date,assigned,delivered,returned,held,yet_to_dispatch,updated_at")
        .eq("station_code", stationCode).eq("date", date).maybeSingle(),
      // Called only after the tenant/station scope gate. Never expose another
      // location's queue metadata or upstream exception bodies to the browser.
      date === stationEddToday() ? supabaseAdmin.from("ops_review_edd_refresh_jobs")
        .select("source,source_at,last_error,next_attempt_at,lease_until").eq("station_code", stationCode).limit(2)
        : Promise.resolve({ data: [], error: null })
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
      collection: (collectionResult.error ? [] : collectionResult.data ?? []) as ReviewEddRefreshSource[],
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
 * Private cron captures every 15 minutes; the UI groups half-hour checkpoints.
 * Historical intervals are NEVER backfilled from today's latest package states. */
export async function captureReviewEddHistory(): Promise<{ captured: number; date?: string; skipped?: string; fresh?: number; staleStations?: string[]; failedSources?: string[] }> {
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
  const staleStations: string[] = [], failedSources: string[] = [];
  for (let offset = 0; offset < mapped.length; offset += 6) {
    const batch = mapped.slice(offset, offset + 6), batchCodes = batch.map(s => s.station_code);
    // The live worker and the application ledger can use different Supabase
    // projects. Read the worker's current cached cohort directly, then carry
    // over prior history verification only when its timestamp still validates
    // the new source package. A worker failure falls back to the ledger with
    // its stored snapshot timestamp, which the freshness gate will suppress.
    const [ledger, liveResults, outcomeResults] = await Promise.all([
      loadEddLedger(batchCodes).catch(() => { failedSources.push(...batchCodes.map(code => `${code}:ledger`)); return new Map(); }),
      Promise.all(batchCodes.map(code => fetchEddStation({ stationCode: code }).catch(() => { failedSources.push(`${code}:stock`); return null; }))),
      Promise.all(batchCodes.map(code => fetchEddPerformanceStation({ stationCode: code }).catch(() => { failedSources.push(`${code}:outcomes`); return null; })))
    ]);
    const live = new Map(liveResults.flatMap((result, index) => result?.status === "ok" && result.payload.stationCode === batchCodes[index] ? [[result.payload.stationCode, result.payload] as const] : []));
    const liveOutcomes = new Map(outcomeResults.flatMap((result, index) => result?.status === "ok" && result.payload.stationCode === batchCodes[index] && result.payload.window.from === date && result.payload.window.to === date ? [[result.payload.stationCode, result.payload] as const] : []));
    const observedAt = new Date();
    if (stationEddToday(observedAt) !== date) break; // Do not cross EOD with a mixed-day sample.
    const rows = batch.map(station => {
      const entry = ledger.get(station.station_code);
      const source = live.get(station.station_code);
      const outcome = liveOutcomes.get(station.station_code);
      const packages = source || entry || outcome ? mergeReviewEddCohort(entry?.packages ?? [], source ?? null, outcome ?? null) : null;
      // Both sides of the checkpoint now use the worker's current source. The
      // old DB copy is an explicit fallback, not the authoritative live feed.
      const route = outcome ? { window_from: outcome.window.from, fetched_at: outcome.fetchedAt,
        assigned: outcome.assigned, delivered: outcome.delivered, returned: outcome.returned,
        held: outcome.held, yet_to_dispatch: outcome.yetToDispatch } : performance.get(station.station_code);
      const sourceAt = source?.fetchedAt ?? entry?.fetchedAt ?? null;
      const backlogAt = source?.fetchedAt ?? backlog.get(station.station_code) ?? null;
      const summary = summarizeStationEdd(station.station_code, packages, sourceAt, date);
      const { todayTotal, todayAtStation, todayOnRoad, todayDelivered, todayHfr, todayHcr, todayObservedAtStation, todayAttempted, todayUnverified, todayOther, missingDate, hasSnapshot } = summary;
      const routeCounts = normalizeReviewRouteCounts(route ? { workDate: String(route.window_from), assigned: route.assigned,
        delivered: route.delivered, returned: route.returned, held: route.held, yetToDispatch: route.yet_to_dispatch } : null, date);
      const row = { company_id: station.company_id, station_id: station.id, station_code: station.station_code, work_date: date,
        captured_slot: new Date(Math.floor(observedAt.getTime() / 300_000) * 300_000).toISOString(), observed_at: observedAt.toISOString(),
        source_at: sourceAt, backlog_at: backlogAt, performance_at: route?.fetched_at ?? null,
        counts: { todayTotal, todayAtStation, todayOnRoad, todayDelivered, todayHfr, todayHcr, todayObservedAtStation, todayAttempted, todayUnverified, todayOther, missingDate,
          hasSnapshot: hasSnapshot && Boolean(source), captureVersion: 4, captureEveryMinutes: 15, sourceMaxAgeMinutes: 35, ...routeCounts } };
      if (!reviewEddSourceFresh({ observedAt: row.observed_at, sourceAt, backlogAt, performanceAt: row.performance_at, counts: row.counts }, date)) staleStations.push(station.station_code);
      return row;
    });
    const result = await db.from("ops_review_edd_observations").upsert(rows,
      { onConflict: "company_id,station_id,work_date,captured_slot", ignoreDuplicates: true });
    if (result.error) failedSources.push(...batchCodes.map(code => `${code}:history-write`));
    else captured += rows.length;
  }
  return { captured, date, fresh: Math.max(0, captured - staleStations.length), staleStations, failedSources };
}
