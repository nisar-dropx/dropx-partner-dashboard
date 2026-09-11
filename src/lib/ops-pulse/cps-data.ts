import "server-only";
import { unstable_cache } from "next/cache";
import { requireCompanyId } from "@/lib/company-scope";
import type { AuthorizationContext } from "@/lib/authorization";
import { loadCodLocations, todayKolkata, type CodLocationRow } from "./cod";
import { adHocClusterLabel } from "./adhoc-activity";
import {
  cpsPeriod,
  type CpsParams,
  type CpsSnapshot,
  type CpsCostInput,
} from "./cps";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function cpsScope(auth: AuthorizationContext, params: CpsParams) {
  const companyId = requireCompanyId(auth);
  const locations = await loadCodLocations(
    companyId,
    auth.locationScopeIds,
    auth.hasAllLocationAccess,
  );
  if (locations.error)
    throw Error("Location access could not be loaded. Please retry.");
  const all = locations.locations;
  const selected = all.filter(
    (l) =>
      (!params.station || l.station_code === params.station) &&
      (!params.cluster || adHocClusterLabel(l) === params.cluster) &&
      (!params.region || (l.region || "Unassigned") === params.region),
  );
  return {
    companyId,
    all,
    selected,
    period: cpsPeriod(params, todayKolkata()),
  };
}
// No cookies/auth context inside the cache. Every read is scoped first and every
// company, station list and exact date range participates in the cache key.
const snapshot = unstable_cache(
  async (company: string, from: string, to: string, codes: string[]) => {
    if (!supabaseAdmin) throw Error("CPS data is temporarily unavailable.");
    const result = await supabaseAdmin.rpc("ops_cps_live_snapshot", {
      p_company: company,
      p_from: from,
      p_through: to,
      p_stations: codes,
    });
    if (result.error) {
      console.error("CPS snapshot failed", result.error.code);
      throw Error("CPS data could not be loaded. Please retry shortly.");
    }
    if (
      !result.data ||
      !Array.isArray(result.data.daily) ||
      !Array.isArray(result.data.breakup)
    )
      throw Error("CPS returned an incomplete response.");
    return result.data as CpsSnapshot;
  },
  ["ops-cps-live-v1"],
  { revalidate: 30, tags: ["ops-cps"] },
);
export async function loadCpsSnapshot(
  company: string,
  from: string,
  to: string,
  locations: CodLocationRow[],
) {
  if (!locations.length)
    return {
      daily: [],
      breakup: [],
      generated_at: new Date().toISOString(),
    } as CpsSnapshot;
  return snapshot(
    company,
    from,
    to,
    [...new Set(locations.map((l) => l.station_code))].sort(),
  );
}
export type CpsAssociate = {
  id: string;
  work_date: string;
  station_code: string;
  provider_employee_id: string;
  provider_employee_name: string | null;
  dropx_name: string | null;
  pay_type: string | null;
  total_delivery: number;
  c_return: number;
  mfn: number;
  mfn_return: number;
  variable_pay: number;
  mg_pay: number;
  fuel_pay: number;
  da_total_pay: number;
  mapping_status: string;
};
export async function loadCpsAssociates(
  company: string,
  from: string,
  to: string,
  codes: string[],
  page: number,
  unmapped = false,
) {
  if (!codes.length) return { rows: [] as CpsAssociate[], more: false };
  if (!supabaseAdmin) throw Error("Associate data is temporarily unavailable.");
  let query = supabaseAdmin
    .from("cps_shipment_daily")
    .select(
      "id,work_date,station_code,provider_employee_id,provider_employee_name,dropx_name,pay_type,total_delivery,c_return,mfn,mfn_return,variable_pay,mg_pay,fuel_pay,da_total_pay,mapping_status",
    )
    .eq("company_id", company)
    .in("station_code", codes)
    .gte("work_date", from)
    .lte("work_date", to);
  if (unmapped) query = query.neq("mapping_status", "Mapped");
  const result = await query
    .order("work_date", { ascending: false })
    .order("station_code")
    .order("id")
    .range((page - 1) * 50, page * 50);
  if (result.error) throw Error("Associate data could not be loaded.");
  return {
    rows: (result.data ?? []).slice(0, 50) as CpsAssociate[],
    more: (result.data?.length ?? 0) > 50,
  };
}
export async function exportCpsAssociates(
  company: string,
  from: string,
  to: string,
  codes: string[],
  unmapped: boolean,
) {
  if (!supabaseAdmin)
    throw Error("Associate export is temporarily unavailable.");
  const rows: CpsAssociate[] = [];
  for (let offset = 0; offset < 30000; offset += 1000) {
    let q = supabaseAdmin
      .from("cps_shipment_daily")
      .select(
        "id,work_date,station_code,provider_employee_id,provider_employee_name,dropx_name,pay_type,total_delivery,c_return,mfn,mfn_return,variable_pay,mg_pay,fuel_pay,da_total_pay,mapping_status",
      )
      .eq("company_id", company)
      .in("station_code", codes)
      .gte("work_date", from)
      .lte("work_date", to);
    if (unmapped) q = q.neq("mapping_status", "Mapped");
    const result = await q
      .order("work_date")
      .order("station_code")
      .order("id")
      .range(offset, offset + 999);
    if (result.error) throw Error("Associate export could not be loaded.");
    rows.push(...((result.data ?? []) as CpsAssociate[]));
    if ((result.data?.length ?? 0) < 1000) return rows;
  }
  throw Error(
    "Select fewer locations to export more than 30,000 associate-days.",
  );
}
export async function loadCpsInputs(company: string, codes: string[]) {
  if (!codes.length)
    return {
      costs: [] as CpsCostInput[],
      targets: [] as Array<{
        id: string;
        station_code: string;
        target_cps: number;
        effective_from: string;
        is_active: boolean;
      }>,
    };
  if (!supabaseAdmin) throw Error("CPS inputs are temporarily unavailable.");
  const [costs, targets] = await Promise.all([
    supabaseAdmin
      .from("ops_cps_cost_inputs")
      .select(
        "id,label,head,station_codes,amount,frequency,allocation,effective_from,effective_to,is_active,updated_at,notes",
      )
      .eq("company_id", company)
      .overlaps("station_codes", codes)
      .order("effective_from", { ascending: false })
      .limit(1000),
    supabaseAdmin
      .from("cps_station_targets")
      .select("id,station_code,target_cps,effective_from,is_active")
      .eq("company_id", company)
      .in("station_code", codes)
      .order("effective_from", { ascending: false })
      .limit(1000),
  ]);
  if (costs.error || targets.error)
    throw Error("CPS inputs could not be loaded.");
  if (costs.data?.length === 1000 || targets.data?.length === 1000)
    throw Error("Select fewer stations to manage this many input records.");
  // Do not reveal shared allocations outside the viewer's editable scope.
  return {
    costs: (costs.data ?? []).filter((r) =>
      r.station_codes.every((c: string) => codes.includes(c)),
    ) as CpsCostInput[],
    targets: targets.data ?? [],
  };
}
