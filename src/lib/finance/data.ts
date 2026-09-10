import "server-only";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import {
  hasPermission,
  requirePagePermission,
  type AuthorizationContext,
} from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { isFinanceHostName } from "@/lib/finance/surface";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadCodLocations, type CodLocationRow } from "@/lib/ops-pulse/cod";
import { monthEnd, todayIndia, validMonth, type PricingCard } from "./pricing";
import { buildBusinessRows, type Snapshot } from "./performance";

export async function financeContext(code: string) {
  const host = headers().get("x-forwarded-host") ?? headers().get("host") ?? "";
  if (!isFinanceHostName(host)) notFound();
  const authorization = await requirePagePermission(code, "access");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin)
    throw new Error("Finance data is unavailable. Please retry.");
  const { locations, error } = await loadCodLocations(
    companyId,
    authorization.locationScopeIds,
    authorization.hasAllLocationAccess,
  );
  if (error)
    throw new Error("Unable to load your permitted locations. Please retry.");
  const topology: {
    id: string;
    station_code: string;
    parent_station_id: string | null;
  }[] = [];
  for (let offset = 0; ; offset += 1000) {
    const result = await supabaseAdmin
      .from("stations")
      .select("id,station_code,parent_station_id")
      .eq("company_id", companyId)
      .order("id")
      .range(offset, offset + 999);
    if (result.error)
      throw new Error("Unable to load Finance station relationships.");
    topology.push(...(result.data ?? []));
    if ((result.data ?? []).length < 1000) break;
  }
  const byId = new Map(topology.map((l) => [l.id, l]));
  const byCode = new Map(topology.map((l) => [l.station_code, l]));
  const financeLocations = locations.map((l) => {
    const model = Array.isArray(l.location_models)
      ? l.location_models[0]
      : l.location_models;
    const parentId = byCode.get(l.station_code)?.parent_station_id;
    return {
      ...l,
      pricing_model:
        String(model?.code ?? "").toUpperCase() === "XPT" ? "xpt" : "mg",
      parent_station_code: parentId
        ? (byId.get(parentId)?.station_code ?? null)
        : null,
    };
  });
  return {
    authorization,
    companyId,
    locations: financeLocations,
    db: supabaseAdmin,
  };
}
export type FinanceContext = Awaited<ReturnType<typeof financeContext>>;
export function canWritePricing(auth: AuthorizationContext, revision: number) {
  return hasPermission(auth, "finance_pricing", revision ? "edit" : "add");
}
export async function loadPricing(
  context: FinanceContext,
  month?: string,
  station?: string,
  asOf = false,
) {
  const rows: PricingCard[] = [];
  for (let offset = 0; ; offset += 1000) {
    let query = context.db
      .from("finance_pricing_revisions")
      .select(
        "id,provider,station_code,effective_month,revision,rates,slabs,slab_mode,reason,source_file,source_sha256,created_at",
      )
      .eq("company_id", context.companyId)
      .order("effective_month", { ascending: false })
      .order("station_code")
      .order("revision", { ascending: false })
      .order("id")
      .range(offset, offset + 999);
    if (month)
      query = asOf
        ? query.lte("effective_month", `${month}-01`)
        : query.eq("effective_month", `${month}-01`);
    if (station) query = query.eq("station_code", station);
    if (!context.authorization.hasAllLocationAccess)
      query = query.in(
        "station_code",
        context.locations.length
          ? context.locations.map((l) => l.station_code)
          : ["__no_access__"],
      );
    const { data, error } = await query;
    if (error) throw new Error("Unable to load pricing records. Please retry.");
    rows.push(...((data ?? []) as PricingCard[]));
    if ((data ?? []).length < 1000) break;
  }
  return rows;
}
export function latestCards(history: PricingCard[]) {
  const seen = new Set<string>();
  return history.filter((c) => {
    const key = `${c.provider}/${c.station_code}/${c.effective_month}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
export function effectiveCards(history: PricingCard[], month: string) {
  const cutoff = `${month}-01`;
  const seen = new Set<string>();
  return [...history]
    .filter((card) => card.effective_month <= cutoff)
    .sort(
      (a, b) =>
        b.effective_month.localeCompare(a.effective_month) ||
        b.revision - a.revision ||
        b.created_at.localeCompare(a.created_at) ||
        b.id.localeCompare(a.id),
    )
    .filter((card) => {
      const key = `${card.provider}/${card.station_code}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
export type Query = Record<string, string | string[] | undefined>;
function value(query: Query, key: string) {
  const v = query[key];
  return typeof v === "string" ? v.trim().slice(0, 200) : "";
}
export function businessFilters(query: Query) {
  const today = todayIndia();
  const month = value(query, "month") || today.slice(0, 7);
  if (!validMonth(month) || month > today.slice(0, 7))
    throw new Error("Choose a billing month no later than the current month.");
  const maximum = monthEnd(month) < today ? monthEnd(month) : today;
  const through = value(query, "through") || maximum;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(through) ||
    through < `${month}-01` ||
    through > maximum
  )
    throw new Error(
      "Through date must be within the billing month and no later than today.",
    );
  const provider = value(query, "provider");
  if (provider && !["Amazon", "Flipkart"].includes(provider))
    throw new Error("Unknown client filter.");
  return {
    month,
    through,
    provider,
    region: value(query, "region"),
    cluster: value(query, "cluster"),
    location: value(query, "location"),
    includeXpts: value(query, "includeXpts") === "0" ? "0" : "1",
  };
}
export function filterLocations(
  locations: Array<
    CodLocationRow & {
      parent_station_code?: string | null;
      pricing_model?: string;
    }
  >,
  filters: ReturnType<typeof businessFilters>,
) {
  return locations.filter(
    (l) =>
      (!filters.location ||
        l.station_code === filters.location ||
        (filters.includeXpts !== "0" &&
          l.parent_station_code === filters.location)) &&
      (!filters.region || (l.region || "Unassigned") === filters.region) &&
      (!filters.cluster || (l.cluster || "Unassigned") === filters.cluster),
  );
}
export async function loadBusiness(context: FinanceContext, query: Query) {
  const filters = businessFilters(query);
  const selected = filterLocations(context.locations, filters);
  const filterByLocation =
    !context.authorization.hasAllLocationAccess ||
    Boolean(filters.location || filters.region || filters.cluster);
  const stationCodes = filterByLocation
    ? selected.map((l) => l.station_code)
    : null;
  const [response, history] = await Promise.all([
    context.db.rpc("finance_business_daily_snapshot", {
      p_company: context.companyId,
      p_from: `${filters.month}-01`,
      p_through: filters.through,
      p_station_codes: stationCodes,
    }),
    loadPricing(context, filters.month, undefined, true),
  ]);
  if (response.error)
    throw new Error(
      "Unable to load live shipment and cost data. Please retry.",
    );
  const cards = effectiveCards(history, filters.month).filter(
    (c) => stationCodes === null || stationCodes.includes(c.station_code),
  );
  const snapshot = response.data as Snapshot;
  const parents = [
    ...new Set(
      selected
        .filter((l) => l.pricing_model === "xpt" && l.parent_station_code)
        .map((l) => l.parent_station_code!),
    ),
  ];
  const parentRates: Record<string, { rate: string | null; revision: number }> =
    {};
  if (parents.length) {
    // Only unit rates for parents of authorized XPTs; no parent shipment, cost or P&L data is exposed.
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await context.db
        .from("finance_pricing_revisions")
        .select("id,station_code,effective_month,revision,rates")
        .eq("company_id", context.companyId)
        .eq("provider", "Amazon")
        .lte("effective_month", `${filters.month}-01`)
        .in("station_code", parents)
        .order("effective_month", { ascending: false })
        .order("revision", { ascending: false })
        .order("id")
        .range(offset, offset + 999);
      if (error)
        throw new Error("Unable to load the parent station variable rates.");
      for (const p of data ?? [])
        if (!parentRates[p.station_code])
          parentRates[p.station_code] = {
            rate: p.rates?.variable_slab ?? null,
            revision: p.revision,
          };
      if (
        (data ?? []).length < 1000 ||
        parents.every((parent) => parentRates[parent])
      )
        break;
    }
  }
  const rows = buildBusinessRows(
    snapshot,
    cards,
    selected,
    filters,
    parentRates,
  );
  return { filters, rows, snapshot, readAt: snapshot.read_at };
}
