import {
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
};
export const distanceMethods: Record<string, string> = {
  amazon_gps: "Amazon GPS",
  amazon_gps_roads: "GPS + road connections",
  scan_roads: "Roads between scans",
  manual: "Imported kilometres",
  pending: "Awaiting evidence",
};
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
          source: "calculated",
        };
      }
      if (!fuel) continue;
      const stored = input.context.rows.find(
          (r) =>
            r.workforce_id === m.workforce_id &&
            r.station_id === m.station_id &&
            r.work_date === date,
        ),
        detail = meta.get(stored?.id);
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
