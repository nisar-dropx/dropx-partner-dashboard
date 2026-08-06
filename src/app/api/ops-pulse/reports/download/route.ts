import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { isOpsReportType } from "@/lib/ops-pulse/report-catalog";
import { supabaseAdmin } from "@/lib/supabase-admin";
import * as XLSX from "xlsx";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function csv(value: unknown) {
  const text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return `"${text.replace(/"/g, "\"\"")}"`;
}
function n(value: unknown) { const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? parsed : 0; }
function validDate(value: string) { return /^\d{4}-\d{2}-\d{2}$/.test(value); }
function dateDiff(from: string, to: string) { return Math.floor((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400000); }
function stationScope(requested: string[], permitted: string[]) {
  const normalized = requested.map((code) => code.trim().toUpperCase()).filter((code) => permitted.includes(code));
  return requested.length ? [...new Set(normalized)] : permitted;
}
function response(headers: string[], rows: unknown[][], filename: string) {
  const body = [headers.map(csv).join(","), ...rows.map((row) => row.map(csv).join(","))].join("\r\n");
  return new Response(`\uFEFF${body}`, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "no-store" } });
}
function workbookResponse(sheets: Array<{ name: string; rows: Record<string, unknown>[] }>, filename: string) {
  const workbook = XLSX.utils.book_new();
  sheets.forEach((sheet) => XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(sheet.rows), sheet.name.slice(0, 31)));
  const body = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });
  return new Response(body, { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "no-store" } });
}
function promiseDate(raw: Record<string, unknown> | null) {
  const value = raw?.["Promised Delivery Date"];
  if (!value) return "";
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
}
async function allRows<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, cap = 100000) {
  const data: T[] = [];
  const size = 1000;
  for (let offset = 0; offset < cap; offset += size) {
    const result = await page(offset, offset + size - 1);
    if (result.error) return { data, error: result.error };
    const rows = result.data ?? [];
    data.push(...rows);
    if (rows.length < size) return { data, error: null };
  }
  return { data: [], error: { message: `This export exceeds ${cap.toLocaleString("en-IN")} rows. Select fewer stations or a shorter date range.` } };
}

export async function GET(request: Request) {
  const authorization = await getAuthorization();
  if (!authorization || !hasPermission(authorization, "cod_reports", "access")) return Response.json({ error: "Report access denied." }, { status: 403 });
  if (!supabaseAdmin) return Response.json({ error: "Database unavailable." }, { status: 500 });
  const db = supabaseAdmin;
  const url = new URL(request.url);
  const type = url.searchParams.get("type") ?? "";
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  if (!isOpsReportType(type) || !validDate(from) || !validDate(to) || dateDiff(from, to) < 0 || dateDiff(from, to) > 366) {
    return Response.json({ error: "Select a valid report and a date range up to 366 days." }, { status: 400 });
  }
  const companyId = requireCompanyId(authorization);
  const locations = await loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
  const permittedCodes = locations.locations.map((row) => row.station_code);
  const codes = stationScope((url.searchParams.get("stations") ?? "").split(",").filter(Boolean), permittedCodes);
  if (!codes.length) return Response.json({ error: "No permitted stations." }, { status: 403 });
  const suffix = `${from}-to-${to}.csv`;

  if (type === "shipment_station" || type === "shipment_pincode" || type === "shipment_promise" || type === "station_360") {
    const facts = await allRows((start, end) => db.from("delivered_shipment_facts")
      .select("work_date,station_code,postal_code,driver_id,package_count,actual_weight_kg,length_cm,width_cm,height_cm,cubic_volume_cm3,raw_payload")
      .eq("company_id", companyId).in("station_code", codes).gte("work_date", from).lte("work_date", to).order("work_date").range(start, end));
    if (facts.error) return Response.json({ error: facts.error.message }, { status: 500 });
    const sizeMaster = await db.from("report_import_master").select("description").eq("company_id", companyId).eq("source_code", "capacity_shipment_size_rule").maybeSingle();
    let sizeRule = { maxLengthCm: 46, maxWidthCm: 36, maxHeightCm: 20, maxWeightKg: 5, dimensionalDivisor: 5000, maxDimensionalWeightKg: 5 };
    try { sizeRule = { ...sizeRule, ...(JSON.parse(sizeMaster.data?.description ?? "{}") as typeof sizeRule) }; } catch {}
    const size = (row: typeof facts.data[number]) => {
      const complete = row.actual_weight_kg != null && row.length_cm != null && row.width_cm != null && row.height_cm != null;
      if (!complete) return "Unclassified";
      const dimensional = n(row.cubic_volume_cm3) / sizeRule.dimensionalDivisor;
      return n(row.actual_weight_kg) > sizeRule.maxWeightKg || n(row.length_cm) > sizeRule.maxLengthCm || n(row.width_cm) > sizeRule.maxWidthCm || n(row.height_cm) > sizeRule.maxHeightCm || dimensional > sizeRule.maxDimensionalWeightKg ? "Volumetric" : "Small";
    };
    const stationMap = new Map<string, { date: string; station: string; delivered: number; drivers: Set<string>; pincodes: Set<string>; small: number; volumetric: number; unclassified: number }>();
    const pincodeMap = new Map<string, { station: string; pincode: string; delivered: number; drivers: Set<string>; small: number; volumetric: number; unclassified: number }>();
    const promiseMap = new Map<string, { station: string; pincode: string; promise: string; status: string; shipMethod: string; shipOption: string; volume: number }>();
    (facts.data ?? []).forEach((row) => {
      const count = Math.max(1, n(row.package_count));
      const classification = size(row);
      const stationKey = `${row.work_date}|${row.station_code}`;
      const station = stationMap.get(stationKey) ?? { date: row.work_date, station: row.station_code, delivered: 0, drivers: new Set<string>(), pincodes: new Set<string>(), small: 0, volumetric: 0, unclassified: 0 };
      station.delivered += count; if (row.driver_id) station.drivers.add(row.driver_id); if (row.postal_code) station.pincodes.add(row.postal_code);
      if (classification === "Small") station.small += count; else if (classification === "Volumetric") station.volumetric += count; else station.unclassified += count;
      stationMap.set(stationKey, station);
      const pincodeKey = `${row.station_code}|${row.postal_code}`;
      const pin = pincodeMap.get(pincodeKey) ?? { station: row.station_code, pincode: row.postal_code, delivered: 0, drivers: new Set<string>(), small: 0, volumetric: 0, unclassified: 0 };
      pin.delivered += count; if (row.driver_id) pin.drivers.add(row.driver_id);
      if (classification === "Small") pin.small += count; else if (classification === "Volumetric") pin.volumetric += count; else pin.unclassified += count;
      pincodeMap.set(pincodeKey, pin);
      const raw = row.raw_payload as Record<string, unknown> | null;
      const promised = promiseDate(raw);
      const promiseStatus = !promised ? "Promise unavailable" : row.work_date < promised ? "Early" : row.work_date === promised ? "On promise" : "Late";
      const shipMethod = String(raw?.["Ship Method"] ?? "");
      const shipOption = String(raw?.["Ship Option"] ?? "");
      const promiseKey = `${row.station_code}|${row.postal_code}|${promised}|${promiseStatus}|${shipMethod}|${shipOption}`;
      const promise = promiseMap.get(promiseKey) ?? { station: row.station_code, pincode: row.postal_code, promise: promised, status: promiseStatus, shipMethod, shipOption, volume: 0 };
      promise.volume += count; promiseMap.set(promiseKey, promise);
    });
    const stationRows = [...stationMap.values()].sort((a, b) => `${a.date}${a.station}`.localeCompare(`${b.date}${b.station}`)).map((row) => ({
      Date: row.date, Station: row.station, Delivered: row.delivered, "Road-active IDs": row.drivers.size, SPR: row.drivers.size ? Number((row.delivered / row.drivers.size).toFixed(2)) : 0, Pincodes: row.pincodes.size,
      Small: row.small, "Small %": row.delivered ? Number((row.small / row.delivered * 100).toFixed(2)) : 0,
      Volumetric: row.volumetric, "Volumetric %": row.delivered ? Number((row.volumetric / row.delivered * 100).toFixed(2)) : 0, Unclassified: row.unclassified
    }));
    const pincodeRows = [...pincodeMap.values()].sort((a, b) => a.station.localeCompare(b.station) || b.delivered - a.delivered || a.pincode.localeCompare(b.pincode)).map((row) => ({
      Station: row.station, Pincode: row.pincode, Delivered: row.delivered, "Serving IDs": row.drivers.size,
      Small: row.small, "Small %": row.delivered ? Number((row.small / row.delivered * 100).toFixed(2)) : 0,
      Volumetric: row.volumetric, "Volumetric %": row.delivered ? Number((row.volumetric / row.delivered * 100).toFixed(2)) : 0,
      Unclassified: row.unclassified, "Unclassified %": row.delivered ? Number((row.unclassified / row.delivered * 100).toFixed(2)) : 0
    }));
    const promiseRows = [...promiseMap.values()].sort((a, b) => `${a.station}${a.pincode}${a.promise}`.localeCompare(`${b.station}${b.pincode}${b.promise}`)).map((row) => ({
      Station: row.station, Pincode: row.pincode, "Promise date": row.promise, "Promise position": row.status, "Ship method": row.shipMethod, "Ship option": row.shipOption, Volume: row.volume
    }));
    if (type === "shipment_station") return response(Object.keys(stationRows[0] ?? { Date: "", Station: "" }), stationRows.map(Object.values), `shipment-station-${suffix}`);
    if (type === "shipment_pincode") return response(Object.keys(pincodeRows[0] ?? { Station: "", Pincode: "" }), pincodeRows.map(Object.values), `shipment-pincode-${suffix}`);
    if (type === "shipment_promise") return response(Object.keys(promiseRows[0] ?? { Station: "", Pincode: "" }), promiseRows.map(Object.values), `customer-promise-${suffix}`);
    const inbound = await allRows((start, end) => db.from("inbound_shipment_facts").select("expected_arrival_date,station_code,postal_code,package_count")
      .eq("company_id", companyId).in("station_code", codes).gte("expected_arrival_date", from).lte("expected_arrival_date", to).order("expected_arrival_date").range(start, end));
    const assigned = await allRows((start, end) => db.from("cps_shipment_daily").select("work_date,station_code,assigned_count,total_delivery,provider_employee_id")
      .eq("company_id", companyId).in("station_code", codes).gte("work_date", from).lte("work_date", to).order("work_date").range(start, end));
    if (inbound.error || assigned.error) return Response.json({ error: inbound.error?.message || assigned.error?.message }, { status: 500 });
    const inboundRows = (inbound.data ?? []).map((row) => ({ Date: row.expected_arrival_date, Station: row.station_code, Pincode: row.postal_code, Volume: Math.max(1, n(row.package_count)) }));
    const groundRows = (assigned.data ?? []).map((row) => ({ Date: row.work_date, Station: row.station_code, "Associate ID": row.provider_employee_id, Assigned: n(row.assigned_count), Delivered: n(row.total_delivery) }));
    return workbookResponse([{ name: "Daily summary", rows: stationRows }, { name: "Pincode mix", rows: pincodeRows }, { name: "Customer promise", rows: promiseRows }, { name: "Inbound", rows: inboundRows }, { name: "Assigned ground input", rows: groundRows }], `station-360-${from}-to-${to}.xlsx`);
  }

  if (type === "inbound_daily") {
    const result = await allRows((start, end) => db.from("inbound_shipment_facts").select("expected_arrival_date,station_code,postal_code,package_count")
      .eq("company_id", companyId).in("station_code", codes).gte("expected_arrival_date", from).lte("expected_arrival_date", to).order("expected_arrival_date").range(start, end));
    if (result.error) return Response.json({ error: result.error.message }, { status: 500 });
    const map = new Map<string, number>();
    (result.data ?? []).forEach((row) => { const key = `${row.expected_arrival_date}|${row.station_code}|${row.postal_code}`; map.set(key, (map.get(key) ?? 0) + Math.max(1, n(row.package_count))); });
    return response(["Expected arrival date", "Station", "Pincode", "Inbound volume"], [...map.entries()].sort().map(([key, volume]) => [...key.split("|"), volume]), `inbound-volume-${suffix}`);
  }

  if (type === "da_delivery" || type === "station_delivery" || type === "capacity") {
    const shipment = await allRows((start, end) => db.from("cps_shipment_daily").select("work_date,station_code,provider_employee_id,provider_employee_name,assigned_count,amazon_delivery,swa_delivery,c_return,mfn,mfn_return,total_delivery,total_activity,mapping_status,da_total_pay")
      .eq("company_id", companyId).in("station_code", codes).gte("work_date", from).lte("work_date", to).order("work_date").range(start, end));
    if (shipment.error) return Response.json({ error: shipment.error.message }, { status: 500 });
    if (type === "da_delivery") return response(
      ["Date", "Station", "Provider Employee ID", "DA Name", "Assigned", "Amazon Delivery", "SWA Delivery", "C-Return", "MFN", "MFN Return", "Total Delivery", "Total Activity", "Mapping Status", "DA Pay"],
      (shipment.data ?? []).map((row) => [row.work_date, row.station_code, row.provider_employee_id, row.provider_employee_name, row.assigned_count, row.amazon_delivery, row.swa_delivery, row.c_return, row.mfn, row.mfn_return, row.total_delivery, row.total_activity, row.mapping_status, row.da_total_pay]),
      `da-delivery-${suffix}`
    );
    const map = new Map<string, { date: string; station: string; assigned: number; amazon: number; swa: number; cReturn: number; mfn: number; mfnReturn: number; delivery: number; activity: number; das: Set<string> }>();
    (shipment.data ?? []).forEach((row) => { const key = `${row.work_date}|${row.station_code}`; const item = map.get(key) ?? { date: row.work_date, station: row.station_code, assigned: 0, amazon: 0, swa: 0, cReturn: 0, mfn: 0, mfnReturn: 0, delivery: 0, activity: 0, das: new Set<string>() }; item.assigned += n(row.assigned_count); item.amazon += n(row.amazon_delivery); item.swa += n(row.swa_delivery); item.cReturn += n(row.c_return); item.mfn += n(row.mfn); item.mfnReturn += n(row.mfn_return); item.delivery += n(row.total_delivery); item.activity += n(row.total_activity); if (row.provider_employee_id) item.das.add(row.provider_employee_id); map.set(key, item); });
    const attendance = type === "capacity" ? await allRows((start, end) => db.from("attendance_daily").select("punch_date,station_code,status,enrolment_id").eq("company_id", companyId).in("station_code", codes).gte("punch_date", from).lte("punch_date", to).range(start, end)) : { data: [], error: null };
    if (attendance.error) return Response.json({ error: attendance.error.message }, { status: 500 });
    const present = new Map<string, Set<string>>();
    (attendance.data ?? []).forEach((row) => { if (!/^(P|PRESENT)$/i.test(row.status ?? "")) return; const key = `${row.punch_date}|${row.station_code}`; const set = present.get(key) ?? new Set<string>(); if (row.enrolment_id) set.add(row.enrolment_id); present.set(key, set); });
    const rows = [...map.values()].sort((a, b) => `${a.date}${a.station}`.localeCompare(`${b.date}${b.station}`));
    if (type === "capacity") return response(["Date", "Station", "Present Capacity", "Active Delivery DAs", "Assigned Packages", "Delivered Packages", "SPR (Delivered / Active DA)", "Assignment per Active DA", "Delivery Rate"], rows.map((row) => [row.date, row.station, present.get(`${row.date}|${row.station}`)?.size ?? 0, row.das.size, row.assigned, row.delivery, row.das.size ? (row.delivery / row.das.size).toFixed(2) : 0, row.das.size ? (row.assigned / row.das.size).toFixed(2) : 0, row.assigned ? `${(row.delivery / row.assigned * 100).toFixed(2)}%` : ""]), `capacity-productivity-${suffix}`);
    return response(["Date", "Station", "Assigned", "Amazon Delivery", "SWA Delivery", "C-Return", "MFN", "MFN Return", "Total Delivery", "Total Activity", "Active DAs", "SPR"], rows.map((row) => [row.date, row.station, row.assigned, row.amazon, row.swa, row.cReturn, row.mfn, row.mfnReturn, row.delivery, row.activity, row.das.size, row.das.size ? (row.delivery / row.das.size).toFixed(2) : 0]), `station-delivery-${suffix}`);
  }

  if (type === "attendance") {
    const result = await allRows((start, end) => db.from("attendance_daily").select("punch_date,station_code,worker_name,employee_code,enrolment_id,status,punch_count,in_time,out_time,work_minutes,remark").eq("company_id", companyId).in("station_code", codes).gte("punch_date", from).lte("punch_date", to).order("punch_date").range(start, end));
    if (result.error) return Response.json({ error: result.error.message }, { status: 500 });
    return response(["Date", "Station", "Worker", "Employee Code", "Enrolment ID", "Status", "Punches", "In", "Out", "Work Minutes", "Remark"], (result.data ?? []).map((row) => [row.punch_date, row.station_code, row.worker_name, row.employee_code, row.enrolment_id, row.status, row.punch_count, row.in_time, row.out_time, row.work_minutes, row.remark]), `attendance-${suffix}`);
  }
  if (type === "cps") {
    const result = await allRows<Record<string, unknown>>((start, end) => db.from("cps_station_daily").select("*").eq("company_id", companyId).in("station_code", codes).gte("work_date", from).lte("work_date", to).order("work_date").range(start, end));
    if (result.error) return Response.json({ error: result.error.message }, { status: 500 });
    const headers = ["Date", "Station", "Delivery", "Activity", "DA Cost", "Staff Cost", "Fuel Cost", "Vehicle Cost", "Rent Cost", "Other Cost", "Total Cost", "DA CPS", "Staff CPS", "Fuel CPS", "Other CPS", "Overall CPS", "Target CPS", "Target Gap", "Target Impact"];
    return response(headers, (result.data ?? []).map((r) => [r.work_date, r.station_code, r.total_delivery, r.total_activity, r.da_pay_cost, r.staff_cost, r.fuel_cost, r.vehicle_cost, r.rent_cost, r.other_cost, r.total_cost, r.da_cps, r.staff_cps, r.fuel_cps, r.other_cps, r.overall_cps, r.target_cps, r.target_gap, r.target_impact]), `station-cps-${suffix}`);
  }
  if (type === "cod") {
    const result = await allRows((start, end) => db.from("cod_submissions").select("created_at,station_code,client,cod_period_from,cod_period_to,deposit_date,remittance_code,cod_amount,deposited_amount,validated_amount,validation_status,validation_remarks,submitter_name").eq("company_id", companyId).in("station_code", codes).gte("created_at", `${from}T00:00:00+05:30`).lte("created_at", `${to}T23:59:59+05:30`).order("created_at").range(start, end));
    if (result.error) return Response.json({ error: result.error.message }, { status: 500 });
    return response(["Submitted At", "Station", "Client", "Period From", "Period To", "Deposit Date", "Remittance", "COD Amount", "Deposited", "Validated", "Validation Status", "Remarks", "Submitter"], (result.data ?? []).map((r) => [r.created_at, r.station_code, r.client, r.cod_period_from, r.cod_period_to, r.deposit_date, r.remittance_code, r.cod_amount, r.deposited_amount, r.validated_amount, r.validation_status, r.validation_remarks, r.submitter_name]), `cod-status-${suffix}`);
  }
  const result = await allRows((start, end) => db.from("ops_daily_submissions").select("business_date,station_code,submission_no,submitter_name,status,manager_status,manager_remarks,manager_reviewed_at,created_at").eq("company_id", companyId).in("station_code", codes).gte("business_date", from).lte("business_date", to).order("business_date").range(start, end));
  if (result.error) return Response.json({ error: result.error.message }, { status: 500 });
  return response(["Business Date", "Station", "Submission No", "Submitter", "Status", "Manager Status", "Manager Remarks", "Reviewed At", "Submitted At"], (result.data ?? []).map((r) => [r.business_date, r.station_code, r.submission_no, r.submitter_name, r.status, r.manager_status, r.manager_remarks, r.manager_reviewed_at, r.created_at]), `daily-closure-${suffix}`);
}
