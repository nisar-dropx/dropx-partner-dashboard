import {
  mgEstimate,
  slabEstimate,
  monthEnd,
  subtractAmounts,
  type PricingCard,
} from "./pricing";
export type Shipment = {
  station_code: string;
  client: string;
  days: number;
  first_date: string;
  last_date: string;
  deliveries: string | null;
  mfn: string | null;
  returns: string | null;
  missing_delivery_rows: number;
  updated_at: string;
};
export type Cost = {
  station_code: string;
  days: number;
  first_date: string;
  last_date: string;
  total: string | null;
  missing_cost_rows: number;
  da: string | null;
  staff: string | null;
  fuel: string | null;
  vehicle: string | null;
  rent: string | null;
  other: string | null;
  utr: string | null;
  van: string | null;
  updated_at: string;
};
export type Snapshot = {
  shipments: Shipment[];
  costs: Cost[];
  read_at: string;
};
export type BusinessRow = {
  station: string;
  name: string;
  provider: string;
  region: string;
  cluster: string;
  deliveries: string | null;
  shipmentDays: number;
  costDays: number;
  shipmentThrough: string | null;
  costThrough: string | null;
  revenue: string | null;
  cost: string | null;
  profit: string | null;
  mg: string | null;
  mgVolume: string | null;
  revision: number | null;
  basis: string;
  issues: string[];
  components: Cost | null;
};
type Location = {
  station_code: string;
  station_name: string | null;
  region?: string | null;
  cluster?: string | null;
  providers?:
    | { name?: string | null; code?: string | null }
    | Array<{ name?: string | null; code?: string | null }>
    | null;
};
const providerName = (s: string) =>
  s.toLowerCase() === "amazon"
    ? "Amazon"
    : s.toLowerCase() === "flipkart"
      ? "Flipkart"
      : s;
export function buildBusinessRows(
  snapshot: Snapshot,
  cards: PricingCard[],
  locations: Location[],
  filters: { month: string; through: string; provider: string },
): BusinessRow[] {
  const places = new Map(locations.map((l) => [l.station_code, l]));
  const shipments = new Map(
    snapshot.shipments.map((s) => [
      `${s.station_code}/${providerName(s.client)}`,
      s,
    ]),
  );
  const costs = new Map(snapshot.costs.map((c) => [c.station_code, c]));
  const prices = new Map(
    cards.map((c) => [`${c.station_code}/${c.provider}`, c]),
  );
  const keys = new Set([...shipments.keys(), ...prices.keys()]);
  for (const cost of snapshot.costs) {
    if ([...keys].some((key) => key.startsWith(`${cost.station_code}/`)))
      continue;
    const place = places.get(cost.station_code);
    const relation = Array.isArray(place?.providers)
      ? place.providers[0]
      : place?.providers;
    keys.add(
      `${cost.station_code}/${providerName(relation?.name || relation?.code || "Unmapped client")}`,
    );
  }
  const clientCounts = new Map<string, number>();
  for (const key of keys) {
    const station = key.split("/")[0];
    clientCounts.set(station, (clientCounts.get(station) ?? 0) + 1);
  }
  const elapsed = Number(filters.through.slice(8, 10)),
    days = Number(monthEnd(filters.month).slice(8, 10));
  return [...keys].sort().flatMap((key) => {
    const [station, provider] = key.split("/");
    if (filters.provider && provider !== filters.provider) return [];
    const place = places.get(station),
      shipmentsRow = shipments.get(key),
      pricing = prices.get(key),
      costRow = costs.get(station);
    const issues: string[] = [];
    let revenue: string | null = null;
    let basis = "Pricing missing";
    if (!place) issues.push("Location mapping missing");
    if (!pricing) issues.push("No rate card for this month");
    else if (provider === "Amazon") {
      if (pricing.rates.mg_amount_including_mhe != null)
        revenue = mgEstimate(
          pricing.rates.mg_amount_including_mhe,
          elapsed,
          days,
        );
      basis = "MG calendar-day estimate";
      issues.push(
        "Variable revenue, eligibility, recovery, fees and tax not included",
      );
    } else if (provider === "Flipkart") {
      basis = `Monthly ${pricing.slab_mode === "all_units" ? "all-units" : "progressive"} delivery slabs`;
      if (
        shipmentsRow?.deliveries != null &&
        !shipmentsRow.missing_delivery_rows
      )
        revenue = slabEstimate(
          shipmentsRow.deliveries,
          pricing.slabs,
          pricing.slab_mode,
        );
      else issues.push("Delivery quantity unavailable");
    }
    if (!shipmentsRow) issues.push("No shipment report");
    else if (shipmentsRow.days < elapsed || shipmentsRow.missing_delivery_rows)
      issues.push(`Shipment coverage ${shipmentsRow.days}/${elapsed} days`);
    let cost: string | null = costRow?.total ?? null;
    if ((clientCounts.get(station) ?? 0) > 1) {
      cost = null;
      issues.push("Shared station cost needs client allocation");
    } else if (costRow?.missing_cost_rows) {
      cost = null;
      issues.push("Incomplete cost values");
    }
    if (!costRow) issues.push("No cost report");
    else if (costRow.days < elapsed)
      issues.push(`Cost coverage ${costRow.days}/${elapsed} days`);
    return [
      {
        station,
        name: place?.station_name || station,
        provider,
        region: place?.region || "Unassigned",
        cluster: place?.cluster || "Unassigned",
        deliveries: shipmentsRow?.deliveries ?? null,
        shipmentDays: shipmentsRow?.days ?? 0,
        costDays: costRow?.days ?? 0,
        shipmentThrough: shipmentsRow?.last_date ?? null,
        costThrough: costRow?.last_date ?? null,
        revenue,
        cost,
        profit:
          revenue !== null && cost !== null
            ? subtractAmounts(revenue, cost)
            : null,
        mg: pricing?.rates.mg_amount_including_mhe ?? null,
        mgVolume: pricing?.rates.delivery_mg_volume ?? null,
        revision: pricing?.revision ?? null,
        basis,
        issues,
        components: cost !== null ? (costRow ?? null) : null,
      },
    ];
  });
}
