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
};

export type LossStationTotal = { station_code: string; station_name: string | null; row_count: number; total_amount: number };
export type LossRow = { id: number; station_code: string | null; amount: number | null; reference: string | null; raw: Record<string, string> };

export type LossReportView = {
  run: LossRun | null;
  lastFailure: { error: string | null; finished_at: string | null } | null;
  totals: LossStationTotal[];
  rows: LossRow[];
  selectedStation: string | null;
  scopedToAll: boolean;
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

export async function loadLossReport(auth: AuthorizationContext, report: LossReportKind, station?: string | null): Promise<LossReportView> {
  if (!supabaseAdmin) throw new Error("Database is unavailable.");
  const companyId = requireCompanyId(auth);
  const { codes, names } = await allowedStations(auth, companyId);

  const [runResult, failResult] = await Promise.all([
    supabaseAdmin.from("loss_report_runs")
      .select("id,source_file,source_week,source_created_at,period_label,source_total_count,headers,station_column,amount_column,reference_column,total_rows,finished_at")
      .eq("report", report).eq("status", "completed").order("started_at", { ascending: false }).limit(1).maybeSingle(),
    supabaseAdmin.from("loss_report_runs")
      .select("error,finished_at,started_at").eq("report", report).order("started_at", { ascending: false }).limit(1).maybeSingle()
  ]);
  if (runResult.error) throw new Error("Loss report could not be loaded. Run the loss report migration if this is a new setup.");
  const run = runResult.data as LossRun | null;
  const latest = failResult.data as { error: string | null; finished_at: string | null } | null;
  const lastFailure = latest?.error ? latest : null;
  const empty = { run, lastFailure, totals: [], rows: [], selectedStation: null, scopedToAll: codes === null };
  if (!run) return empty;
  if (codes && !codes.size) return empty;

  let totalsQuery = supabaseAdmin.from("loss_report_station_totals").select("station_code,row_count,total_amount").eq("run_id", run.id);
  if (codes) totalsQuery = totalsQuery.in("station_code", [...codes]);
  const totalsResult = await readAllRows(totalsQuery.order("station_code"));
  if (totalsResult.error) throw new Error("Station totals could not be loaded.");
  const totals: LossStationTotal[] = (totalsResult.data ?? [])
    .map((r) => ({ station_code: r.station_code, station_name: names.get(r.station_code) ?? null, row_count: Number(r.row_count), total_amount: Number(r.total_amount) }))
    .sort((a, b) => b.total_amount - a.total_amount || b.row_count - a.row_count);

  const selected = String(station ?? "").trim().toUpperCase() || null;
  const selectedAllowed = selected && totals.some((t) => t.station_code === selected) ? selected : null;
  let rows: LossRow[] = [];
  if (selectedAllowed) {
    const rowResult = await readAllRows(
      supabaseAdmin.from("loss_report_rows").select("id,station_code,amount,reference,raw").eq("run_id", run.id).eq("station_code", selectedAllowed).order("id")
    );
    if (rowResult.error) throw new Error("Station rows could not be loaded.");
    rows = (rowResult.data ?? []) as LossRow[];
  }
  return { run, lastFailure, totals, rows, selectedStation: selectedAllowed, scopedToAll: codes === null };
}
