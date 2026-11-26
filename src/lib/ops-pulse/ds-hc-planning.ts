/**
 * Dark Store manpower HC planning from PPI hourly demand ÷ productivity targets.
 */

export type DsHcPlanningTarget = {
  stationCode: string | null;
  ordersPerAssociateHour: number;
  targetPptSeconds: number | null;
  enabled: boolean;
};

export type DsHourlyDemand = {
  hour: number;
  orderCount: number;
};

export type DsHourlyHcPlan = {
  hour: number;
  orderCount: number;
  requiredHc: number;
  rosteredHc: number | null;
  variance: number | null;
};

export function resolveHcTarget(
  targets: DsHcPlanningTarget[],
  stationCode: string
): DsHcPlanningTarget {
  const enabled = (targets ?? []).filter((t) => t.enabled);
  const station = enabled.find((t) => (t.stationCode ?? "").toUpperCase() === stationCode.toUpperCase());
  if (station) return station;
  const company = enabled.find((t) => t.stationCode == null || t.stationCode === "");
  return company ?? {
    stationCode: null,
    ordersPerAssociateHour: 12,
    targetPptSeconds: 90,
    enabled: true
  };
}

export function planHourlyHc(input: {
  demand: DsHourlyDemand[];
  target: DsHcPlanningTarget;
  rosteredByHour?: Map<number, number> | Record<number, number> | null;
}): DsHourlyHcPlan[] {
  const rate = Math.max(0.1, Number(input.target.ordersPerAssociateHour) || 12);
  const rosterMap = input.rosteredByHour instanceof Map
    ? input.rosteredByHour
    : new Map(Object.entries(input.rosteredByHour ?? {}).map(([k, v]) => [Number(k), Number(v)]));

  return (input.demand ?? [])
    .filter((d) => Number.isFinite(d.hour) && d.hour >= 0 && d.hour <= 24)
    .map((d) => {
      const orderCount = Math.max(0, Number(d.orderCount) || 0);
      const requiredHc = orderCount <= 0 ? 0 : Math.ceil(orderCount / rate);
      const rosteredRaw = rosterMap.get(d.hour);
      const rosteredHc = rosteredRaw == null || !Number.isFinite(Number(rosteredRaw))
        ? null
        : Math.max(0, Math.round(Number(rosteredRaw)));
      return {
        hour: d.hour,
        orderCount,
        requiredHc,
        rosteredHc,
        variance: rosteredHc == null ? null : rosteredHc - requiredHc
      };
    })
    .sort((a, b) => a.hour - b.hour);
}

export function summarizeHcPlan(rows: DsHourlyHcPlan[]) {
  const peakRequired = rows.reduce((m, r) => Math.max(m, r.requiredHc), 0);
  const totalOrders = rows.reduce((s, r) => s + r.orderCount, 0);
  const understaffedHours = rows.filter((r) => r.variance != null && r.variance < 0).length;
  return { peakRequired, totalOrders, understaffedHours, hourCount: rows.length };
}
