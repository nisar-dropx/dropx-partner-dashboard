import "server-only";
import { excludeAdvertisingSettlements } from "./advertising";
import { loadAdvertising } from "./advertising-data";
import { rebuildCps, type CpsFacts } from "./cps-engine";
import { cache } from "react";
import type { CpsCalculationEvidence } from "./cps-details";
import { requireCompanyId } from "@/lib/company-scope";
import type { AuthorizationContext } from "@/lib/authorization";
import { loadCodLocations, todayKolkata, type CodLocationRow } from "./cod";
import { adHocClusterLabel } from "./adhoc-activity";
import {
  cpsPeriod,
  cpsMonthSlices,
  mergeCpsMonths,
  selectedCpsStations,
  type CpsParams,
  type CpsSnapshot,
  type CpsCostInput,
} from "./cps";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";
import { workforcePaymentMonthStart } from "@/lib/workforce-payment-policy";
import type { WorkforceAttendanceCaptureSetting } from "@/lib/workforce-attendance-capture";

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
  const all = locations.locations.filter(
    (l) =>
      !l.hide_from_location_list &&
      !l.is_ho &&
      !/^HO(?:_|$)/i.test(l.station_code),
  );
  const requested = selectedCpsStations(params.station);
  const selected = all.filter(
    (l) =>
      (!requested.length || requested.includes(l.station_code)) &&
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
  async (
    company: string,
    from: string,
    to: string,
    codesKey: string,
    captureEvidence = false,
  ) => {
    const codes: string[] = JSON.parse(codesKey);
    if (!supabaseAdmin) throw Error("CPS data is temporarily unavailable.");
    const attendanceFrom = workforcePaymentMonthStart(from);
    const [
      result,
      facts,
      paymentPolicy,
      attendanceCapture,
      monthAttendance,
      monthSourceFacts,
      vehicleCosts,
      peoplePolicies,
      componentPolicies,
      stationFlags,
      peopleAssignments,
      advertising,
      productionFallbacks,
    ] = await Promise.all([
      supabaseAdmin.rpc("ops_cps_base_v2", {
        p_company: company,
        p_from: from,
        p_through: to,
        p_stations: codes,
      }),
      supabaseAdmin.rpc("ops_cps_source_facts", {
        p_company: company,
        p_from: from,
        p_through: to,
        p_stations: codes,
      }),
      supabaseAdmin
        .from("workforce_payment_settings")
        .select(
          "id,calculation_method,paid_off_days,work_units_per_paid_off,cap_at_monthly_amount,effective_from",
        )
        .eq("company_id", company)
        .lte("effective_from", to)
        .order("effective_from"),
      supabaseAdmin
        .from("workforce_attendance_capture_settings")
        .select("id,capture_method,minimum_daily_deliveries,review_below_deliveries,effective_from")
        .eq("company_id", company)
        .lte("effective_from", to)
        .order("effective_from"),
      readAllRows(
        supabaseAdmin
          .from("attendance_daily")
          .select(
            "id,workforce_id,employee_id,contractor_id,field_executive_id,punch_date,status,in_time,out_time,work_minutes",
          )
          .eq("company_id", company)
          .gte("punch_date", workforcePaymentMonthStart(from))
          .lte("punch_date", to)
          .order("punch_date")
          .order("id"),
      ),
      attendanceFrom === from
        ? Promise.resolve({ data: null, error: null })
        : supabaseAdmin.rpc("ops_cps_source_facts", {
            p_company: company,
            p_from: attendanceFrom,
            p_through: to,
            p_stations: codes,
          }),
      supabaseAdmin.rpc("ops_cps_vehicle_costs", {
        p_company: company,
        p_from: from,
        p_through: to,
        p_stations: codes,
      }),
      supabaseAdmin
        .from("ops_cps_people_policies")
        .select(
          "designation_code,designation_name,mode,head,label,allocation,effective_from",
        )
        .eq("company_id", company)
        .lte("effective_from", to)
        .limit(1000),
      supabaseAdmin
        .from("ops_cps_component_policies")
        .select("component_code,label,mode,effective_from")
        .eq("company_id", company)
        .lte("effective_from", to)
        .limit(1000),
      supabaseAdmin
        .from("stations")
        .select("id,is_ho")
        .eq("company_id", company)
        .limit(1000),
      supabaseAdmin.rpc("ops_cps_people_assignments", {
        p_company: company,
        p_from: from,
        p_through: to,
      }),
      loadAdvertising(company, from, to, codes),
      supabaseAdmin.from("ops_cps_production_fallback_policies").select("field_code,mode,lookback_months,minimum_history_days,effective_from").eq("company_id",company).lte("effective_from",to).order("effective_from"),
    ]);
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
    if (facts.error || !facts.data || !Array.isArray(facts.data.shipments))
      throw Error(
        "Live workforce cost sources could not be loaded. Please retry.",
      );
    if (
      paymentPolicy.error ||
      attendanceCapture.error ||
      monthAttendance.error ||
      monthSourceFacts.error
    )
      throw Error(
        "Workforce attendance payment policy could not be loaded. Please retry.",
      );
    if (
      vehicleCosts.error ||
      !Array.isArray(vehicleCosts.data?.breakup) ||
      !Array.isArray(vehicleCosts.data?.gaps)
    )
      throw Error("Fleet vehicle costs could not be loaded. Please retry.");
    if (
      stationFlags.error ||
      stationFlags.data?.length === 1000 ||
      componentPolicies.error || componentPolicies.data?.length === 1000 ||
      peoplePolicies.error ||
      peoplePolicies.data?.length === 1000
    )
      throw Error("CPS allocation settings could not be loaded.");
    if (
      peopleAssignments.error ||
      !Array.isArray(peopleAssignments.data?.assignments) ||
      !Array.isArray(peopleAssignments.data?.employees) ||
      !Array.isArray(peopleAssignments.data?.salaries) ||
      !Array.isArray(peopleAssignments.data?.stations) ||
      !Array.isArray(peopleAssignments.data?.volumes)
    )
      throw Error(
        "People station assignments could not be loaded. Please retry.",
      );
    if(productionFallbacks.error) throw Error("P&L fuel fallback rules could not be loaded.");
    const sourceFacts = facts.data as CpsFacts;
    sourceFacts.production_fallback_policies = productionFallbacks.data ?? [];
    if(sourceFacts.production_fallback_policies.some(p=>p.mode!=="disabled")) {
      const historyFrom=new Date(`${attendanceFrom}T00:00:00Z`);
      historyFrom.setUTCMonth(historyFrom.getUTCMonth()-Math.max(...sourceFacts.production_fallback_policies.map(p=>p.lookback_months)));
      // Load through month-end to recognize actual monthly uploads before adding estimates.
      const historyThrough=new Date(Date.UTC(Number(to.slice(0,4)),Number(to.slice(5,7)),0)).toISOString().slice(0,10);
      const history=await supabaseAdmin.rpc("ops_cps_production_history",{p_company:company,p_from:historyFrom.toISOString().slice(0,10),p_through:historyThrough});
      if(history.error || !Array.isArray(history.data)) throw Error("P&L historical inputs could not be loaded.");
      sourceFacts.production_history=history.data;
    }
    const productionThresholdFacts = (monthSourceFacts.data ?? sourceFacts) as CpsFacts;
    const productionThresholdMappings = productionThresholdFacts.mappings ?? [];
    const providerMappingIds = [...new Set([...(sourceFacts.mappings ?? []), ...productionThresholdMappings]
      .map((mapping) => String(mapping.id ?? "").trim())
      .filter(Boolean))];
    const providerMethodIds = [...new Set([...(sourceFacts.mappings ?? []), ...productionThresholdMappings]
      .map((mapping) => String(mapping.payment_method_id ?? "").trim())
      .filter(Boolean))];
    const [thresholdMappings, thresholdMethods, thresholdComponentOrder] = await Promise.all([
      providerMappingIds.length
        ? readAllRows(supabaseAdmin
          .from("field_executive_provider_mappings")
          .select("id,production_threshold_config")
          .eq("company_id", company)
          .order("id"))
        : Promise.resolve({ data: [], error: null }),
      providerMethodIds.length
        ? readAllRows(supabaseAdmin
          .from("payment_methods")
          .select("id,production_threshold_config")
          .eq("company_id", company)
          .in("id", providerMethodIds)
          .order("id"))
        : Promise.resolve({ data: [], error: null }),
      providerMethodIds.length
        ? readAllRows(supabaseAdmin
          .from("payment_method_components")
          .select("payment_method_id,payment_field_id,component_code,sort_order,payment_fields(field_type,calculation_type,calculation_source,is_custom_production)")
          .eq("company_id", company)
          .in("payment_method_id", providerMethodIds)
          .eq("is_active", true)
          .order("payment_method_id")
          .order("sort_order")
          .order("id"))
        : Promise.resolve({ data: [], error: null })
    ]);
    if (thresholdMappings.error || thresholdMethods.error || thresholdComponentOrder.error) {
      throw Error("Combined production minimum settings could not be loaded. Please retry.");
    }
    const thresholdByMappingId = new Map((thresholdMappings.data ?? [])
      .map((mapping) => [String(mapping.id), mapping.production_threshold_config]));
    const thresholdByMethodId = new Map((thresholdMethods.data ?? [])
      .map((method) => [String(method.id), method.production_threshold_config]));
    const orderByMethodComponent = new Map((thresholdComponentOrder.data ?? [])
      .map((component) => [
        `${String(component.payment_method_id)}|${String(component.component_code).trim().toUpperCase()}`,
        component
      ]));
    const enrichThresholdMapping = (mapping: Record<string, any>) => ({
      ...mapping,
      production_threshold_config: thresholdByMappingId.get(String(mapping.id)) ?? null,
      method_production_threshold_config: thresholdByMethodId.get(String(mapping.payment_method_id)) ?? null
    });
    const enrichThresholdComponent = (component: Record<string, any>) => {
      const current = orderByMethodComponent.get(`${String(component.payment_method_id)}|${String(component.component_code).trim().toUpperCase()}`);
      const field = Array.isArray(current?.payment_fields) ? current.payment_fields[0] : current?.payment_fields;
      return { ...component, sort_order: current?.sort_order ?? component.sort_order ?? null,
        payment_field_id: current?.payment_field_id ?? component.payment_field_id,
        component_type: field?.field_type ?? component.component_type,
        calculation_type: field?.calculation_type ?? component.calculation_type,
        calculation_source: field?.calculation_source ?? component.calculation_source,
        is_custom_production: field?.is_custom_production ?? component.is_custom_production };
    };
    // Same entered inputs as Dashboard. These private facts never leave the server.
    const payoutInputs = await Promise.all([
      readAllRows(supabaseAdmin.from("workforce_payout_attendance_overrides").select("workforce_id,work_date,attendance_status,work_minutes").eq("company_id", company).gte("work_date", attendanceFrom).lte("work_date", to).order("id")),
      readAllRows(supabaseAdmin.from("workforce_payout_attendance_values").select("id,workforce_id,station_id,attendance_basis,effective_from,effective_to,quantity").eq("company_id", company).lte("effective_from", to).gte("effective_to", attendanceFrom).order("id")),
      readAllRows(supabaseAdmin.from("workforce_payment_field_overrides").select("workforce_id,station_id,payment_field_id,field_code_snapshot,effective_from,effective_to,input_value").eq("company_id", company).lte("effective_from", to).gte("effective_to", attendanceFrom).order("id")),
      readAllRows(supabaseAdmin.from("workforce_custom_production_inputs").select("workforce_id,station_id,payment_field_id,field_code_snapshot,work_date,units").eq("company_id", company).gte("work_date", attendanceFrom).lte("work_date", to).order("id")),
    ]);
    if (payoutInputs.some(result => result.error)) throw Error("Dashboard payment inputs could not be loaded. Please retry.");
    sourceFacts.payout_inputs = {
      attendanceOverrides: payoutInputs[0].data ?? [], attendancePeriods: payoutInputs[1].data ?? [],
      paymentFieldOverrides: payoutInputs[2].data ?? [], productionInputs: payoutInputs[3].data ?? []
    };
    sourceFacts.mappings = (sourceFacts.mappings ?? []).map(enrichThresholdMapping);
    sourceFacts.components = (sourceFacts.components ?? []).map(enrichThresholdComponent);
    productionThresholdFacts.mappings = productionThresholdMappings.map(enrichThresholdMapping);
    productionThresholdFacts.components = (productionThresholdFacts.components ?? []).map(enrichThresholdComponent);
    // Company-private facts stay on the server. Merge current People assignments
    // before calculation, retaining the whole share denominator outside the filter.
    const mergeFacts = (
      original: any[],
      extra: any[],
      identity: (row: any) => string,
    ) => [
      ...new Map(
        [...original, ...extra].map((row) => [identity(row), row]),
      ).values(),
    ];
    sourceFacts.employees = mergeFacts(
      sourceFacts.employees ?? [],
      peopleAssignments.data.employees,
      (row) => row.id,
    );
    sourceFacts.salaries = mergeFacts(
      sourceFacts.salaries ?? [],
      peopleAssignments.data.salaries,
      (row) => row.id,
    );
    sourceFacts.stations = mergeFacts(
      sourceFacts.stations ?? [],
      peopleAssignments.data.stations,
      (row) => row.id,
    );
    sourceFacts.volumes = mergeFacts(
      sourceFacts.volumes ?? [],
      peopleAssignments.data.volumes,
      (row) => `${row.station_code}|${row.work_date}`,
    );
    sourceFacts.people_assignments = peopleAssignments.data.assignments;
    sourceFacts.stations = sourceFacts.stations.map((s) => ({
      ...s,
      is_ho: stationFlags.data?.find((f) => f.id === s.id)?.is_ho ?? s.is_ho,
    }));
    sourceFacts.component_policies = componentPolicies.data ?? [];
    sourceFacts.people_policies =
      peoplePolicies.data as CpsFacts["people_policies"];
    const attendanceFacts = productionThresholdFacts;
    sourceFacts.payment_policy_history = paymentPolicy.data ?? [];
    sourceFacts.attendance_capture_history = (attendanceCapture.data ??
      []) as WorkforceAttendanceCaptureSetting[];
    sourceFacts.attendance = monthAttendance.data ?? [];
    sourceFacts.attendance_shipments = attendanceFacts.shipments ?? [];
    sourceFacts.attendance_mappings = attendanceFacts.mappings ?? [];
    sourceFacts.attendance_workforce = attendanceFacts.workforce ?? [];
    sourceFacts.attendance_providers = attendanceFacts.providers ?? [];
    sourceFacts.attendance_stations = attendanceFacts.stations ?? [];
    sourceFacts.production_threshold_context = {
      shipments: productionThresholdFacts.shipments ?? [],
      mappings: productionThresholdFacts.mappings ?? [],
      workforce: productionThresholdFacts.workforce ?? [],
      components: productionThresholdFacts.components ?? [],
      providers: productionThresholdFacts.providers ?? [],
      stations: productionThresholdFacts.stations ?? [],
    };
    let evidence: CpsCalculationEvidence = { staff: [], associates: [] };
    const costBase = excludeAdvertisingSettlements(result.data as CpsSnapshot, advertising.settlements);
    const report = rebuildCps(
      {
        ...costBase,
        // The base RPC also contains Fleet rent. Replace that source wholesale
        // with its canonical detail feed, including zero/rent-blocked days.
        breakup: [...costBase.breakup.filter(line => line.source !== "Fleet Vehicle Master"), ...vehicleCosts.data.breakup, ...advertising.breakup],
        expense_periods: costBase.expense_periods ?? [],
        vehicles: vehicleCosts.data.vehicles,
        gaps: [...vehicleCosts.data.gaps, ...advertising.gaps],
        advertising: advertising.rows,
      } as CpsSnapshot,
      sourceFacts,
      captureEvidence
        ? (value) => {
            evidence = value;
          }
        : undefined,
    );
    return { report, evidence };
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
  const codes = JSON.stringify(
    [...new Set(locations.map((l) => l.station_code))].sort(),
  );
  const parts: CpsSnapshot[] = [];
  // Bound database concurrency; a date range never becomes a single oversized RPC.
  for (const slice of cpsMonthSlices(from, to))
    parts.push((await snapshot(company, slice.from, slice.to, codes)).report);
  return parts.length === 1 ? parts[0] : mergeCpsMonths(parts);
}
/** Internal server loader. Finance must authorize both the host and every station first. */
export async function loadFinanceCpsEvidence(
  company: string,
  from: string,
  to: string,
  codes: string[],
) {
  const reports: CpsSnapshot[] = [];
  const evidence: CpsCalculationEvidence = { staff: [], associates: [] };
  if (!codes.length) throw Error("Choose a permitted station.");
  for (const slice of cpsMonthSlices(from, to)) {
    const part = await snapshot(
      company,
      slice.from,
      slice.to,
      JSON.stringify([...new Set(codes)].sort()),
      true,
    );
    reports.push(part.report);
    evidence.staff.push(...part.evidence.staff);
    evidence.associates.push(...part.evidence.associates);
  }
  return {
    report: reports.length === 1 ? reports[0] : mergeCpsMonths(reports),
    evidence,
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
