import {
  distanceNoPayoutReasons,
  kilometreRate,
  routeFuelForDay,
  type RouteDistanceContext,
} from "../workforce-route-distance.ts";
export type DistanceStation = {
  id: string;
  station_code: string;
  station_name?: string | null;
  region?: string | null;
  cluster?: string | null;
};
export type DistanceEntry = {
  key: string;
  workforceId: string;
  name: string;
  dropxId: string;
  amazonId: string;
  transporterId: string;
  stationId: string;
  station: string;
  region: string;
  cluster: string;
  date: string;
  status: "ready" | "pending";
  reason: string | null;
  km: number | null;
  rate: number;
  fuel: number | null;
  departureKm: number | null;
  deliveryKm: number | null;
  returnKm: number | null;
  updatedAt: string | null;
  routeId: string | null;
  method: string;
  scans: number;
  /** Scans without a location left out of an estimate (shorter, never longer). */
  skippedScans: number;
};
export const distanceMethods: Record<string, string> = {
  amazon_gps: "Amazon GPS trail",
  amazon_gps_roads: "GPS + road connections",
  gps_trail: "GPS trail",
  scan_roads: "Roads between scans",
  manual: "Imported kilometres",
  pending: "Awaiting evidence",
};
/** Anomalous / left-on-ground days stay stored but are not ops pending. */
export const distanceExcludedReasons = distanceNoPayoutReasons;
/** Register / Excel default: payable Ready days only (matches payroll fuel). */
export const distanceReadyStatuses = ["Ready"] as const;
export type DistanceViewFilters = {
  from: string;
  to: string;
  stations: string[];
  regions: string[];
  clusters: string[];
  statuses: string[];
  methods: string[];
  query: string;
};
export function distanceStatus(row: DistanceEntry) {
  if (row.status === "ready") return "Ready";
  if (distanceExcludedReasons.has(row.reason || "")) return "Excluded";
  return ["input_conflict", "identity_mismatch", "conflicting_scan", "amazon_identity_missing", "mapping_changed"].includes(row.reason || "")
    ? "Needs attention" : "Pending";
}
/** Date/station/search scope without status — used for No payouts sheet. */
export function filterDistanceScope(rows: DistanceEntry[], filters: Omit<DistanceViewFilters, "statuses"> | DistanceViewFilters) {
  const query = filters.query.trim().toLowerCase();
  return rows.filter((r) => r.date >= filters.from && r.date <= filters.to &&
    (!filters.stations.length || filters.stations.includes(r.station)) &&
    (!filters.regions.length || filters.regions.includes(r.region)) &&
    (!filters.clusters.length || filters.clusters.includes(r.cluster)) &&
    (!filters.methods.length || filters.methods.includes(distanceMethods[r.method] || r.method)) &&
    (!query || [r.name, r.amazonId, r.dropxId, r.transporterId].some((value) => value.toLowerCase().includes(query))));
}
export function filterDistanceEntries(rows: DistanceEntry[], filters: DistanceViewFilters) {
  // Empty status selection = Ready only (payout view); non-ready live on the No payouts export sheet.
  const statuses = filters.statuses.length ? filters.statuses : [...distanceReadyStatuses];
  return filterDistanceScope(rows, filters).filter((r) => statuses.includes(distanceStatus(r)));
}
export type DistanceAssociate = {
  key: string;
  name: string;
  amazonIds: string[];
  dropxIds: string[];
  transporterIds: string[];
  stations: string[];
  rows: DistanceEntry[];
  days: number;
  pendingDays: number;
  km: number | null;
  fuel: number | null;
};
export function groupDistanceAssociates(rows: DistanceEntry[]): DistanceAssociate[] {
  const grouped = new Map<string, DistanceEntry[]>();
  for (const row of rows) {
    // Workforce identity groups historical Amazon mappings without merging namesakes.
    const group = grouped.get(row.workforceId) || [];
    group.push(row);
    grouped.set(row.workforceId, group);
  }
  return [...grouped].map(([key, entries]) => {
    const days = [...entries].sort((a, b) => b.date.localeCompare(a.date) || a.station.localeCompare(b.station));
    const unique = (field: "amazonId" | "dropxId" | "transporterId" | "station") =>
      [...new Set(days.flatMap((r) => r[field].split(" / ")).filter(Boolean))];
    const ready = days.filter((r) => r.status === "ready");
    return {
      key, name: days[0].name, amazonIds: unique("amazonId"), dropxIds: unique("dropxId"),
      transporterIds: unique("transporterId"), stations: unique("station"), rows: days,
      days: new Set(days.map((r) => r.date)).size,
      pendingDays: new Set(days.filter((r) => r.status !== "ready" && distanceStatus(r) !== "Excluded").map((r) => r.date)).size,
      km: ready.length ? ready.reduce((sum, r) => sum + (r.km ?? 0), 0) : null,
      fuel: ready.length ? ready.reduce((sum, r) => sum + (r.fuel ?? 0), 0) : null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}
export function distancePeriod(
  from: string | undefined,
  to: string | undefined,
  today: string,
) {
  const valid = (s: string | undefined): s is string =>
    Boolean(
      s &&
        /^\d{4}-\d{2}-\d{2}$/.test(s) &&
        !Number.isNaN(Date.parse(s + "T00:00:00Z")) &&
        new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s,
    );
  const end = valid(to) && to <= today ? to : today;
  const start = valid(from) ? from : end.slice(0, 8) + "01";
  if (start > end || Date.parse(end) - Date.parse(start) > 30 * 86400000)
    throw Error("Choose a date range of up to 31 days.");
  return { from: start, to: end };
}
export function selectedDistanceStations(
  stations: DistanceStation[],
  filters: { stations: string[]; regions: string[]; clusters: string[] },
) {
  return stations.filter(
    (s) =>
      (!filters.stations.length || filters.stations.includes(s.station_code)) &&
      (!filters.regions.length ||
        filters.regions.includes(s.region || "Unassigned")) &&
      (!filters.clusters.length ||
        filters.clusters.includes(s.cluster || "Unassigned")),
  );
}
export function buildDistanceEntries(input: {
  stations: DistanceStation[];
  mappings: any[];
  people: any[];
  activity: any[];
  metadata: any[];
  context: RouteDistanceContext;
  from: string;
  to: string;
}): DistanceEntry[] {
  const rows = new Map<string, DistanceEntry>(),
    people = new Map(input.people.map((p) => [p.id, p])),
    meta = new Map(input.metadata.map((r) => [r.id, r]));
  for (const m of input.mappings) {
    const rate = kilometreRate(m),
      station = input.stations.find((s) => s.id === m.station_id);
    if (rate === null || !station || !m.workforce_id) continue;
    const person = people.get(m.workforce_id);
    const activity = input.activity.filter(
      (a) =>
        a.station_code === station.station_code &&
        String(a.provider_employee_id) === String(m.provider_member_id) &&
        (Number(a.total_delivery) > 0 ||
          Number(a.amazon_delivery) > 0 ||
          Number(a.c_return) > 0 ||
          Number(a.swa_delivery) > 0),
    );
    const dates = new Set([
      ...activity.map((a) => a.work_date),
      ...input.context.rows
        .filter(
          (r) =>
            r.workforce_id === m.workforce_id && r.station_id === m.station_id,
        )
        .map((r) => r.work_date),
      ...input.context.manual
        .filter(
          (r) =>
            r.workforce_id === m.workforce_id && r.station_id === m.station_id,
        )
        .map((r) => r.work_date),
    ]);
    for (const date of dates) {
      if (
        date < input.from ||
        date > input.to ||
        date < m.effective_from ||
        (m.effective_to && date > m.effective_to) ||
        (person?.date_of_join && date < person.date_of_join) ||
        (person?.last_working_date && date > person.last_working_date)
      )
        continue;
      const hasActivity = activity.some((a) => a.work_date === date);
      const stored = input.context.rows.find(
          (r) =>
            r.workforce_id === m.workforce_id &&
            r.station_id === m.station_id &&
            r.work_date === date,
        );
      let fuel;
      try {
        fuel = routeFuelForDay(input.context, {
          workforceId: m.workforce_id,
          stationId: m.station_id,
          mappingId: m.id,
          date,
          rate,
          hasActivity,
        });
      } catch {
        fuel = {
          status: "pending" as const,
          reason: "input_conflict",
          km: null,
          rate,
          amount: null,
          departureKm: null,
          deliveryKm: null,
          returnKm: null,
          updatedAt: null,
          routeId: null,
          source: "calculated" as const,
        };
      }
      // Payroll skips no-payout days; keep them for the Excel No payouts sheet (Ready UI hides them).
      if (!fuel && stored && distanceNoPayoutReasons.has(stored.reason || "")) {
        fuel = {
          status: "pending" as const,
          reason: stored.reason,
          km: null,
          rate,
          amount: null,
          departureKm: null,
          deliveryKm: null,
          returnKm: null,
          updatedAt: stored.calculated_at ?? null,
          routeId: null,
          source: "calculated" as const,
        };
      }
      if (!fuel) continue;
      const detail = meta.get(stored?.id);
      const key = `${m.workforce_id}|${m.station_id}|${date}`;
      const entry: DistanceEntry = {
        key,
        workforceId: m.workforce_id,
        name:
          person?.full_name ||
          activity[0]?.provider_employee_name ||
          "Associate",
        dropxId: person?.dropx_id || "",
        amazonId: String(m.provider_member_id || ""),
        transporterId: detail?.transporter_id || "",
        stationId: station.id,
        station: station.station_code,
        region: station.region || "Unassigned",
        cluster: station.cluster || "Unassigned",
        date,
        status: fuel.status,
        reason: fuel.reason,
        km: fuel.km,
        rate: fuel.rate,
        fuel: fuel.amount,
        departureKm: fuel.departureKm,
        deliveryKm: fuel.deliveryKm,
        returnKm: fuel.returnKm,
        updatedAt: fuel.updatedAt,
        routeId: fuel.routeId,
        method:
          fuel.status === "pending"
            ? "pending"
            : fuel.source === "manual"
              ? "manual"
              : detail?.route_method || "scan_roads",
        scans: Number(detail?.scan_count || 0),
        skippedScans: fuel.status === "ready" && fuel.source !== "manual" ? Number(detail?.skipped_scans || 0) : 0,
      };
      if (rows.has(key)) {
        entry.status = "pending";
        entry.reason = "input_conflict";
        entry.km = entry.fuel = null;
        entry.routeId = null;
        entry.method = "pending";
        entry.amazonId = [rows.get(key)!.amazonId, entry.amazonId]
          .filter(Boolean)
          .join(" / ");
      }
      rows.set(key, entry);
    }
  }
  return [...rows.values()].sort(
    (a, b) =>
      b.date.localeCompare(a.date) ||
      a.station.localeCompare(b.station) ||
      a.name.localeCompare(b.name),
  );
}
