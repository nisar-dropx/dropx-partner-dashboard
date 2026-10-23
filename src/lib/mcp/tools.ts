import { hasPermission, type AuthorizationContext } from "@/lib/authorization";
import { loadCapacitySnapshot } from "@/lib/ops-pulse/capacity-snapshot";
import { isAmazonEdspXptLocation } from "@/lib/ops-pulse/operating-context";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { indiaDate, parseIsoDate, parseStationCodes } from "@/lib/mcp/dates";
import { resolveScopedLocations } from "@/lib/mcp/scope";
import {
  assertReadOnlyToolName,
  listMcpTools,
  isWriteLikeToolName,
  type McpToolDefinition
} from "@/lib/mcp/tools-policy";

export type { McpToolDefinition };
export { isWriteLikeToolName, listMcpTools };

function n(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function requireToolPermission(authorization: AuthorizationContext, pageCode: string) {
  if (!hasPermission(authorization, pageCode, "access")) {
    throw Object.assign(new Error(`Permission denied for ${pageCode}.`), { code: -32003 });
  }
}

export async function callMcpTool(
  authorization: AuthorizationContext,
  name: string,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  assertReadOnlyToolName(name);
  if (!supabaseAdmin) throw Object.assign(new Error("Database unavailable."), { code: -32000 });
  await requireToolPermission(authorization, "ops_pulse");

  const requested = parseStationCodes(args.stationCodes ?? args.station_codes);

  if (name === "ops_list_permitted_stations") {
    const { locations, companyId } = await resolveScopedLocations(authorization, []);
    return {
      asOf: indiaDate(),
      companyId,
      missing: [],
      rows: locations.map((row) => ({
        stationCode: row.station_code,
        name: row.station_name,
        city: row.city,
        region: row.region,
        cluster: row.cluster
      }))
    };
  }

  if (name === "ops_capacity_snapshot") {
    await requireToolPermission(authorization, "capacity");
    const asOf = parseIsoDate(args.asOf ?? args.as_of) ?? indiaDate(-1);
    const { locations, missing, companyId } = await resolveScopedLocations(authorization, requested);
    const capacityLocations = locations.filter(isAmazonEdspXptLocation);
    const snapshot = await loadCapacitySnapshot({
      companyId,
      locations: capacityLocations,
      reportingDate: asOf
    });
    return {
      asOf: snapshot.scopeDataDate ?? asOf,
      from: snapshot.from,
      to: asOf,
      missing,
      coverage: snapshot.scopeCoverage,
      rows: snapshot.stations.map((row) => ({
        stationCode: row.stationCode,
        spr: row.spr,
        targetSpr: row.targetSpr,
        modelledGap: row.modelledGap,
        latestSystemIds: row.latestSystemIds,
        latestInternalDAs: row.latestInternalDAs,
        latestExternalDAs: row.latestExternalDAs,
        decision: row.decision,
        action: row.action,
        dataState: row.dataState,
        latestDate: row.latestDate
      }))
    };
  }

  if (name === "ops_station_delivery_summary") {
    const from = parseIsoDate(args.from);
    const to = parseIsoDate(args.to);
    if (!from || !to || from > to) {
      throw Object.assign(new Error("Invalid from/to ISO dates."), { code: -32602 });
    }
    const { locations, missing, companyId } = await resolveScopedLocations(authorization, requested);
    const codes = locations.map((row) => row.station_code);
    if (!codes.length) return { asOf: to, missing, rows: [] };
    const [shipment, attendance] = await Promise.all([
      supabaseAdmin
        .from("cps_shipment_daily")
        .select("work_date,station_code,provider_employee_id,assigned_count,total_delivery")
        .eq("company_id", companyId)
        .in("station_code", codes)
        .gte("work_date", from)
        .lte("work_date", to)
        .limit(30000),
      supabaseAdmin
        .from("attendance_daily")
        .select("punch_date,station_code,enrolment_id,status")
        .eq("company_id", companyId)
        .in("station_code", codes)
        .gte("punch_date", from)
        .lte("punch_date", to)
        .limit(30000)
    ]);
    if (shipment.error || attendance.error) {
      throw Object.assign(new Error(shipment.error?.message || attendance.error?.message || "Query failed"), {
        code: -32000
      });
    }
    const rows = locations.map((location) => {
      const shipments = (shipment.data ?? []).filter((row) => row.station_code === location.station_code);
      const latestDate = shipments.map((row) => row.work_date).sort().at(-1) ?? null;
      const latest = latestDate ? shipments.filter((row) => row.work_date === latestDate) : [];
      const delivered = latest.reduce((sum, row) => sum + n(row.total_delivery), 0);
      const assigned = latest.reduce((sum, row) => sum + n(row.assigned_count), 0);
      const activeDas = new Set(latest.map((row) => row.provider_employee_id).filter(Boolean)).size;
      const present = (attendance.data ?? []).filter(
        (row) =>
          row.station_code === location.station_code &&
          row.punch_date === latestDate &&
          /^(P|PRESENT)$/i.test(row.status ?? "")
      );
      return {
        stationCode: location.station_code,
        latestDeliveryDate: latestDate,
        assignedPackages: assigned,
        deliveredPackages: delivered,
        activeDeliveryDas: activeDas,
        spr: activeDas ? Number((delivered / activeDas).toFixed(2)) : 0,
        presentDas: new Set(present.map((row) => row.enrolment_id).filter(Boolean)).size
      };
    });
    return { asOf: to, from, to, missing, rows };
  }

  if (name === "ops_cod_summary") {
    await requireToolPermission(authorization, "cod");
    const from = parseIsoDate(args.from);
    const to = parseIsoDate(args.to);
    if (!from || !to || from > to) {
      throw Object.assign(new Error("Invalid from/to ISO dates."), { code: -32602 });
    }
    const { locations, missing, companyId } = await resolveScopedLocations(authorization, requested);
    const codes = locations.map((row) => row.station_code);
    if (!codes.length) return { asOf: to, missing, rows: [] };
    const { data, error } = await supabaseAdmin
      .from("cod_submissions")
      .select("station_code,validation_status,deposited_amount,validated_amount")
      .eq("company_id", companyId)
      .in("station_code", codes)
      .gte("created_at", `${from}T00:00:00+05:30`)
      .lte("created_at", `${to}T23:59:59+05:30`)
      .limit(10000);
    if (error) throw Object.assign(new Error(error.message), { code: -32000 });
    const rows = locations.map((location) => {
      const codRows = (data ?? []).filter((row) => row.station_code === location.station_code);
      return {
        stationCode: location.station_code,
        submissions: codRows.length,
        pending: codRows.filter((row) => row.validation_status === "Pending").length,
        deposited: codRows.reduce((sum, row) => sum + n(row.deposited_amount), 0),
        validated: codRows.reduce((sum, row) => sum + n(row.validated_amount), 0)
      };
    });
    return { asOf: to, from, to, missing, rows };
  }

  if (name === "ops_loss_case_summary") {
    await requireToolPermission(authorization, "ops_losses");
    const { locations, missing, companyId } = await resolveScopedLocations(authorization, requested);
    const codes = locations.map((row) => row.station_code);
    if (!codes.length) return { asOf: indiaDate(), missing, rows: [] };
    let query = supabaseAdmin
      .from("loss_cases")
      .select("station_code,amount,period,report")
      .in("station_code", codes)
      .limit(20000);
    const period = String(args.period ?? "").trim();
    if (period) query = query.eq("period", period);
    const { data, error } = await query;
    if (error) throw Object.assign(new Error(error.message), { code: -32000 });
    void companyId;
    const rows = locations.map((location) => {
      const caseRows = (data ?? []).filter((row) => row.station_code === location.station_code);
      return {
        stationCode: location.station_code,
        caseCount: caseRows.length,
        totalAmount: caseRows.reduce((sum, row) => sum + n(row.amount), 0),
        byReport: Object.fromEntries(
          Array.from(new Set(caseRows.map((row) => row.report))).map((report) => [
            report,
            {
              count: caseRows.filter((row) => row.report === report).length,
              amount: caseRows.filter((row) => row.report === report).reduce((sum, row) => sum + n(row.amount), 0)
            }
          ])
        )
      };
    });
    return { asOf: indiaDate(), period: period || null, missing, rows };
  }

  throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32601 });
}
