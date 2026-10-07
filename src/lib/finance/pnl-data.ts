import "server-only";
import { loadPricing, effectiveCards, type FinanceContext } from "./data";
import {
  buildBusinessRows,
  type Snapshot,
  type BusinessRow,
} from "./performance";
import { buildPnl, pnlFilters, cpsMonthSlices, type PnlQuery } from "./pnl";
import { loadCpsSnapshot } from "../ops-pulse/cps-data";
import type { CpsSnapshot } from "../ops-pulse/cps";
import { addQuantities } from "./pricing";
import { stationGroupKey } from "./pnl-comparison";

export type SourceAvailability = Record<
  string,
  { from: string | null; to: string | null; updated_at: string | null }
>;
export async function loadPnl(context: FinanceContext, query: PnlQuery, sharedCosts?: Promise<CpsSnapshot>) {
  const filters = pnlFilters(query);
  // P&L treats an EDSP parent and its XPTs as one business unit.
  filters.includeXpts = true;
  const allowed = context.locations.filter(
    (l) =>
      !l.hide_from_location_list &&
      !l.is_ho &&
      !/^HO(?:_|$)/i.test(l.station_code),
  );
  const byCode = new Map(allowed.map(l => [l.station_code, l]));
  const selected = byCode.get(filters.location);
  if (selected) filters.location = stationGroupKey(selected);
  const locations = allowed.filter((l) => {
    const group = byCode.get(stationGroupKey(l)) ?? l;
    const provider = Array.isArray(group.providers) ? group.providers[0] : group.providers;
    return (
      (!filters.location ||
        stationGroupKey(l) === filters.location) &&
      (!filters.region || (group.region || "Unassigned") === filters.region) &&
      (!filters.cluster || (group.cluster || "Unassigned") === filters.cluster) &&
      (!filters.provider ||
        (provider?.name || provider?.code || "").toLowerCase() ===
          filters.provider.toLowerCase())
    );
  });
  // Never pass null as a station scope: it means unrestricted access to the RPC.
  const codes = locations.map((l) => l.station_code),
    codeSet = new Set(codes);
  const [revenueResponse, history, costResponse] = await Promise.all([
    context.db.rpc("finance_pnl_revenue_snapshot", {
      p_company: context.companyId,
      p_from: `${filters.from.slice(0, 7)}-01`,
      p_through: filters.to,
      p_station_codes: codes,
    }),
    loadPricing(context, filters.to.slice(0, 7), undefined, true),
    (sharedCosts ?? loadCpsSnapshot(context.companyId, filters.from, filters.to, locations))
      .then((data) => ({ data, error: "" }))
      .catch((error: unknown) => {
        console.error(
          "Finance P&L cost load failed",
          error instanceof Error ? error.message : "Unknown error",
        );
        return {
          data: null,
          error:
            "Live costs could not be refreshed. Retry before using this result.",
        };
      }),
  ]);
  if (revenueResponse.error) {
    console.error("Finance P&L revenue source failed", {
      code: revenueResponse.error.code,
      message: revenueResponse.error.message,
      stationCount: codes.length,
      from: filters.from,
      through: filters.to,
    });
    throw Error("Revenue data could not be loaded. Please retry.");
  }
  const snapshot = revenueResponse.data as Snapshot & {
    availability: SourceAvailability;
  };
  const parents = [
    ...new Set(
      locations
        .filter((l) => l.pricing_model === "xpt")
        .map((l) => l.parent_station_code)
        .filter((c): c is string => Boolean(c)),
    ),
  ];
  // Unit rates only for authorized XPT parents. No out-of-scope parent financials.
  const parentHistory: {
    station_code: string;
    effective_month: string;
    revision: number;
    rates: Record<string, string | null>;
  }[] = history.filter(card => card.provider === "Amazon" && parents.includes(card.station_code));
  // Authorized parents are already in the complete pricing history. Only an
  // XPT-only scope needs the separate, unit-rate-only parent lookup.
  const extraParents = parents.filter(code => !context.authorization.hasAllLocationAccess && !context.locations.some(l => l.station_code === code));
  if (extraParents.length) {
    for (let offset = 0; ; offset += 1000) {
      const result = await context.db
        .from("finance_pricing_revisions")
        .select("station_code,effective_month,revision,rates")
        .eq("company_id", context.companyId)
        .eq("provider", "Amazon")
        .in("station_code", extraParents)
        .lte("effective_month", `${filters.to.slice(0, 7)}-01`)
        .order("effective_month", { ascending: false })
        .order("revision", { ascending: false })
        .order("id")
        .range(offset, offset + 999);
      if (result.error)
        throw Error("Parent station pricing could not be loaded.");
      parentHistory.push(...(result.data ?? []));
      if ((result.data ?? []).length < 1000) break;
    }
  }
  const revenue: BusinessRow[] = [];
  for (const slice of cpsMonthSlices(filters.from, filters.to)) {
    const month = slice.from.slice(0, 7);
    const daily = (snapshot.daily_shipments ?? []).filter(
      (d) => d.work_date.startsWith(month) && codeSet.has(d.station_code),
    );
    const groups = new Map<string, typeof daily>();
    for (const day of daily) {
      const key = `${day.station_code}/${day.client}`;
      groups.set(key, [...(groups.get(key) ?? []), day]);
    }
    const shipments = [...groups.values()].map((days) => ({
      station_code: days[0].station_code,
      client: days[0].client,
      days: days.length,
      first_date: days[0].work_date,
      last_date: days[days.length - 1].work_date,
      deliveries: addQuantities(days.map((d) => d.deliveries)),
      mfn: addQuantities(days.map((d) => d.mfn)),
      returns: addQuantities(days.map((d) => d.returns ?? null)),
      missing_delivery_rows: days.filter((d) => d.deliveries === null).length,
      updated_at: days[0].updated_at,
    }));
    const parentRates: Record<
      string,
      { rate: string | null; revision: number }
    > = {};
    for (const card of parentHistory)
      if (
        card.effective_month <= `${month}-01` &&
        !parentRates[card.station_code]
      )
        parentRates[card.station_code] = {
          rate: card.rates.variable_slab ?? null,
          revision: card.revision,
        };
    revenue.push(
      ...buildBusinessRows(
        {
          ...snapshot,
          shipments,
          costs: [],
          daily_shipments: daily,
          daily_costs: [],
        },
        effectiveCards(history, month).filter((c) =>
          codeSet.has(c.station_code),
        ),
        locations,
        { month, through: slice.to, provider: "" },
        parentRates,
      ),
    );
  }
  const cps: CpsSnapshot = costResponse.data ?? {
    daily: [],
    breakup: [],
    generated_at: new Date().toISOString(),
  };
  const report = buildPnl(revenue, cps, locations, filters.from, filters.to);
  const covered = new Set(
    report.days
      .filter((d) => d.cost !== null || d.revenue !== null)
      .map((d) => `${d.station}/${d.date}`),
  );
  return {
    ...report,
    revenueCalculations: revenue.flatMap((r) =>
      r.daily
        .filter((d) => covered.has(`${r.station}/${d.date}`))
        .map((d) => ({
          station: r.station,
          provider: r.provider,
          model: r.model,
          ...d,
        })),
    ),
    filters,
    readAt: snapshot.read_at,
    availability: snapshot.availability,
    costError: costResponse.error,
    // Send minimal picker metadata, never entire station records or auth context.
    locations: allowed.map((l) => ({
      station_code: l.station_code,
      station_name: l.station_name,
      region: l.region || "Unassigned",
      cluster: l.cluster || "Unassigned",
      pricing_model: l.pricing_model,
      parent_station_code: l.parent_station_code,
    })),
    pricing: revenue.map((r) => ({
      station: r.station,
      month: r.daily[0]?.date.slice(0, 7),
      provider: r.provider,
      revision: r.revision,
      effective: r.pricingEffectiveMonth,
      basis: r.basis,
      variable: r.variableRate,
      mfn: r.mfnRate,
      mg: r.mg,
      mgVolume: r.mgVolume,
      monthlyFee: r.model === "xpt" ? null : r.monthlyFee,
      model: r.model,
      parent: r.parentStation,
      swaRate:
        effectiveCards(
          history,
          r.daily[0]?.date.slice(0, 7) || filters.month,
        ).find((c) => c.station_code === r.station && c.provider === r.provider)
          ?.rates.swa_delivery_rate ?? null,
      slabs:
        effectiveCards(
          history,
          r.daily[0]?.date.slice(0, 7) || filters.month,
        ).find((c) => c.station_code === r.station && c.provider === r.provider)
          ?.slabs ?? [],
    })),
  };
}
export type LivePnl = Awaited<ReturnType<typeof loadPnl>>;
