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
  return { authorization, companyId, locations, db: supabaseAdmin };
}
export type FinanceContext = Awaited<ReturnType<typeof financeContext>>;
export function canWritePricing(auth: AuthorizationContext, revision: number) {
  return hasPermission(auth, "finance_pricing", revision ? "edit" : "add");
}
export async function loadPricing(
  context: FinanceContext,
  month?: string,
  station?: string,
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
    if (month) query = query.eq("effective_month", `${month}-01`);
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
  };
}
export function filterLocations(
  locations: CodLocationRow[],
  filters: ReturnType<typeof businessFilters>,
) {
  return locations.filter(
    (l) =>
      (!filters.location || l.station_code === filters.location) &&
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
    loadPricing(context, filters.month),
  ]);
  if (response.error)
    throw new Error(
      "Unable to load live shipment and cost data. Please retry.",
    );
  const cards = latestCards(history).filter(
    (c) => stationCodes === null || stationCodes.includes(c.station_code),
  );
  const snapshot = response.data as Snapshot;
  const rows = buildBusinessRows(snapshot, cards, selected, filters);
  return { filters, rows, snapshot, readAt: snapshot.read_at };
}
