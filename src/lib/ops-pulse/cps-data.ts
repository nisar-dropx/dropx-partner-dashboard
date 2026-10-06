import "server-only";
import { loadCpsSnapshot } from "./cps-snapshot";
export { loadCpsSnapshot } from "./cps-snapshot";
import { requireCompanyId } from "@/lib/company-scope";
import type { AuthorizationContext } from "@/lib/authorization";
import { loadCodLocations, locationModelName, todayKolkata, type CodLocationRow } from "./cod";
import { adHocClusterLabel } from "./adhoc-activity";
import {
  cpsPeriod,
  selectedCpsStations,
  type CpsParams,
  type CpsSnapshot,
  type CpsCostInput,
} from "./cps";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";

export async function cpsScope(auth: AuthorizationContext, params: CpsParams, groupParents = false) {
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
  const permitted = locations.locations.filter(
    (l) =>
      !l.hide_from_location_list &&
      !l.is_ho &&
      !/^HO(?:_|$)/i.test(l.station_code),
  );
  // Relationships are metadata only: never use this company-wide read to widen
  // the financial scope returned by the authorized location loader.
  type Topology = { id: string; station_code: string; parent_station_id: string | null };
  let topology: Topology[] = [];
  if (groupParents && permitted.some(l => locationModelName(l).toLowerCase() === "xpt")) {
    if (!supabaseAdmin) throw Error("Station group setup could not be loaded. Please retry.");
    const result = await readAllRows(supabaseAdmin.from("stations")
      .select("id,station_code,parent_station_id").eq("company_id", companyId).order("id"));
    if (result.error) throw Error("Station group setup could not be loaded. Please retry.");
    topology = (result.data ?? []) as Topology[];
  }
  const byId = new Map(topology.map(l => [l.id, l]));
  const all = permitted.map(l => {
    const is_xpt = locationModelName(l).toLowerCase() === "xpt";
    const parentId = byId.get(l.id)?.parent_station_id;
    return { ...l, is_xpt, parent_station_code: is_xpt && parentId ? byId.get(parentId)?.station_code || "" : "" };
  });
  const byCode = new Map(all.map(l => [l.station_code, l]));
  const groupKey = (l: typeof all[number]) => groupParents && l.parent_station_code ? l.parent_station_code : l.station_code;
  const requested = selectedCpsStations(params.station).map(code => {
    const location = byCode.get(code);
    return location ? groupKey(location) : code;
  });
  const selected = all.filter(
    (l) => {
      const filterLocation = groupParents ? byCode.get(groupKey(l)) || l : l;
      return (!requested.length || requested.includes(groupKey(l))) &&
        (!params.cluster || adHocClusterLabel(filterLocation) === params.cluster) &&
        (!params.region || (filterLocation.region || "Unassigned") === params.region);
    },
  );
  return {
    companyId,
    all,
    selected,
    period: cpsPeriod(params, todayKolkata()),
  };
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
  const data = await loadCpsSnapshot(
    company,
    from,
    to,
    codes.map((station_code) => ({ station_code }) as CodLocationRow),
  );
  const rows = (data.associates ?? [])
    .filter((r) => !unmapped || r.mapping_status !== "Mapped")
    .sort(
      (a, b) =>
        b.work_date.localeCompare(a.work_date) ||
        a.station_code.localeCompare(b.station_code) ||
        a.id.localeCompare(b.id),
    );
  return {
    rows: rows.slice((page - 1) * 50, page * 50),
    more: rows.length > page * 50,
  };
}
export async function exportCpsAssociates(
  company: string,
  from: string,
  to: string,
  codes: string[],
  unmapped: boolean,
) {
  if (!codes.length) return [];
  const data = await loadCpsSnapshot(
    company,
    from,
    to,
    codes.map((station_code) => ({ station_code }) as CodLocationRow),
  );
  return (data.associates ?? []).filter(
    (r) => !unmapped || r.mapping_status !== "Mapped",
  );
}

export async function loadCpsInputs(
  company: string,
  codes: string[],
  allAccess = false,
) {
  if (!codes.length)
    return {
      employees: [] as { id: string; label: string }[],
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
    supabaseAdmin
      .from("employees")
      .select("id,employee_code,stations(station_code)")
      .eq("company_id", company)
      .is("deleted_at", null)
      .eq("is_active", true)
      .order("employee_code")
      .limit(1000),
  ]);
  if (costs.error || targets.error || employees.error)
    throw Error("CPS inputs could not be loaded.");
  if (costs.data?.length === 1000 || targets.data?.length === 1000)
    throw Error("Select fewer stations to manage this many input records.");
  // Do not reveal shared allocations outside the viewer's editable scope.
  return {
    employees: (employees.data ?? [])
      .filter(
        (e: any) =>
          allAccess ||
          codes.includes(
            (Array.isArray(e.stations) ? e.stations[0] : e.stations)
              ?.station_code,
          ),
      )
      .map((e: any) => ({ id: e.id, label: e.employee_code })),
    costs: (costs.data ?? []).filter((r) =>
      r.station_codes.every((c: string) => codes.includes(c)),
    ) as CpsCostInput[],
    targets: targets.data ?? [],
  };
}
