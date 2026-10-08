import "server-only";
import { hasPermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";
import { loadPeopleOperationalHierarchy } from "@/lib/people-operational-hierarchy";
import { nlPeopleClusters } from "./nl-loss-clusters";
import {
  isRecoverable,
  monthLabel,
  type NlCase,
  type Recovery,
  type RecoveryOutcome,
  type LossSettings,
} from "./nl-loss-policy";
export type NlFilters = {
  month?: string;
  period?: string;
  station?: string;
  cluster?: string;
  reason?: string;
  view?: string;
  phase?: string;
};
export type RecoveryKind = "nl" | "slp_initial" | "slp_final";
export const ALL_PERIODS = "all";

let schemaReady = false;
/**
 * The SLP ledger, live-month tagging and dispute requests arrive with one migration.
 * Until it is applied the NL recovery page keeps working exactly as before.
 */
export async function lossSchemaReady() {
  if (schemaReady) return true;
  const probe = await supabaseAdmin
    ?.from("nl_loss_month_cases")
    .select("report,data_source")
    .limit(1);
  schemaReady = !!probe && !probe.error;
  return schemaReady;
}

export async function nlStationScope(auth: AuthorizationContext) {
  if (!supabaseAdmin) throw Error("Database unavailable.");
  const company = requireCompanyId(auth);
  let q = supabaseAdmin
    .from("stations")
    .select("id,station_code,station_name")
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
    })),
  };
}

/** The user's stations with their current People cluster owners. */
export async function lossClusterScope(auth: AuthorizationContext) {
  const { company, stations: scopedStations } = await nlStationScope(auth);
  const hierarchy = await loadPeopleOperationalHierarchy(
    company,
    scopedStations.map((s) => s.id),
    { includeStationResponsibilities: true },
  );
  if (hierarchy.error)
    throw Error(
      "Current People cluster mappings could not be loaded. Please retry.",
    );
  const clusters = nlPeopleClusters(scopedStations, hierarchy.byLocation);
  return {
    company,
    stations: scopedStations.map((s) => ({
      ...s,
      ...clusters.byStation.get(s.id)!,
    })),
    clusterOptions: clusters.options,
  };
}
export type LossStation = Awaited<
  ReturnType<typeof lossClusterScope>
>["stations"][number];

type MetaRow = {
  month: string;
  period: string | null;
  station_code: string;
  amount: number | null;
  source_status: string | null;
  source_present: boolean;
  reason: string | null;
  last_seen_at: string;
  in_initial?: string | null;
  in_final?: string | null;
};

/** Run health + Master settings every Losses view needs. */
async function lossContext(company: string, report: RecoveryKind) {
  const db = supabaseAdmin!;
  const [runResult, failResult, outcomesResult, settingsResult] =
    await Promise.all([
      db
        .from("loss_report_runs")
        .select("checked_at,finished_at")
        .eq("report", report)
        .eq("status", "completed")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      db
        .from("loss_report_runs")
        .select("finished_at,error")
        .eq("report", report)
        .eq("status", "failed")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      db
        .from("nl_recovery_outcomes")
        .select("*")
        .eq("company_id", company)
        .order("sort_order")
        .order("label"),
      db
        .from("nl_loss_sources")
        .select(
          "recoverable_statuses,allow_equal_split,allow_custom_split,include_inactive_people,history_months,updated_at,recovery_policy",
        )
        .eq("company_id", company)
        .maybeSingle(),
    ]);
  if (
    runResult.error ||
    outcomesResult.error ||
    failResult.error ||
    settingsResult.error
  )
    throw Error("Losses could not be loaded completely. Please retry.");
  const checked =
    runResult.data?.checked_at || runResult.data?.finished_at || null;
  // Unchanged pulls only bump checked_at, so a failure matters only when it is newer than the last good check.
  const failure =
    failResult.data &&
    Date.parse(failResult.data.finished_at) > (Date.parse(checked || "") || 0)
      ? failResult.data
      : null;
  return {
    checked,
    failure,
    outcomes: (outcomesResult.data ?? []) as RecoveryOutcome[],
    settings: settingsResult.data as LossSettings | null,
  };
}

/**
 * Recovery worklist for final NL months and for either SLP stage. SLP Initial and
 * Final share one archived case, so a plan saved on one tab is the plan on the other.
 */
export async function loadRecoveryView(
  auth: AuthorizationContext,
  kind: RecoveryKind,
  filters: NlFilters,
  options: { allStations?: boolean } = {},
) {
  if (!supabaseAdmin) throw Error("Database unavailable.");
  const ready = await lossSchemaReady();
  const slp = kind !== "nl";
  if (slp && !ready)
    throw Error("SLP recovery is being enabled. Please check back shortly.");
  const {
    company,
    stations,
    clusterOptions,
  } = await lossClusterScope(auth);
  const codes = stations.map((s) => s.source_code);
  let metaQuery = supabaseAdmin
    .from("nl_loss_month_cases")
    .select(
      "month,period:details->>period,station_code,amount,source_status,source_present,reason:details->>category,last_seen_at,in_initial:details->>in_initial,in_final:details->>in_final",
    )
    .eq("company_id", company)
    .in("station_code", codes.length ? codes : ["__NONE__"]);
  if (ready) metaQuery = metaQuery.eq("report", slp ? "slp" : "nl");
  const [meta, context] = await Promise.all([
    readAllRows(metaQuery.order("month").order("case_key")),
    lossContext(company, kind),
  ]);
  if (meta.error)
    throw Error("Losses could not be loaded completely. Please retry.");
  const { settings, outcomes, checked, failure } = context;
  const accepted = settings?.recoverable_statuses ?? [];
  const inStage = (r: { in_initial?: unknown; in_final?: unknown }) =>
    String(kind === "slp_initial" ? r.in_initial : r.in_final) === "true";
  const all = ((meta.data ?? []) as MetaRow[]).filter((r) =>
    slp ? inStage(r) : true,
  );
  const periodOf = (r: { month: string; period: string | null }) =>
    slp ? r.period || r.month : r.month;
  // Newest first. An SLP period ("Aug-Sep") is ordered by the latest month it contains.
  const latest = new Map<string, string>();
  for (const r of all) {
    const p = periodOf(r);
    if ((latest.get(p) ?? "") < r.month) latest.set(p, r.month);
  }
  const periods = [...latest.entries()]
    .sort((a, b) => b[1].localeCompare(a[1]) || b[0].localeCompare(a[0]))
    .map(([p]) => p);
  const requested = slp ? filters.period : filters.month;
  const month =
    requested && periods.includes(requested)
      ? requested
      : slp && requested === ALL_PERIODS && periods.length > 1
        ? ALL_PERIODS
        : (periods[0] ?? null);
  const periodOptions = [
    ...periods.map((value) => ({
      value,
      label: slp ? value : monthLabel(value),
    })),
    ...(slp && periods.length > 1
      ? [{ value: ALL_PERIODS, label: "All periods" }]
      : []),
  ];
  const cluster =
    filters.cluster &&
    clusterOptions.some((option) => option.value === filters.cluster)
      ? filters.cluster
      : "";
  const inPeriod = (r: MetaRow) => month === ALL_PERIODS || periodOf(r) === month;
  const recoverable = (r: { source_status: string | null }) =>
    slp || isRecoverable(r.source_status, accepted);
  const monthRows = all.filter(
    (r) => inPeriod(r) && r.source_present && recoverable(r),
  );
  const reasons = [
    ...new Set(monthRows.map((r) => r.reason || "Unspecified")),
  ].sort();
  const reason =
    filters.reason && reasons.includes(filters.reason) ? filters.reason : "";
  const matchingStations = stations.filter(
    (s) => !cluster || s.clusterKeys.includes(cluster),
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
  const wanted = options.allStations
    ? totals.map((t) => t.source_code)
    : station
      ? [station]
      : [];
  if (wanted.length && month) {
    const months = [
      ...new Set(filtered.map((r) => r.month)),
    ];
    let caseQuery = supabaseAdmin
      .from("nl_loss_month_cases")
      .select("*")
      .eq("company_id", company)
      .in("month", months.length ? months : ["__NONE__"])
      .in("station_code", wanted)
      .eq("source_present", true);
    if (ready) caseQuery = caseQuery.eq("report", slp ? "slp" : "nl");
    const [rows, recoveries] = await Promise.all([
      readAllRows(
        caseQuery.order("amount", { ascending: false }).order("case_key"),
      ),
      readAllRows(
        supabaseAdmin
          .from("nl_loss_recoveries")
          .select("*")
          .eq("company_id", company)
          .in("month", months.length ? months : ["__NONE__"])
          .order("case_key"),
      ),
    ]);
    if (rows.error || recoveries.error)
      throw Error("Recovery details could not be loaded.");
    const map = new Map(
      (recoveries.data ?? []).map((r) => [
        `${r.month}::${r.case_key}`,
        r as Recovery,
      ]),
    );
    cases = (rows.data ?? [])
      .filter(
        (r) =>
          recoverable(r) &&
          (!slp || inStage(r.details ?? {})) &&
          (month === ALL_PERIODS ||
            (slp ? r.details?.period || r.month : r.month) === month) &&
          (!reason || (r.details?.category || "Unspecified") === reason),
      )
      .map((r) => ({
        ...r,
        recovery: map.get(`${r.month}::${r.case_key}`) ?? null,
      })) as NlCase[];
  }
  const canEdit = !auth.readOnly && hasPermission(auth, "ops_losses", "edit");
  return {
    kind,
    ready,
    settings,
    month,
    periodOptions,
    periodParam: slp ? ("period" as const) : ("month" as const),
    cluster,
    clusterOptions,
    reason,
    reasons,
    station,
    stations: matchingStations,
    totals,
    cases,
    outcomes,
    checked,
    failure,
    canEdit,
    // Restricted outcomes ("Already recovered") need their own permission on top of edit access.
    canRecovered: canEdit && hasPermission(auth, "ops_loss_recovered", "edit"),
    canMaster: hasPermission(auth, "ops_loss_master", "access"),
    canRefresh:
      !slp && !auth.readOnly && hasPermission(auth, "ops_loss_master", "edit"),
    monthLastSeen:
      all
        .filter(inPeriod)
        .map((r) => r.last_seen_at)
        .sort()
        .pop() ?? null,
  };
}
export const loadNlLoss = (auth: AuthorizationContext, filters: NlFilters) =>
  loadRecoveryView(auth, "nl", filters);
export type NlView = Awaited<ReturnType<typeof loadRecoveryView>>;
