import "server-only";
import type { AuthorizationContext } from "@/lib/authorization";
import { darkStoreScope } from "@/lib/ops-pulse/dark-store";
import { todayKolkata } from "@/lib/ops-pulse/cod";
import type { EddStationOption } from "@/lib/ops-pulse/edd-stations";
import { loadFlashClusters, type LoadFlashCluster } from "@/lib/ops-pulse/load-flash-access";

/** PPI feed older than this is called out as stale (VM polls ~30 min). */
export const DS_PPI_STALE_MS = 75 * 60 * 1000;
/** Site Summary older than this is stale (monitor polls ~60s). */
export const DS_SITE_SUMMARY_STALE_MS = 5 * 60 * 1000;

export type DsLivePicker = {
  username: string;
  orderCount: number;
  unitCount: number;
  avgPptSeconds: number | null;
};

export type DsLiveHour = {
  hour: number;
  orderCount: number;
  unitCount: number;
  avgPptSeconds: number | null;
};

export type DsLiveOrder = {
  procurementListId: string;
  username: string;
  completedAt: string;
  unitCount: number;
  pptSeconds: number | null;
};

export type DsLiveInboundShipment = {
  id: string;
  amazonShipmentRefId: string;
  status: string | null;
  pctCompletion: number | null;
  totalUnits: number | null;
  estimatedArrivalTime: string | null;
  receiveTime: string | null;
  reconcilePending: number;
};

export type DsLiveSiteOrder = {
  oid: string;
  picker: string | null;
  items: number;
  elapsedSeconds: number;
  pctComplete: number | null;
  status: string | null;
};

/** Compact board row — no heavy nested arrays (detail is loaded on demand). */
export type DsLiveStore = {
  stationCode: string;
  stationName: string;
  city: string | null;
  orderCount: number;
  unitCount: number;
  pickerCount: number;
  avgPptSeconds: number | null;
  ppiFetchedAt: string | null;
  ppiStale: boolean;
  siteFetchedAt: string | null;
  siteStale: boolean;
  activeOrders: number;
  pendingAcceptance: number;
  breachingCount: number;
  worstElapsedSeconds: number | null;
  slaSeconds: number;
  inboundOpen: number;
  inboundAvgPct: number | null;
  inboundReconcilePending: number;
  lastFetchStatus: string | null;
  lastFetchAt: string | null;
};

export type DsLiveStoreDetail = DsLiveStore & {
  pickers: DsLivePicker[];
  hourly: DsLiveHour[];
  recentOrders: DsLiveOrder[];
  inbound: DsLiveInboundShipment[];
  siteOrders: DsLiveSiteOrder[];
};

export type DsLiveInsight = {
  tone: "critical" | "watch" | "good" | "info";
  title: string;
  detail: string;
  filter: "all" | "slowPpi" | "stale" | "acceptance" | "inbound";
};

export type DsLiveNetwork = {
  businessDate: string;
  generatedAt: string;
  storeCount: number;
  orderCount: number;
  unitCount: number;
  pickerCount: number;
  avgPptSeconds: number | null;
  stalePpiStores: number;
  acceptanceBreaches: number;
  inboundOpenShipments: number;
  latestFetchAt: string | null;
  stores: DsLiveStore[];
  insights: DsLiveInsight[];
  stationNames: Record<string, string>;
  clusters: LoadFlashCluster[];
};

type DailyRow = {
  station_code: string;
  username: string;
  order_count: number;
  unit_count: number;
  avg_ppt_seconds: number | null;
  fetched_at: string;
};

type HourlyRow = {
  station_code: string;
  hour: number;
  order_count: number;
  unit_count: number;
  avg_ppt_seconds: number | null;
};

type OrderRow = {
  station_code: string;
  procurement_list_id: string;
  username: string;
  completed_at: string;
  unit_count: number;
  ppt_seconds: number | null;
};

type InboundRow = {
  id: string;
  station_code: string;
  amazon_shipment_ref_id: string;
  status: string | null;
  pct_completion: number | null;
  total_units: number | null;
  estimated_arrival_time: string | null;
  receive_time: string | null;
};

type SnapshotRow = {
  station_code: string;
  fetched_at: string;
  active_orders: number;
  pending_acceptance: number;
  breaching_count: number;
  worst_elapsed_seconds: number | null;
  sla_seconds: number;
};

type SiteOrderRow = {
  station_code: string;
  oid: string;
  picker: string | null;
  items: number;
  elapsed_seconds: number;
  pct_complete: number | null;
  status: string | null;
};

type FetchRunRow = {
  station_code: string;
  run_type: string;
  status: string;
  finished_at: string | null;
  started_at: string;
};

function weightedAvgPpt(rows: { orderCount: number; avgPptSeconds: number | null }[]): number | null {
  let weight = 0;
  let sum = 0;
  for (const row of rows) {
    if (row.avgPptSeconds == null || row.orderCount <= 0) continue;
    weight += row.orderCount;
    sum += row.avgPptSeconds * row.orderCount;
  }
  return weight > 0 ? Math.round((sum / weight) * 100) / 100 : null;
}

function ageMs(iso: string | null | undefined, now: number) {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? now - t : Number.POSITIVE_INFINITY;
}

function buildInsights(stores: DsLiveStore[]): DsLiveInsight[] {
  const insights: DsLiveInsight[] = [];
  const slow = stores.filter((s) => (s.avgPptSeconds ?? 0) >= 90 && s.orderCount > 0);
  const stale = stores.filter((s) => s.ppiStale || s.siteStale);
  const acceptance = stores.filter((s) => s.breachingCount > 0);
  const inbound = stores.filter((s) => s.inboundOpen > 0 && (s.inboundAvgPct == null || s.inboundAvgPct < 100));

  if (acceptance.length) {
    insights.push({
      tone: "critical",
      title: "Acceptance SLA",
      detail: `${acceptance.length} store${acceptance.length === 1 ? "" : "s"} have orders waiting past the Site Summary SLA.`,
      filter: "acceptance"
    });
  }
  if (slow.length) {
    insights.push({
      tone: "watch",
      title: "Slow PPI",
      detail: `${slow.map((s) => s.stationCode).slice(0, 4).join(", ")}${slow.length > 4 ? ` +${slow.length - 4}` : ""} averaging 90s+ PPT.`,
      filter: "slowPpi"
    });
  }
  if (stale.length) {
    insights.push({
      tone: "watch",
      title: "Stale feeds",
      detail: `${stale.length} store${stale.length === 1 ? "" : "s"} have PPI or Site Summary data that is behind.`,
      filter: "stale"
    });
  }
  if (inbound.length) {
    insights.push({
      tone: "info",
      title: "Inbound open",
      detail: `${inbound.length} store${inbound.length === 1 ? "" : "s"} still have incomplete inbound shipments.`,
      filter: "inbound"
    });
  }
  if (!insights.length && stores.some((s) => s.orderCount > 0 || s.activeOrders > 0)) {
    insights.push({
      tone: "good",
      title: "Feeds look healthy",
      detail: "No slow PPI, stale feeds, or acceptance breaches in scope right now.",
      filter: "all"
    });
  }
  return insights;
}

function emptyNetwork(businessDate: string, insightDetail: string): DsLiveNetwork {
  return {
    businessDate,
    generatedAt: new Date().toISOString(),
    storeCount: 0,
    orderCount: 0,
    unitCount: 0,
    pickerCount: 0,
    avgPptSeconds: null,
    stalePpiStores: 0,
    acceptanceBreaches: 0,
    inboundOpenShipments: 0,
    latestFetchAt: null,
    stores: [],
    insights: [{ tone: "info", title: "No stores in scope", detail: insightDetail, filter: "all" }],
    stationNames: {},
    clusters: []
  };
}

/**
 * Light network board load — aggregates only. No per-order / hourly detail
 * so polling cannot hang Postgres or pile work onto the VM path.
 */
export async function loadDsLivePerformance(
  authorization: AuthorizationContext,
  options?: { businessDate?: string }
): Promise<DsLiveNetwork> {
  const scope = await darkStoreScope(authorization);
  const businessDate = options?.businessDate && /^\d{4}-\d{2}-\d{2}$/.test(options.businessDate)
    ? options.businessDate
    : todayKolkata();
  const now = Date.now();
  const codes = scope.locations.map((l) => l.station_code);
  const nameByCode = new Map(scope.locations.map((l) => [l.station_code, { name: l.station_name || l.station_code, city: l.city ?? null, id: l.id }]));
  const stationNames = Object.fromEntries([...nameByCode].map(([code, meta]) => [code, meta.name]));

  const stationOptions: EddStationOption[] = scope.locations.map((l) => ({
    code: l.station_code,
    label: l.station_code,
    name: l.station_name || l.station_code,
    locationId: l.id
  }));

  if (!codes.length) {
    return emptyNetwork(businessDate, "No NOW stores are available for your access.");
  }

  const db = scope.db;
  const clustersPending = loadFlashClusters(scope.companyId, stationOptions);

  // Board queries only — keep columns narrow and avoid order-level tables.
  const [dailyRes, inboundRes, snapshotsRes, runsRes] = await Promise.all([
    db.from("ds_ppi_daily").select("station_code,username,order_count,unit_count,avg_ppt_seconds,fetched_at")
      .eq("company_id", scope.companyId).eq("business_date", businessDate).in("station_code", codes),
    db.from("ds_inbound_shipments").select("id,station_code,pct_completion,status")
      .eq("company_id", scope.companyId).in("station_code", codes)
      .or("status.is.null,status.neq.complete"),
    db.from("ds_site_summary_snapshots").select("station_code,fetched_at,active_orders,pending_acceptance,breaching_count,worst_elapsed_seconds,sla_seconds")
      .eq("company_id", scope.companyId).in("station_code", codes),
    db.from("ds_fetch_runs").select("station_code,run_type,status,finished_at,started_at")
      .eq("company_id", scope.companyId).in("station_code", codes).eq("run_type", "ppi")
      .order("started_at", { ascending: false }).limit(Math.min(80, codes.length * 3))
  ]);

  for (const result of [dailyRes, inboundRes, runsRes]) {
    if (result.error) throw new Error(result.error.message);
  }

  const daily = (dailyRes.data ?? []) as DailyRow[];
  const inboundLite = (inboundRes.data ?? []) as Pick<InboundRow, "id" | "station_code" | "pct_completion" | "status">[];
  const snapshots = (snapshotsRes.error ? [] : snapshotsRes.data ?? []) as SnapshotRow[];
  const runs = (runsRes.data ?? []) as FetchRunRow[];

  // Recon totals only for open shipments — one grouped pass, capped.
  const shipmentIds = inboundLite.map((r) => r.id).slice(0, 200);
  const reconByShipment = new Map<string, number>();
  if (shipmentIds.length) {
    const reconRes = await db.from("ds_inbound_reconciliation")
      .select("shipment_id,reconcile_pending_qty")
      .eq("company_id", scope.companyId)
      .in("shipment_id", shipmentIds)
      .gt("reconcile_pending_qty", 0)
      .limit(1000);
    if (!reconRes.error) {
      for (const row of reconRes.data ?? []) {
        const id = String((row as { shipment_id: string }).shipment_id);
        reconByShipment.set(id, (reconByShipment.get(id) ?? 0) + Number((row as { reconcile_pending_qty: number }).reconcile_pending_qty ?? 0));
      }
    }
  }

  const stores: DsLiveStore[] = codes.map((code) => {
    const meta = nameByCode.get(code) ?? { name: code, city: null, id: "" };
    const pickersDaily = daily.filter((r) => r.station_code === code);
    const orderCount = pickersDaily.reduce((s, r) => s + Number(r.order_count ?? 0), 0);
    const unitCount = pickersDaily.reduce((s, r) => s + Number(r.unit_count ?? 0), 0);
    const avgPptSeconds = weightedAvgPpt(pickersDaily.map((r) => ({
      orderCount: Number(r.order_count ?? 0),
      avgPptSeconds: r.avg_ppt_seconds == null ? null : Number(r.avg_ppt_seconds)
    })));
    const ppiFetchedAt = pickersDaily.map((r) => r.fetched_at).sort().at(-1) ?? null;
    const snap = snapshots.find((r) => r.station_code === code) ?? null;
    const storeInbound = inboundLite.filter((r) => r.station_code === code);
    const inboundPcts = storeInbound.map((r) => Number(r.pct_completion)).filter((n) => Number.isFinite(n));
    const inboundReconcilePending = storeInbound.reduce((s, r) => s + (reconByShipment.get(r.id) ?? 0), 0);
    const run = runs.find((r) => r.station_code === code) ?? null;
    const lastFetchAt = run?.finished_at ?? run?.started_at ?? ppiFetchedAt;

    return {
      stationCode: code,
      stationName: meta.name,
      city: meta.city,
      orderCount,
      unitCount,
      pickerCount: pickersDaily.filter((r) => Number(r.order_count ?? 0) > 0).length,
      avgPptSeconds,
      ppiFetchedAt,
      ppiStale: ageMs(ppiFetchedAt ?? lastFetchAt, now) > DS_PPI_STALE_MS,
      siteFetchedAt: snap?.fetched_at ?? null,
      siteStale: !snap || ageMs(snap?.fetched_at, now) > DS_SITE_SUMMARY_STALE_MS,
      activeOrders: Number(snap?.active_orders ?? 0),
      pendingAcceptance: Number(snap?.pending_acceptance ?? 0),
      breachingCount: Number(snap?.breaching_count ?? 0),
      worstElapsedSeconds: snap?.worst_elapsed_seconds == null ? null : Number(snap.worst_elapsed_seconds),
      slaSeconds: Number(snap?.sla_seconds ?? 15),
      inboundOpen: storeInbound.length,
      inboundAvgPct: inboundPcts.length
        ? Math.round((inboundPcts.reduce((a, b) => a + b, 0) / inboundPcts.length) * 10) / 10
        : null,
      inboundReconcilePending,
      lastFetchStatus: run?.status ?? null,
      lastFetchAt
    };
  }).sort((a, b) => a.stationCode.localeCompare(b.stationCode));

  const networkPickers = new Set(daily.filter((r) => Number(r.order_count ?? 0) > 0).map((r) => `${r.station_code}:${r.username}`));
  const latestFetchAt = stores
    .map((s) => s.lastFetchAt || s.siteFetchedAt || s.ppiFetchedAt)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;

  const clusters = await clustersPending;

  return {
    businessDate,
    generatedAt: new Date().toISOString(),
    storeCount: stores.length,
    orderCount: stores.reduce((s, r) => s + r.orderCount, 0),
    unitCount: stores.reduce((s, r) => s + r.unitCount, 0),
    pickerCount: networkPickers.size,
    avgPptSeconds: weightedAvgPpt(stores.map((s) => ({ orderCount: s.orderCount, avgPptSeconds: s.avgPptSeconds }))),
    stalePpiStores: stores.filter((s) => s.ppiStale).length,
    acceptanceBreaches: stores.reduce((s, r) => s + r.breachingCount, 0),
    inboundOpenShipments: stores.reduce((s, r) => s + r.inboundOpen, 0),
    latestFetchAt,
    stores,
    insights: buildInsights(stores),
    stationNames,
    clusters
  };
}

/** Heavy detail for one store — called only when the user opens a row. */
export async function loadDsLiveStoreDetail(
  authorization: AuthorizationContext,
  stationCode: string,
  options?: { businessDate?: string }
): Promise<DsLiveStoreDetail | null> {
  const code = stationCode.trim().toUpperCase();
  if (!code) return null;

  const scope = await darkStoreScope(authorization);
  const location = scope.locations.find((l) => l.station_code === code);
  if (!location) return null;

  const businessDate = options?.businessDate && /^\d{4}-\d{2}-\d{2}$/.test(options.businessDate)
    ? options.businessDate
    : todayKolkata();
  const now = Date.now();
  const db = scope.db;

  const [dailyRes, hourlyRes, ordersRes, inboundRes, snapRes, siteOrdersRes, runRes] = await Promise.all([
    db.from("ds_ppi_daily").select("station_code,username,order_count,unit_count,avg_ppt_seconds,fetched_at")
      .eq("company_id", scope.companyId).eq("business_date", businessDate).eq("station_code", code),
    db.from("ds_ppi_hourly").select("station_code,hour,order_count,unit_count,avg_ppt_seconds")
      .eq("company_id", scope.companyId).eq("business_date", businessDate).eq("station_code", code).order("hour"),
    db.from("ds_ppi_orders").select("station_code,procurement_list_id,username,completed_at,unit_count,ppt_seconds")
      .eq("company_id", scope.companyId).eq("business_date", businessDate).eq("station_code", code)
      .order("completed_at", { ascending: false }).limit(25),
    db.from("ds_inbound_shipments").select("id,station_code,amazon_shipment_ref_id,status,pct_completion,total_units,estimated_arrival_time,receive_time")
      .eq("company_id", scope.companyId).eq("station_code", code)
      .or("status.is.null,status.neq.complete").limit(30),
    db.from("ds_site_summary_snapshots").select("station_code,fetched_at,active_orders,pending_acceptance,breaching_count,worst_elapsed_seconds,sla_seconds")
      .eq("company_id", scope.companyId).eq("station_code", code).maybeSingle(),
    db.from("ds_site_summary_orders").select("station_code,oid,picker,items,elapsed_seconds,pct_complete,status")
      .eq("company_id", scope.companyId).eq("station_code", code)
      .order("elapsed_seconds", { ascending: false }).limit(20),
    db.from("ds_fetch_runs").select("station_code,run_type,status,finished_at,started_at")
      .eq("company_id", scope.companyId).eq("station_code", code).eq("run_type", "ppi")
      .order("started_at", { ascending: false }).limit(1)
  ]);

  if (dailyRes.error) throw new Error(dailyRes.error.message);
  if (hourlyRes.error) throw new Error(hourlyRes.error.message);
  if (ordersRes.error) throw new Error(ordersRes.error.message);
  if (inboundRes.error) throw new Error(inboundRes.error.message);

  const daily = (dailyRes.data ?? []) as DailyRow[];
  const hourly = (hourlyRes.data ?? []) as HourlyRow[];
  const orders = (ordersRes.data ?? []) as OrderRow[];
  const inbound = (inboundRes.data ?? []) as InboundRow[];
  const siteOrders = (siteOrdersRes.error ? [] : siteOrdersRes.data ?? []) as SiteOrderRow[];
  const snap = (snapRes.error ? null : snapRes.data) as SnapshotRow | null;
  const run = ((runRes.data ?? []) as FetchRunRow[])[0] ?? null;

  const shipmentIds = inbound.map((r) => r.id);
  const reconByShipment = new Map<string, number>();
  if (shipmentIds.length) {
    const reconRes = await db.from("ds_inbound_reconciliation")
      .select("shipment_id,reconcile_pending_qty")
      .eq("company_id", scope.companyId)
      .in("shipment_id", shipmentIds);
    if (!reconRes.error) {
      for (const row of reconRes.data ?? []) {
        const id = String((row as { shipment_id: string }).shipment_id);
        reconByShipment.set(id, (reconByShipment.get(id) ?? 0) + Number((row as { reconcile_pending_qty: number }).reconcile_pending_qty ?? 0));
      }
    }
  }

  const orderCount = daily.reduce((s, r) => s + Number(r.order_count ?? 0), 0);
  const unitCount = daily.reduce((s, r) => s + Number(r.unit_count ?? 0), 0);
  const avgPptSeconds = weightedAvgPpt(daily.map((r) => ({
    orderCount: Number(r.order_count ?? 0),
    avgPptSeconds: r.avg_ppt_seconds == null ? null : Number(r.avg_ppt_seconds)
  })));
  const ppiFetchedAt = daily.map((r) => r.fetched_at).sort().at(-1) ?? null;
  const inboundPcts = inbound.map((r) => Number(r.pct_completion)).filter((n) => Number.isFinite(n));
  const lastFetchAt = run?.finished_at ?? run?.started_at ?? ppiFetchedAt;

  return {
    stationCode: code,
    stationName: location.station_name || code,
    city: location.city ?? null,
    orderCount,
    unitCount,
    pickerCount: daily.filter((r) => Number(r.order_count ?? 0) > 0).length,
    avgPptSeconds,
    ppiFetchedAt,
    ppiStale: ageMs(ppiFetchedAt ?? lastFetchAt, now) > DS_PPI_STALE_MS,
    siteFetchedAt: snap?.fetched_at ?? null,
    siteStale: Boolean(snap) && ageMs(snap?.fetched_at, now) > DS_SITE_SUMMARY_STALE_MS,
    activeOrders: Number(snap?.active_orders ?? 0),
    pendingAcceptance: Number(snap?.pending_acceptance ?? 0),
    breachingCount: Number(snap?.breaching_count ?? 0),
    worstElapsedSeconds: snap?.worst_elapsed_seconds == null ? null : Number(snap.worst_elapsed_seconds),
    slaSeconds: Number(snap?.sla_seconds ?? 15),
    inboundOpen: inbound.length,
    inboundAvgPct: inboundPcts.length
      ? Math.round((inboundPcts.reduce((a, b) => a + b, 0) / inboundPcts.length) * 10) / 10
      : null,
    inboundReconcilePending: [...reconByShipment.values()].reduce((a, b) => a + b, 0),
    lastFetchStatus: run?.status ?? null,
    lastFetchAt,
    pickers: daily
      .map((r) => ({
        username: r.username,
        orderCount: Number(r.order_count ?? 0),
        unitCount: Number(r.unit_count ?? 0),
        avgPptSeconds: r.avg_ppt_seconds == null ? null : Number(r.avg_ppt_seconds)
      }))
      .sort((a, b) => b.orderCount - a.orderCount || b.unitCount - a.unitCount),
    hourly: hourly.map((r) => ({
      hour: Number(r.hour),
      orderCount: Number(r.order_count ?? 0),
      unitCount: Number(r.unit_count ?? 0),
      avgPptSeconds: r.avg_ppt_seconds == null ? null : Number(r.avg_ppt_seconds)
    })),
    recentOrders: orders.map((r) => ({
      procurementListId: r.procurement_list_id,
      username: r.username,
      completedAt: r.completed_at,
      unitCount: Number(r.unit_count ?? 0),
      pptSeconds: r.ppt_seconds == null ? null : Number(r.ppt_seconds)
    })),
    inbound: inbound.map((r) => ({
      id: r.id,
      amazonShipmentRefId: r.amazon_shipment_ref_id,
      status: r.status,
      pctCompletion: r.pct_completion == null ? null : Number(r.pct_completion),
      totalUnits: r.total_units == null ? null : Number(r.total_units),
      estimatedArrivalTime: r.estimated_arrival_time,
      receiveTime: r.receive_time,
      reconcilePending: reconByShipment.get(r.id) ?? 0
    })),
    siteOrders: siteOrders.map((r) => ({
      oid: r.oid,
      picker: r.picker,
      items: Number(r.items ?? 0),
      elapsedSeconds: Number(r.elapsed_seconds ?? 0),
      pctComplete: r.pct_complete == null ? null : Number(r.pct_complete),
      status: r.status
    }))
  };
}
