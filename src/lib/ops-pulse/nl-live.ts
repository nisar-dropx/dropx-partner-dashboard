import "server-only";
import {
  getAuthorization,
  hasPermission,
  type AuthorizationContext,
} from "@/lib/authorization";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";
import {
  lossClusterScope,
  lossSchemaReady,
  nlStationScope,
  type NlFilters,
} from "./nl-loss";
import {
  casePhase,
  disputeGate,
  requestSent,
  windowSummary,
  WINDOW_STAGES,
  type DisputeRequest,
  type LiveWindow,
  type PhaseKey,
} from "./nl-dispute-policy";
import type { NlCase } from "./nl-loss-policy";

export type LiveCase = Omit<NlCase, "recovery"> & {
  source_status: string | null;
  request: DisputeRequest | null;
};

function storedWindow(value: unknown): LiveWindow {
  const window: LiveWindow = {};
  if (value && typeof value === "object")
    for (const stage of WINDOW_STAGES) {
      const date = (value as Record<string, unknown>)[stage];
      if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date))
        window[stage] = date;
    }
  return window;
}

type LiveMeta = {
  month: string;
  case_key: string;
  station_code: string;
  amount: number | null;
  source_status: string | null;
  status: string | null;
  stage: string | null;
  reason: string | null;
  last_seen_at: string;
};

/**
 * The month Cloak is still deciding. Stations see every case in their scope — not
 * only final recoverable ones — with where it stands in the dispute window.
 */
export async function loadNlLive(auth: AuthorizationContext, filters: NlFilters) {
  if (!supabaseAdmin) throw Error("Database unavailable.");
  const ready = await lossSchemaReady();
  const { company, stations, clusterOptions } = await lossClusterScope(auth);
  const codes = stations.map((s) => s.source_code);
  const db = supabaseAdmin;
  const [meta, source, runResult] = await Promise.all([
    ready
      ? readAllRows(
          db
            .from("nl_loss_month_cases")
            .select(
              "month,case_key,station_code,amount,source_status,status:details->>case_status,stage:details->extra->>current_sla_stage,reason:details->>category,last_seen_at",
            )
            .eq("company_id", company)
            .eq("report", "nl")
            .eq("data_source", "live")
            .eq("source_present", true)
            .in("station_code", codes.length ? codes : ["__NONE__"])
            .order("month")
            .order("case_key"),
        )
      : { data: [], error: null },
    ready
      ? db
          .from("nl_loss_sources")
          .select("live_window,live_window_checked_at")
          .eq("company_id", company)
          .maybeSingle()
      : { data: null, error: null },
    db
      .from("loss_report_runs")
      .select("checked_at,finished_at")
      .eq("report", "nl")
      .eq("status", "completed")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (meta.error || source.error)
    throw Error("Live Cloak cases could not be loaded. Please retry.");
  const all = (meta.data ?? []) as LiveMeta[];
  const months = [...new Set(all.map((r) => r.month))].sort().reverse();
  const month =
    filters.month && months.includes(filters.month)
      ? filters.month
      : (months[0] ?? null);
  // Cloak publishes deadlines for the month it is currently deciding (the newest live month).
  const window = month === months[0] ? storedWindow(source.data?.live_window) : {};
  const requests = month
    ? await readAllRows(
        db
          .from("nl_dispute_requests")
          .select("*")
          .eq("company_id", company)
          .eq("month", month)
          .order("case_key"),
      )
    : { data: [], error: null };
  if (requests.error) throw Error("Dispute requests could not be loaded.");
  const requestByCase = new Map(
    (requests.data ?? []).map((r) => [r.case_key as string, r as DisputeRequest]),
  );
  const cluster =
    filters.cluster && clusterOptions.some((o) => o.value === filters.cluster)
      ? filters.cluster
      : "";
  const matchingStations = stations.filter(
    (s) => !cluster || s.clusterKeys.includes(cluster),
  );
  const allowed = new Set(matchingStations.map((s) => s.source_code));
  const station =
    filters.station && allowed.has(filters.station) ? filters.station : "";
  // Opens the case list on a status group: todo (waiting on station), amazon or decided.
  const phase = ["todo", "amazon", "decided"].includes(filters.phase ?? "")
    ? filters.phase!
    : "";
  const monthRows = all
    .filter((r) => r.month === month)
    .map((r) => ({
      ...r,
      phase: casePhase({
        case_status: r.status,
        nl_status: r.source_status,
        extra: { current_sla_stage: r.stage },
      }).key,
    }));
  const reasons = [
    ...new Set(monthRows.map((r) => r.reason || "Unspecified")),
  ].sort();
  const reason =
    filters.reason && reasons.includes(filters.reason) ? filters.reason : "";
  // Station totals ignore the phase filter so the overview always adds up; the case list applies it.
  const filtered = monthRows.filter(
    (r) =>
      allowed.has(r.station_code) &&
      (!station || r.station_code === station) &&
      (!reason || (r.reason || "Unspecified") === reason),
  );
  const tally = (rows: typeof filtered) => {
    const by = (keys: PhaseKey[]) => rows.filter((r) => keys.includes(r.phase));
    const sum = (list: typeof rows) =>
      list.reduce((v, r) => v + Number(r.amount || 0), 0);
    const mine = by(["action", "respond"]);
    return {
      count: rows.length,
      amount: sum(rows),
      pending: mine.length,
      pendingAmount: sum(mine),
      // A request the station already sent to the desk is no longer waiting on the station.
      unsent: mine.filter(
        (r) => !requestSent(requestByCase.get(r.case_key), r.stage),
      ).length,
      withAmazon: by(["amazon"]).length,
      withAmazonAmount: sum(by(["amazon"])),
      saved: by(["won"]).length,
      savedAmount: sum(by(["won"])),
      recoverable: by(["lost", "accepted", "missed"]).length,
      recoverableAmount: sum(by(["lost", "accepted", "missed"])),
    };
  };
  const totals = matchingStations
    .map((s) => ({
      ...s,
      ...tally(filtered.filter((r) => r.station_code === s.source_code)),
    }))
    .filter((s) => s.count > 0)
    .sort((a, b) => b.pending - a.pending || b.amount - a.amount);
  let cases: LiveCase[] = [];
  if (station && month) {
    const rows = await readAllRows(
      db
        .from("nl_loss_month_cases")
        .select("*")
        .eq("company_id", company)
        .eq("report", "nl")
        .eq("data_source", "live")
        .eq("month", month)
        .eq("station_code", station)
        .eq("source_present", true)
        .order("amount", { ascending: false })
        .order("case_key"),
    );
    if (rows.error) throw Error("Live cases could not be loaded.");
    cases = (rows.data ?? [])
      .filter(
        (r) => !reason || (r.details?.category || "Unspecified") === reason,
      )
      .map((r) => ({
        ...r,
        request: requestByCase.get(r.case_key) ?? null,
      })) as LiveCase[];
  }
  const inScope = new Set(filtered.map((r) => r.case_key));
  return {
    ready,
    month,
    months,
    window,
    windowCheckedAt: (source.data?.live_window_checked_at as string) ?? null,
    stage: windowSummary(window),
    cluster,
    clusterOptions,
    reason,
    reasons,
    phase,
    station,
    stations: matchingStations,
    totals,
    summary: tally(filtered),
    cases,
    deskQueue: (requests.data ?? []).filter(
      (r) => r.status === "submitted" && inScope.has(r.case_key),
    ).length,
    checked: runResult.data?.checked_at || runResult.data?.finished_at || null,
    canDispute: !auth.readOnly && hasPermission(auth, "ops_losses", "edit"),
    // The Cloak desk files what stations send and can return a request for correction.
    canDesk: !auth.readOnly && hasPermission(auth, "ops_loss_master", "edit"),
  };
}
export type NlLiveView = Awaited<ReturnType<typeof loadNlLive>>;

/**
 * Scope + state checks shared by every dispute read and write.
 * station = raise/edit a request, desk = return it or mark it filed.
 */
export async function disputeContext(
  month: string,
  key: string,
  mode: "view" | "station" | "desk",
) {
  const auth = await getAuthorization();
  const page = mode === "desk" ? "ops_loss_master" : "ops_losses";
  if (
    !auth ||
    !hasPermission(auth, page, mode === "view" ? "access" : "edit") ||
    (mode !== "view" && auth.readOnly)
  )
    throw Error("Access denied.");
  if (
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) ||
    !key ||
    key.length > 300 ||
    !supabaseAdmin ||
    !(await lossSchemaReady())
  )
    throw Error("Invalid dispute case.");
  const scope = await nlStationScope(auth);
  const [row, source] = await Promise.all([
    supabaseAdmin
      .from("nl_loss_month_cases")
      .select("case_key,station_code,amount,source_status,source_present,data_source,details")
      .eq("company_id", scope.company)
      .eq("report", "nl")
      .eq("month", month)
      .eq("case_key", key)
      .maybeSingle(),
    supabaseAdmin
      .from("nl_loss_sources")
      .select("live_window,recovery_policy")
      .eq("company_id", scope.company)
      .maybeSingle(),
  ]);
  const station = scope.stations.find(
    (s) => s.source_code === row.data?.station_code,
  );
  if (row.error || !row.data || !station)
    throw Error("Case is unavailable or outside your station access.");
  const details = (row.data.details ?? {}) as NlCase["details"];
  const gate =
    row.data.source_present && row.data.data_source === "live"
      ? disputeGate(
          {
            case_status: details.case_status,
            nl_status: row.data.source_status,
            extra: details.extra,
          },
          storedWindow(source.data?.live_window),
        )
      : ({
          open: false,
          kind: null,
          deadline: null,
          reason: "This month is final in Cloak. Use the recovery view for re-disputes.",
        } as const);
  return {
    auth,
    company: scope.company,
    station,
    caseKey: row.data.case_key as string,
    details,
    gate,
    policy: source.data?.recovery_policy as
      | { attachment_types: string[]; attachment_max_mb: number; attachment_max_count: number }
      | undefined,
  };
}
