import "server-only";
import { rebuildCps, type CpsFacts } from "./cps-engine";
import { cache } from "react";
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
  // The shared owner loader includes hidden masters; CPS's calculation excludes
  // them. Keep pickers, input validation, report counts and the RPC in parity.
  const all = locations.locations.filter((l) => !l.hide_from_location_list);
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
const snapshot = cache(
  async (company: string, from: string, to: string, codesKey: string) => {
    const codes: string[] = JSON.parse(codesKey);
    if (!supabaseAdmin) throw Error("CPS data is temporarily unavailable.");
    const [result, facts] = await Promise.all([supabaseAdmin.rpc("ops_cps_base_v2", {
      p_company: company,
      p_from: from,
      p_through: to,
      p_stations: codes,
    }), supabaseAdmin.rpc("ops_cps_source_facts", { p_company: company, p_from: from, p_through: to, p_stations: codes })]);
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
    if (facts.error || !facts.data || !Array.isArray(facts.data.shipments)) throw Error("Live workforce cost sources could not be loaded. Please retry.");
    return rebuildCps(result.data as CpsSnapshot, facts.data as CpsFacts);
  },
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
    JSON.stringify([...new Set(locations.map((l) => l.station_code))].sort()),
  );
}
export type CpsAssociate = {
  id: string;
  work_date: string;
  station_code: string;
  provider_employee_id: string;
  provider_employee_name: string | null;
  dropx_name: string | null;
  dropx_emp_code: string | null;
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
  const data = await snapshot(company, from, to, JSON.stringify([...codes].sort()));
  const rows = (data.associates ?? []).filter(r => !unmapped || r.mapping_status !== "Mapped").sort((a,b) => b.work_date.localeCompare(a.work_date) || a.station_code.localeCompare(b.station_code) || a.id.localeCompare(b.id));
  return { rows: rows.slice((page-1)*50,page*50), more: rows.length>page*50 };
}
export async function exportCpsAssociates(company: string, from: string, to: string, codes: string[], unmapped: boolean) {
  if (!codes.length) return [];
  const data = await snapshot(company, from, to, JSON.stringify([...codes].sort()));
  return (data.associates ?? []).filter(r => !unmapped || r.mapping_status !== "Mapped");
}

export async function loadCpsInputs(company: string, codes: string[], allAccess = false) {
  if (!codes.length)
    return {
      employees: [] as {id:string; label:string}[],
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
  const [costs, targets, employees] = await Promise.all([
    supabaseAdmin
      .from("ops_cps_cost_inputs")
      .select(
        "id,label,sub_head,employee_id,head,station_codes,amount,frequency,allocation,effective_from,effective_to,is_active,updated_at,notes",
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
    supabaseAdmin.from("employees").select("id,employee_code,full_name,stations(station_code)").eq("company_id",company).is("deleted_at",null).eq("is_active",true).order("full_name").limit(1000),
  ]);
  if (costs.error || targets.error || employees.error)
    throw Error("CPS inputs could not be loaded.");
  if (costs.data?.length === 1000 || targets.data?.length === 1000)
    throw Error("Select fewer stations to manage this many input records.");
  // Do not reveal shared allocations outside the viewer's editable scope.
  return {
    employees: (employees.data ?? []).filter((e:any) => allAccess || codes.includes((Array.isArray(e.stations)?e.stations[0]:e.stations)?.station_code)).map((e:any) => ({id:e.id,label:`${e.employee_code} · ${e.full_name}`})),
    costs: (costs.data ?? []).filter((r) =>
      r.station_codes.every((c: string) => codes.includes(c)),
    ) as CpsCostInput[],
    targets: targets.data ?? [],
  };
}
