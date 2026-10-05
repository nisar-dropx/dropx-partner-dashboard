import "server-only";
import { hasPermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";
import {
  isRecoverable,
  type NlCase,
  type Recovery,
  type RecoveryOutcome,
  type LossSettings,
} from "./nl-loss-policy";
export type NlFilters = {
  month?: string;
  station?: string;
  cluster?: string;
  reason?: string;
};
export async function nlStationScope(auth: AuthorizationContext) {
  if (!supabaseAdmin) throw Error("Database unavailable.");
  const company = requireCompanyId(auth);
  let q = supabaseAdmin
    .from("stations")
    .select("id,station_code,station_name,cluster,cluster_name")
    .eq("company_id", company);
  if (!auth.hasAllLocationAccess)
    q = q.in(
      "id",
      auth.locationScopeIds.length
        ? auth.locationScopeIds
        : ["00000000-0000-0000-0000-000000000000"],
    );
  const [s, p] = await Promise.all([
    readAllRows(q.order("id")),
    readAllRows(
      supabaseAdmin
        .from("cod_station_settings")
        .select("location_id,portal_station_code")
        .eq("company_id", company)
        .order("location_id"),
    ),
  ]);
  if (s.error || p.error) throw Error("Station access could not be loaded.");
  const portals = new Map(
    (p.data ?? []).map((r) => [r.location_id, r.portal_station_code]),
  );
  return {
    company,
    stations: (s.data ?? []).map((s) => ({
      ...s,
      source_code: String(portals.get(s.id) || s.station_code)
        .trim()
        .toUpperCase(),
      cluster: String(s.cluster_name || s.cluster || "Unassigned"),
    })),
  };
}
export async function loadNlLoss(
  auth: AuthorizationContext,
  filters: NlFilters,
) {
  if (!supabaseAdmin) throw Error("Database unavailable.");
  const { company, stations } = await nlStationScope(auth);
  const codes = stations.map((s) => s.source_code);
  const [meta, runResult, failResult, outcomesResult, settingsResult] =
    await Promise.all([
      readAllRows(
        supabaseAdmin
          .from("nl_loss_month_cases")
          .select(
            "month,station_code,amount,source_status,source_present,reason:details->>category,source_file,last_seen_at",
          )
          .eq("company_id", company)
          .in("station_code", codes.length ? codes : ["__NONE__"])
          .order("month")
          .order("case_key"),
      ),
      supabaseAdmin
        .from("loss_report_runs")
        .select("checked_at,finished_at")
        .eq("report", "nl")
        .eq("status", "completed")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabaseAdmin
        .from("loss_report_runs")
        .select("finished_at,error")
        .eq("report", "nl")
        .eq("status", "failed")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabaseAdmin
        .from("nl_recovery_outcomes")
        .select("*")
        .eq("company_id", company)
        .order("sort_order")
        .order("label"),
      supabaseAdmin
        .from("nl_loss_sources")
        .select(
          "recoverable_statuses,allow_equal_split,allow_custom_split,include_inactive_people,history_months,updated_at",
        )
        .eq("company_id", company)
        .maybeSingle(),
    ]);
  if (
    meta.error ||
    runResult.error ||
    outcomesResult.error ||
    failResult.error ||
    settingsResult.error
  )
    throw Error("NL losses could not be loaded completely. Please retry.");
  const settings = settingsResult.data as LossSettings | null;
  const accepted = settings?.recoverable_statuses ?? [];
  const all = meta.data ?? [];
  const months = [...new Set(all.map((r) => r.month))].sort().reverse();
  const month =
    filters.month && months.includes(filters.month)
      ? filters.month
      : (months[0] ?? null);
  const clusterOptions = [...new Set(stations.map((s) => s.cluster))].sort();
  const cluster =
    filters.cluster && clusterOptions.includes(filters.cluster)
      ? filters.cluster
      : "";
  const monthRows = all.filter(
    (r) =>
      r.month === month &&
      r.source_present &&
      isRecoverable(r.source_status, accepted),
  );
  const reasons = [
    ...new Set(monthRows.map((r) => r.reason || "Unspecified")),
  ].sort();
  const reason =
    filters.reason && reasons.includes(filters.reason) ? filters.reason : "";
  const matchingStations = stations.filter(
    (s) => !cluster || s.cluster === cluster,
  );
  const allowed = new Set(matchingStations.map((s) => s.source_code));
  const station =
    filters.station && allowed.has(filters.station) ? filters.station : "";
  const filtered = monthRows.filter(
    (r) =>
      allowed.has(r.station_code) &&
      (!station || r.station_code === station) &&
      (!reason || (r.reason || "Unspecified") === reason),
  );
  const totals = matchingStations
    .map((s) => {
      const rows = filtered.filter((r) => r.station_code === s.source_code);
      return {
        ...s,
        count: rows.length,
        amount: rows.reduce((v, r) => v + Number(r.amount || 0), 0),
      };
    })
    .filter((s) => s.count > 0)
    .sort((a, b) => b.amount - a.amount);
  let cases: NlCase[] = [];
  if (station && month) {
    const [rows, recoveries] = await Promise.all([
      readAllRows(
        supabaseAdmin
          .from("nl_loss_month_cases")
          .select("*")
          .eq("company_id", company)
          .eq("month", month)
          .eq("station_code", station)
          .eq("source_present", true)
          .order("amount", { ascending: false })
          .order("case_key"),
      ),
      readAllRows(
        supabaseAdmin
          .from("nl_loss_recoveries")
          .select("*")
          .eq("company_id", company)
          .eq("month", month)
          .order("case_key"),
      ),
    ]);
    if (rows.error || recoveries.error)
      throw Error("Recovery details could not be loaded.");
    const map = new Map(
      (recoveries.data ?? []).map((r) => [r.case_key, r as Recovery]),
    );
    cases = (rows.data ?? [])
      .filter(
        (r) =>
          isRecoverable(r.source_status, accepted) &&
          (!reason || (r.details?.category || "Unspecified") === reason),
      )
      .map((r) => ({
        ...r,
        recovery: map.get(r.case_key) ?? null,
      })) as NlCase[];
  }
  const checked = runResult.data?.checked_at || runResult.data?.finished_at;
  const failure =
    failResult.data &&
    Date.parse(failResult.data.finished_at) > Date.parse(checked || "")
      ? failResult.data
      : null;
  return {
    settings,
    month,
    months,
    cluster,
    clusterOptions,
    reason,
    reasons,
    station,
    stations: matchingStations,
    totals,
    cases,
    outcomes: outcomesResult.data as RecoveryOutcome[],
    checked,
    failure,
    canEdit: !auth.readOnly && hasPermission(auth, "ops_losses", "edit"),
    canMaster: hasPermission(auth, "ops_loss_master", "access"),
    monthLastSeen:
      all
        .filter((r) => r.month === month)
        .map((r) => r.last_seen_at)
        .sort()
        .pop() ?? null,
  };
}
export type NlView = Awaited<ReturnType<typeof loadNlLoss>>;
