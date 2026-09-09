import {
  mgEstimate,
  decimal,
  amount,
  scale,
  addAmounts,
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
  daily_shipments?: DailyShipment[];
  daily_costs?: DailyCost[];
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
  daily: BusinessDay[];
  variableRate: string | null;
  mfnRate: string | null;
  smdRate: string | null;
  ihsLowRate: string | null;
  ihsHighRate: string | null;
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
export type DailyShipment = {
  station_code: string;
  client: string;
  work_date: string;
  deliveries: string | null;
  mfn: string | null;
  smd: string | null;
  ihs: string | null;
  updated_at: string;
};
export type DailyCost = {
  station_code: string;
  work_date: string;
  total: string | null;
  updated_at: string;
};
export type BusinessDay = {
  date: string;
  deliveries: string | null;
  mgVolume: string | null;
  excessVolume: string | null;
  base: string | null;
  variable: string | null;
  mfn: string | null;
  mfnRevenue: string | null;
  smd: string | null;
  ihs: string | null;
  revenue: string | null;
  cost: string | null;
  profit: string | null;
  shipmentReported: boolean;
  issues: string[];
};
const zero = BigInt(0);
const units = (v: bigint) =>
  `${v / scale}.${String(v % scale).padStart(24, "0")}`.replace(/\.?0+$/, "") ||
  "0";
// Cumulative component rounding reconciles every displayed day to the displayed MTD.
function accrual() {
  let total = zero,
    rounded = "0.00";
  return (value: bigint | null) => {
    if (value === null) return null;
    total += value;
    const next = amount(total),
      day = subtractAmounts(next, rounded);
    rounded = next;
    return day;
  };
}
export function buildDailyRows(
  snapshots: Snapshot,
  station: string,
  provider: string,
  pricing: PricingCard | undefined,
  month: string,
  through: string,
  sharedCost: boolean,
): BusinessDay[] {
  const monthDays = BigInt(Number(monthEnd(month).slice(8)));
  const elapsed = Number(through.slice(8));
  const shipments = new Map(
    (snapshots.daily_shipments ?? [])
      .filter(
        (s) =>
          s.station_code === station && providerName(s.client) === provider,
      )
      .map((s) => [s.work_date, s]),
  );
  const costs = new Map(
    (snapshots.daily_costs ?? [])
      .filter((c) => c.station_code === station)
      .map((c) => [c.work_date, c]),
  );
  const variableAccrual = accrual(),
    mfnAccrual = accrual(),
    costAccrual = accrual();
  const rates = pricing?.rates ?? {};
  let flipkartQuantity = zero,
    flipkartPrevious = "0.00";
  return Array.from({ length: elapsed }, (_, index) => {
    const date = `${month}-${String(index + 1).padStart(2, "0")}`;
    const s = shipments.get(date),
      c = costs.get(date),
      issues: string[] = [];
    let base: string | null = null,
      variable: string | null = null,
      mfnRevenue: string | null = null,
      mgVolume: string | null = null,
      excessVolume: string | null = null,
      revenue: string | null = null;
    if (!s)
      issues.push("Shipment report pending; variable earnings incomplete");
    if (!pricing) issues.push("Rate card missing for this month");
    else if (provider === "Amazon") {
      if (rates.mg_amount_including_mhe != null) {
        base = subtractAmounts(
          mgEstimate(
            rates.mg_amount_including_mhe,
            index + 1,
            Number(monthDays),
          ),
          mgEstimate(rates.mg_amount_including_mhe, index, Number(monthDays)),
        );
      }
      if (rates.delivery_mg_volume != null) {
        const monthlyVolume = decimal(rates.delivery_mg_volume);
        mgVolume = units(monthlyVolume / monthDays);
        if (s?.deliveries != null) {
          const excessNumerator =
            decimal(s.deliveries) * monthDays - monthlyVolume;
          const positive = excessNumerator > zero ? excessNumerator : zero;
          excessVolume = units(positive / monthDays);
          if (positive === zero) variable = variableAccrual(zero);
          else if (rates.variable_slab != null)
            variable = variableAccrual(
              (positive * decimal(rates.variable_slab)) / (monthDays * scale),
            );
          else issues.push("Excess-delivery rate missing");
        } else if (s) issues.push("Delivery count incomplete");
      } else issues.push("MG volume missing");
      if (s?.mfn != null) {
        if (decimal(s.mfn) === zero) mfnRevenue = mfnAccrual(zero);
        else if (rates.mfn_rate != null)
          mfnRevenue = mfnAccrual(
            (decimal(s.mfn) * decimal(rates.mfn_rate)) / scale,
          );
        else issues.push("MFN rate missing");
      } else if (s) issues.push("MFN count incomplete");
      if (s?.ihs == null && s) issues.push("IHS breakdown unavailable");
      else if (s?.ihs && decimal(s.ihs) > zero)
        issues.push("IHS earnings pending confirmation of the 15% rate rule");
      if (s?.smd == null && s) issues.push("SMD breakdown unavailable");
      else if (s?.smd && decimal(s.smd) > zero)
        issues.push(
          "SMD included in deliveries; separate SMD billing rule pending",
        );
      // The confirmed model uses the imported delivery total. Do not bill SMD twice,
      // or guess the IHS denominator/boundary. Their quantities and rates stay visible.
      revenue = base === null ? null : addAmounts([base, variable, mfnRevenue]);
    } else if (provider === "Flipkart") {
      if (s?.deliveries != null) {
        flipkartQuantity += decimal(s.deliveries);
        const cumulative = slabEstimate(
          units(flipkartQuantity),
          pricing.slabs,
          pricing.slab_mode,
        );
        if (cumulative !== null) {
          variable = subtractAmounts(cumulative, flipkartPrevious);
          flipkartPrevious = cumulative;
          revenue = variable;
        }
      }
    }
    const cost =
      !sharedCost && c?.total != null ? costAccrual(decimal(c.total)) : null;
    if (sharedCost)
      issues.push("Shared station cost requires client allocation");
    else if (cost === null) issues.push("Cost report pending");
    return {
      date,
      deliveries: s?.deliveries ?? null,
      mgVolume,
      excessVolume,
      base,
      variable,
      mfn: s?.mfn ?? null,
      mfnRevenue,
      smd: s?.smd ?? null,
      ihs: s?.ihs ?? null,
      revenue,
      cost,
      profit:
        revenue !== null && cost !== null
          ? subtractAmounts(revenue, cost)
          : null,
      shipmentReported: Boolean(s),
      issues,
    };
  });
}

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
  const elapsed = Number(filters.through.slice(8, 10));
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
      basis =
        "Daily MG + daily excess deliveries × variable slab + MFN × MFN rate";
      issues.push(
        "IHS/SMD settlement rules, shortfall recovery, fees and tax are not included",
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
    const daily = buildDailyRows(
      snapshot,
      station,
      provider,
      pricing,
      filters.month,
      filters.through,
      (clientCounts.get(station) ?? 0) > 1,
    );
    if (provider === "Amazon")
      revenue = addAmounts(daily.map((d) => d.revenue));
    const pending = [
      ...new Set(
        daily
          .flatMap((d) => d.issues)
          .filter((i) => !i.startsWith("Cost") && !i.startsWith("Shared")),
      ),
    ];
    issues.push(...pending);
    return [
      {
        daily,
        variableRate: pricing?.rates.variable_slab ?? null,
        mfnRate: pricing?.rates.mfn_rate ?? null,
        smdRate: pricing?.rates.smd_rate ?? null,
        ihsLowRate: pricing?.rates.ihs_rate_below_15_percent ?? null,
        ihsHighRate: pricing?.rates.ihs_rate_above_15_percent ?? null,
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
