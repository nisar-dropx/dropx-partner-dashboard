import "server-only";
import { supabaseAdmin } from "../supabase-admin";
import { readAllRows } from "../supabase-pagination";
import { loadCpsSnapshot } from "./cps-snapshot";
import { buildReviewAssociatePay } from "./review-associate-pay";

export async function loadReviewAssociatePay(companyId: string, date: string,
  locations: { id: string; station_code: string }[], details: Record<string, any>[], shipments: Record<string, any>[]) {
  const base = { date, stations: locations, details, shipments, mappings: [], components: [], links: [], scc: [], snapshot: null };
  if (!supabaseAdmin || !locations.length) return buildReviewAssociatePay({ ...base, error: "Payment calculation unavailable" });
  const db = supabaseAdmin;
  const ids = locations.map(l => l.id);
  const monthStart = `${date.slice(0, 7)}-01`;
  const snapshotPromise = loadCpsSnapshot(companyId, date, date, locations)
    .then(snapshot => ({ snapshot, error: null as string | null }))
    .catch(() => ({ snapshot: null, error: "Live CPS calculation unavailable — retry shortly" }));
  try {
    const [mappingResult, sccResult] = await Promise.all([
      readAllRows(db.from("field_executive_provider_mappings")
        .select("id,workforce_id,provider_member_id,station_id,status,effective_from,effective_to,pay_type,payment_method_id,payment_values,delivery_rate,guarantee_amount,guarantee_schedule,fuel_rate,payment_methods(name)")
        .eq("company_id", companyId).in("station_id", ids).in("status", ["active", "closed"])
        .lte("effective_from", date).or(`effective_to.is.null,effective_to.gte.${monthStart}`).order("id")),
      readAllRows(db.from("workforce_route_scc_snapshots").select("station_id,drivers,observed_at")
        .eq("company_id", companyId).in("station_id", ids).order("station_id")),
    ]);
    if (mappingResult.error) throw Error("Payment mappings could not be loaded");
    const mappings = mappingResult.data ?? [];
    const workforceIds = [...new Set(mappings.map(m => m.workforce_id).filter(Boolean))];
    const methodIds = [...new Set(mappings.map(m => m.payment_method_id).filter(Boolean))];
    const links: Record<string, any>[] = [];
    for (let offset = 0; offset < workforceIds.length; offset += 100) {
      const result = await readAllRows(db.from("workforce_amazon_portal_links")
        .select("workforce_id,transporter_id,last_synced_at").eq("company_id", companyId)
        .in("workforce_id", workforceIds.slice(offset, offset + 100)).order("workforce_id"));
      if (result.error) throw Error("Associate identity links could not be loaded");
      links.push(...result.data ?? []);
    }
    const components = methodIds.length ? await readAllRows(db.from("payment_method_components")
      .select("payment_method_id,component_code,component_type,pay_schedule,label,payment_fields(code,label,pay_schedule,calculation_type,calculation_source,provider_calculation_sources)")
      .eq("company_id", companyId).in("payment_method_id", methodIds).eq("is_active", true).order("id")) : { data: [], error: null };
    if (components.error) throw Error("Payment rate amounts could not be loaded");
    const cost = await snapshotPromise;
    // SCC is supplemental identity evidence. A missing feed never permits a
    // name-based match; verified portal IDs and exact provider IDs still work.
    return buildReviewAssociatePay({ ...base, mappings, components: components.data ?? [], links,
      scc: sccResult.error ? [] : sccResult.data ?? [], snapshot: cost.snapshot, error: cost.error });
  } catch (error) {
    await snapshotPromise;
    return buildReviewAssociatePay({ ...base, error: error instanceof Error ? error.message : "Payment calculation unavailable" });
  }
}
