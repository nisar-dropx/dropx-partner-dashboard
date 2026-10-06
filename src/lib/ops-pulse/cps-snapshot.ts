import "server-only";
import { cache } from "react";
import { supabaseAdmin } from "../supabase-admin";
import { readAllRows } from "../supabase-pagination";
import { workforcePaymentMonthStart } from "../workforce-payment-policy";
import type { WorkforceAttendanceCaptureSetting } from "../workforce-attendance-capture";
import { excludeAdvertisingSettlements } from "./advertising";
import { loadAdvertising } from "./advertising-data";
import { rebuildCps, type CpsFacts } from "./cps-engine";
import { cpsMonthSlices, mergeCpsMonths, type CpsSnapshot } from "./cps";

// No cookies/auth context inside the cache. Every read is scoped first and every
// company, station list and exact date range participates in the cache key.
const snapshot = cache(
  async (company: string, from: string, to: string, codesKey: string) => {
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
        .select("id,capture_method,minimum_daily_deliveries,effective_from")
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
    const sourceFacts = facts.data as CpsFacts;
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
          .select("payment_method_id,component_code,sort_order")
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
        Number(component.sort_order)
      ]));
    const enrichThresholdMapping = (mapping: Record<string, any>) => ({
      ...mapping,
      production_threshold_config: thresholdByMappingId.get(String(mapping.id)) ?? null,
      method_production_threshold_config: thresholdByMethodId.get(String(mapping.payment_method_id)) ?? null
    });
    const enrichThresholdComponent = (component: Record<string, any>) => ({
      ...component,
      sort_order: orderByMethodComponent.get(
        `${String(component.payment_method_id)}|${String(component.component_code).trim().toUpperCase()}`
      ) ?? component.sort_order ?? null
    });
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
    const costBase = excludeAdvertisingSettlements(result.data as CpsSnapshot, advertising.settlements);
    return rebuildCps(
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
    );
  },
);
export async function loadCpsSnapshot(
  company: string,
  from: string,
  to: string,
  locations: { station_code: string }[],
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
    parts.push(await snapshot(company, slice.from, slice.to, codes));
  return parts.length === 1 ? parts[0] : mergeCpsMonths(parts);
}
