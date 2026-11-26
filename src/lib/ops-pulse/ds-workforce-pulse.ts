import "server-only";
import type { AuthorizationContext } from "@/lib/authorization";
import { darkStoreScope } from "@/lib/ops-pulse/dark-store";
import { todayKolkata, type CodLocationRow } from "@/lib/ops-pulse/cod";
import { loadOpsStationManpower } from "@/lib/ops-pulse/station-manpower";
import { summarizeStorePeople } from "@/lib/ops-pulse/ds-command-center";
import {
  defaultSignalRules,
  evaluateSignal,
  resolveSignalRule,
  type DsOpsSignalRule,
  type DsSignalResult
} from "@/lib/ops-pulse/ds-ops-signal-rules";
import {
  planHourlyHc,
  resolveHcTarget,
  summarizeHcPlan,
  type DsHcPlanningTarget,
  type DsHourlyHcPlan
} from "@/lib/ops-pulse/ds-hc-planning";
import { istParts } from "@/lib/ops-pulse/ds-ppi-hourly-display";

export type DsWorkforcePulseStore = {
  stationCode: string;
  stationName: string;
  city: string | null;
  rosteredHc: number;
  dueHc: number;
  reportedHc: number;
  productiveHc: number;
  waitingHc: number;
  onBreakHc: number;
  activeOrders: number;
  pendingAcceptance: number;
  ordersPerProductive: number | null;
  spike: DsSignalResult | null;
  understaffed: boolean;
  siteFetchedAt: string | null;
  hourlyPlan: DsHourlyHcPlan[];
  planSummary: ReturnType<typeof summarizeHcPlan>;
  targetOrdersPerAssociateHour: number;
};

export type DsWorkforcePulsePayload = {
  businessDate: string;
  generatedAt: string;
  stores: DsWorkforcePulseStore[];
  spikeCount: number;
  understaffedCount: number;
};

type SignalRuleRow = {
  station_code: string | null;
  metric: string;
  baseline_days: number;
  threshold_pct: number;
  min_samples: number;
  enabled: boolean;
};

type HcTargetRow = {
  station_code: string | null;
  orders_per_associate_hour: number;
  target_ppt_seconds: number | null;
  enabled: boolean;
};

function mapRules(rows: SignalRuleRow[]): DsOpsSignalRule[] {
  if (!rows.length) return defaultSignalRules();
  return rows.map((r) => ({
    metric: r.metric as DsOpsSignalRule["metric"],
    baselineDays: Number(r.baseline_days ?? 7),
    thresholdPct: Number(r.threshold_pct ?? 40),
    minSamples: Number(r.min_samples ?? 3),
    enabled: Boolean(r.enabled),
    stationCode: r.station_code
  }));
}

function mapTargets(rows: HcTargetRow[]): DsHcPlanningTarget[] {
  return rows.map((r) => ({
    stationCode: r.station_code,
    ordersPerAssociateHour: Number(r.orders_per_associate_hour ?? 12),
    targetPptSeconds: r.target_ppt_seconds == null ? null : Number(r.target_ppt_seconds),
    enabled: Boolean(r.enabled)
  }));
}

function rosteredByHourFromPeople(
  people: Awaited<ReturnType<typeof loadOpsStationManpower>>["people"],
  businessDate: string
): Map<number, number> {
  const map = new Map<number, number>();
  for (let h = 0; h <= 23; h++) map.set(h, 0);
  for (const person of people) {
    if (person.today?.approvedLeave) continue;
    if (person.availability === "Roster off" || person.availability === "On leave") continue;
    const startMs = person.today?.shiftStartsAt ? Date.parse(person.today.shiftStartsAt) : NaN;
    const endMs = person.today?.shiftEndsAt ? Date.parse(person.today.shiftEndsAt) : NaN;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    for (let h = 0; h <= 23; h++) {
      const hourStart = Date.parse(`${businessDate}T${String(h).padStart(2, "0")}:00:00+05:30`);
      const hourEnd = hourStart + 3600_000;
      if (startMs < hourEnd && endMs > hourStart) {
        map.set(h, (map.get(h) ?? 0) + 1);
      }
    }
  }
  return map;
}

export async function loadDsWorkforcePulse(
  authorization: AuthorizationContext,
  options?: { businessDate?: string }
): Promise<DsWorkforcePulsePayload> {
  const scope = await darkStoreScope(authorization);
  const businessDate = options?.businessDate && /^\d{4}-\d{2}-\d{2}$/.test(options.businessDate)
    ? options.businessDate
    : todayKolkata();
  const codes = scope.locations.map((l) => l.station_code);
  const db = scope.db;
  const now = Date.now();
  const wallHour = businessDate === todayKolkata() ? istParts().hour : 23;

  if (!codes.length) {
    return { businessDate, generatedAt: new Date().toISOString(), stores: [], spikeCount: 0, understaffedCount: 0 };
  }

  const baselineFrom = (() => {
    const d = new Date(`${businessDate}T00:00:00+05:30`);
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  })();

  const historyLookbackIso = new Date(now - 8 * 24 * 3600 * 1000).toISOString();
  const historyAsOfIso = new Date(now - 60 * 60 * 1000).toISOString(); // exclude last hour for baseline

  const [snapRes, rulesRes, targetsRes, hourlyRes, baselineHourlyRes, historyBaselineRes, manpower] = await Promise.all([
    db.from("ds_site_summary_snapshots")
      .select("station_code,fetched_at,active_orders,pending_acceptance,waiting_for_orders,on_break,offered_associates,picking_associates,packing_racking,total_associates")
      .eq("company_id", scope.companyId)
      .in("station_code", codes),
    db.from("ds_ops_signal_rules")
      .select("station_code,metric,baseline_days,threshold_pct,min_samples,enabled")
      .eq("company_id", scope.companyId),
    db.from("ds_hc_planning_targets")
      .select("station_code,orders_per_associate_hour,target_ppt_seconds,enabled")
      .eq("company_id", scope.companyId),
    db.from("ds_ppi_hourly")
      .select("station_code,hour,order_count")
      .eq("company_id", scope.companyId)
      .eq("business_date", businessDate)
      .in("station_code", codes),
    db.from("ds_ppi_hourly")
      .select("station_code,hour,order_count,business_date")
      .eq("company_id", scope.companyId)
      .in("station_code", codes)
      .gte("business_date", baselineFrom)
      .lt("business_date", businessDate)
      .eq("hour", wallHour),
    // Same-hour-of-day active_orders samples from Site Summary history (not PPI throughput).
    Promise.all(
      codes.map((code) =>
        db.from("ds_site_summary_snapshot_history")
          .select("station_code,fetched_at,active_orders,pending_acceptance")
          .eq("company_id", scope.companyId)
          .eq("station_code", code)
          .gte("fetched_at", historyLookbackIso)
          .lte("fetched_at", historyAsOfIso)
          .order("fetched_at", { ascending: false })
          .limit(80)
          .then((res: { data: Array<{ station_code: string; fetched_at: string; active_orders: number; pending_acceptance: number }> | null; error: unknown }) =>
            res.error ? [] : res.data ?? []
          )
      )
    ),
    loadOpsStationManpower(scope.companyId, scope.locations as CodLocationRow[], businessDate).catch(() => ({
      asOf: businessDate,
      people: []
    }))
  ]);

  const rules = mapRules((rulesRes.error ? [] : rulesRes.data ?? []) as SignalRuleRow[]);
  const targets = mapTargets((targetsRes.error ? [] : targetsRes.data ?? []) as HcTargetRow[]);
  const snaps = new Map(
    ((snapRes.error ? [] : snapRes.data ?? []) as Array<{
      station_code: string;
      fetched_at: string;
      active_orders: number;
      pending_acceptance: number;
      waiting_for_orders: number;
      on_break: number;
      offered_associates: number;
      picking_associates: number;
      packing_racking: number;
      total_associates: number;
    }>).map((r) => [r.station_code, r])
  );

  const hourlyByStation = new Map<string, { hour: number; orderCount: number }[]>();
  for (const row of (hourlyRes.error ? [] : hourlyRes.data ?? []) as Array<{ station_code: string; hour: number; order_count: number }>) {
    const list = hourlyByStation.get(row.station_code) ?? [];
    list.push({ hour: Number(row.hour), orderCount: Number(row.order_count ?? 0) });
    hourlyByStation.set(row.station_code, list);
  }

  const ophBaselineSamples = new Map<string, number[]>();
  for (const row of (baselineHourlyRes.error ? [] : baselineHourlyRes.data ?? []) as Array<{
    station_code: string;
    order_count: number;
  }>) {
    const list = ophBaselineSamples.get(row.station_code) ?? [];
    list.push(Number(row.order_count ?? 0));
    ophBaselineSamples.set(row.station_code, list);
  }

  const activeBaselineSamples = new Map<string, number[]>();
  const pendingBaselineSamples = new Map<string, number[]>();
  for (const rows of historyBaselineRes) {
    for (const row of rows) {
      const fetchedMs = Date.parse(row.fetched_at);
      if (!Number.isFinite(fetchedMs)) continue;
      const istHour = new Date(fetchedMs + 5.5 * 3600 * 1000).getUTCHours();
      if (istHour !== wallHour) continue;
      const activeList = activeBaselineSamples.get(row.station_code) ?? [];
      activeList.push(Number(row.active_orders ?? 0));
      activeBaselineSamples.set(row.station_code, activeList);
      const pendingList = pendingBaselineSamples.get(row.station_code) ?? [];
      pendingList.push(Number(row.pending_acceptance ?? 0));
      pendingBaselineSamples.set(row.station_code, pendingList);
    }
  }

  const peopleByStation = new Map<string, typeof manpower.people>();
  for (const loc of scope.locations) {
    peopleByStation.set(
      loc.station_code,
      manpower.people.filter((p) => p.locationId === loc.id)
    );
  }

  const stores: DsWorkforcePulseStore[] = codes.map((code) => {
    const loc = scope.locations.find((l) => l.station_code === code)!;
    const snap = snaps.get(code);
    const people = peopleByStation.get(code) ?? [];
    const peopleSummary = summarizeStorePeople(people, now);
    const productiveHc =
      Number(snap?.picking_associates ?? 0) +
      Number(snap?.packing_racking ?? 0) +
      Number(snap?.offered_associates ?? 0);
    const waitingHc = Number(snap?.waiting_for_orders ?? 0);
    const onBreakHc = Number(snap?.on_break ?? 0);
    const activeOrders = Number(snap?.active_orders ?? 0);
    const pendingAcceptance = Number(snap?.pending_acceptance ?? 0);
    const rosteredHc = peopleSummary.due + peopleSummary.upcoming + peopleSummary.working + peopleSummary.completed;
    const dueHc = peopleSummary.due;
    const reportedHc = peopleSummary.dueReported;

    const currentHourOrders = (hourlyByStation.get(code) ?? []).find((h) => h.hour === wallHour)?.orderCount ?? 0;
    const activeRule = resolveSignalRule(rules, "active_orders", code);
    const ophRule = resolveSignalRule(rules, "orders_per_hour", code);
    const pendingRule = resolveSignalRule(rules, "pending_acceptance", code);
    const spikeActive = evaluateSignal(activeRule, {
      current: activeOrders,
      samples: activeBaselineSamples.get(code) ?? []
    });
    const spikeOph = evaluateSignal(ophRule, {
      current: currentHourOrders,
      samples: ophBaselineSamples.get(code) ?? []
    });
    const spikePending = evaluateSignal(pendingRule, {
      current: pendingAcceptance,
      samples: pendingBaselineSamples.get(code) ?? []
    });
    const spike = [spikeActive, spikeOph, spikePending].find((s) => s.spiked)
      ?? [spikeActive, spikeOph, spikePending].find((s) => s.liftPct != null)
      ?? spikeActive;

    const target = resolveHcTarget(targets, code);
    const rosterMap = rosteredByHourFromPeople(people, businessDate);
    const hourlyPlan = planHourlyHc({
      demand: hourlyByStation.get(code) ?? [],
      target,
      rosteredByHour: rosterMap
    });
    const planSummary = summarizeHcPlan(hourlyPlan);
    const requiredNow = Math.ceil(currentHourOrders / Math.max(target.ordersPerAssociateHour, 0.1));
    const understaffed =
      (currentHourOrders > 0 && productiveHc < requiredNow) ||
      (peopleSummary.due > 0 && peopleSummary.notReported > Math.ceil(peopleSummary.due * 0.25)) ||
      (spike.spiked && productiveHc < Math.max(requiredNow, 1));

    return {
      stationCode: code,
      stationName: loc.station_name || code,
      city: loc.city ?? null,
      rosteredHc,
      dueHc,
      reportedHc,
      productiveHc,
      waitingHc,
      onBreakHc,
      activeOrders,
      pendingAcceptance,
      ordersPerProductive: productiveHc > 0 ? Math.round((activeOrders / productiveHc) * 10) / 10 : null,
      spike,
      understaffed,
      siteFetchedAt: snap?.fetched_at ?? null,
      hourlyPlan,
      planSummary,
      targetOrdersPerAssociateHour: target.ordersPerAssociateHour
    };
  }).sort((a, b) => Number(b.spike?.spiked) - Number(a.spike?.spiked) || Number(b.understaffed) - Number(a.understaffed) || a.stationCode.localeCompare(b.stationCode));

  return {
    businessDate,
    generatedAt: new Date().toISOString(),
    stores,
    spikeCount: stores.filter((s) => s.spike?.spiked).length,
    understaffedCount: stores.filter((s) => s.understaffed).length
  };
}
