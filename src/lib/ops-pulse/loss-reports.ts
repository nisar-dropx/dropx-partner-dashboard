import "server-only";
import type { AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";

/** Written by nl-loss-cloak-worker (loss_report_* tables). */
export type LossReportKind = "nl" | "slp_initial" | "slp_final";

export type LossRun = {
  id: string;
  source_file: string | null;
  source_week: string | null;
  source_created_at: string | null;
  period_label: string | null;
  source_total_count: number | null;
  headers: string[];
  station_column: string | null;
  amount_column: string | null;
  reference_column: string | null;
  total_rows: number;
  finished_at: string | null;
  checked_at: string | null;
};

export type LossStationTotal = { station_code: string; station_name: string | null; row_count: number; total_amount: number };
/** Typed case from public.loss_cases (one row per case, updated in place by the worker). */
export type LossRow = {
  case_key: string; tid: string | null; tid_approximate: boolean; station_code: string | null; amount: number | null;
  case_status: string | null; category: string | null; sub_category: string | null; impact_date: string | null;
  closed_date: string | null; da_name: string | null; remarks: string | null; period: string | null; extra: Record<string, string>;
};
const CASE_COLUMNS = "case_key,tid,tid_approximate,station_code,amount,case_status,category,sub_category,impact_date,closed_date,da_name,remarks,period,extra";

export type LossReportView = {
  run: LossRun | null;
  lastFailure: { error: string | null; finished_at: string | null } | null;
  totals: LossStationTotal[];
  rows: LossRow[];
  selectedStation: string | null;
  scopedToAll: boolean;
  /** SLP only: file periods (newest first) and the one being viewed (null = all). */
  periods: string[];
  selectedPeriod: string | null;
};

const NONE = "00000000-0000-0000-0000-000000000000";

/**
 * Amazon station codes the user may see. Uses the portal code from COD station
 * settings when present (same mapping the EDD pages use), else stations.station_code.
 * `null` = all-location access (also sees rows the worker could not map to a station).
 */
async function allowedStations(auth: AuthorizationContext, companyId: string) {
  if (!supabaseAdmin) throw new Error("Database is unavailable.");
  let stations = supabaseAdmin.from("stations").select("id,station_code,station_name").eq("company_id", companyId);
  let settings = supabaseAdmin.from("cod_station_settings").select("location_id,portal_station_code").eq("company_id", companyId);
  if (!auth.hasAllLocationAccess) {
    const scope = auth.locationScopeIds.length ? auth.locationScopeIds : [NONE];
    stations = stations.in("id", scope);
    settings = settings.in("location_id", scope);
  }
  const [s, p] = await Promise.all([readAllRows(stations), readAllRows(settings)]);
  if (s.error) throw new Error("Stations could not be loaded.");
  const portal = new Map((p.data ?? []).filter((r) => r.portal_station_code).map((r) => [r.location_id, String(r.portal_station_code).trim().toUpperCase()]));
  const names = new Map<string, string | null>();
  for (const row of s.data ?? []) {
    const code = portal.get(row.id) || String(row.station_code ?? "").trim().toUpperCase();
    if (code) names.set(code, row.station_name ?? null);
  }
  return { codes: auth.hasAllLocationAccess ? null : new Set(names.keys()), names };
}

export async function loadLossReport(auth: AuthorizationContext, report: LossReportKind, station?: string | null, period?: string | null): Promise<LossReportView> {
  if (!supabaseAdmin) throw new Error("Database is unavailable.");
  const companyId = requireCompanyId(auth);
  // Scope + latest runs are independent — one round trip instead of three.
  const [{ codes, names }, runResult, failResult] = await Promise.all([
    allowedStations(auth, companyId),
    supabaseAdmin.from("loss_report_runs")
      .select("id,source_file,source_week,source_created_at,period_label,source_total_count,headers,station_column,amount_column,reference_column,total_rows,finished_at,checked_at")
      .eq("report", report).eq("status", "completed").order("started_at", { ascending: false }).limit(1).maybeSingle(),
    supabaseAdmin.from("loss_report_runs")
      .select("error,finished_at").eq("report", report).eq("status", "failed").order("started_at", { ascending: false }).limit(1).maybeSingle()
  ]);
  if (runResult.error) throw new Error("Loss report could not be loaded. Run the loss report migration if this is a new setup.");
  const run = runResult.data as LossRun | null;
  const failure = failResult.data as { error: string | null; finished_at: string | null } | null;
  // Unchanged pulls only bump checked_at, so a failure matters only if it's newer than the last good check.
  const lastGood = run ? Date.parse(run.checked_at ?? run.finished_at ?? "") || 0 : 0;
  const lastFailure = failure?.error && Date.parse(failure.finished_at ?? "") > lastGood ? failure : null;
  const empty = { run, lastFailure, totals: [], rows: [], selectedStation: null, scopedToAll: codes === null, periods: [] as string[], selectedPeriod: null };
  if (!run) return empty;
  if (codes && !codes.size) return empty;

  let totals: LossStationTotal[];
  let periods: string[] = [];
  let selectedPeriod: string | null = null;
  const withName = (t: Omit<LossStationTotal, "station_name">): LossStationTotal => ({ ...t, station_name: names.get(t.station_code) ?? null });
  if (report === "nl") {
    let totalsQuery = supabaseAdmin.from("loss_report_station_totals").select("station_code,row_count,total_amount").eq("run_id", run.id);
    if (codes) totalsQuery = totalsQuery.in("station_code", [...codes]);
    const totalsResult = await readAllRows(totalsQuery.order("station_code"));
    if (totalsResult.error) throw new Error("Station totals could not be loaded.");
    totals = (totalsResult.data ?? []).map((r) => withName({ station_code: r.station_code, row_count: Number(r.row_count), total_amount: Number(r.total_amount) }));
  } else {
    // SLP files are small (~100 cases across all periods): one narrow query gives periods + per-period totals.
    let q = supabaseAdmin.from("loss_cases").select("station_code,amount,period,impact_date").eq("report", report);
    if (codes) q = q.in("station_code", [...codes]);
    const result = await readAllRows(q);
    if (result.error) throw new Error("Station totals could not be loaded.");
    const all = (result.data ?? []) as Array<{ station_code: string | null; amount: number | null; period: string | null; impact_date: string | null }>;
    const latestByPeriod = new Map<string, string>();
    for (const r of all) if (r.period) latestByPeriod.set(r.period, [latestByPeriod.get(r.period) ?? "", r.impact_date ?? ""].sort().pop()!);
    periods = [...latestByPeriod.entries()].sort((x, y) => y[1].localeCompare(x[1])).map(([p]) => p);
    selectedPeriod = period && periods.includes(period) ? period : null;
    const agg = new Map<string, { row_count: number; total_amount: number }>();
    for (const r of all) {
      if (selectedPeriod && r.period !== selectedPeriod) continue;
      const key = r.station_code ?? "UNMAPPED";
      const x = agg.get(key) ?? { row_count: 0, total_amount: 0 };
      x.row_count += 1;
      x.total_amount += Number(r.amount ?? 0);
      agg.set(key, x);
    }
    totals = [...agg.entries()].map(([station_code, x]) => withName({ station_code, ...x }));
  }
  totals.sort((a, b) => b.total_amount - a.total_amount || b.row_count - a.row_count);

  const selected = String(station ?? "").trim().toUpperCase() || null;
  const selectedAllowed = selected && totals.some((t) => t.station_code === selected) ? selected : null;
  let rows: LossRow[] = [];
  if (selectedAllowed) {
    const rowResult = await readAllRows(
      (selectedPeriod ? supabaseAdmin.from("loss_cases").select(CASE_COLUMNS).eq("report", report).eq("period", selectedPeriod) : supabaseAdmin.from("loss_cases").select(CASE_COLUMNS).eq("report", report)).eq("station_code", selectedAllowed).order("amount", { ascending: false, nullsFirst: false })
    );
    if (rowResult.error) throw new Error("Station rows could not be loaded.");
    rows = (rowResult.data ?? []) as LossRow[];
  }
  return { run, lastFailure, totals, rows, selectedStation: selectedAllowed, scopedToAll: codes === null, periods, selectedPeriod };
}
