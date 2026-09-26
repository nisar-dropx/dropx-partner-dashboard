import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { isAmazonEdspXptLocation } from "@/lib/ops-pulse/operating-context";
import { supabaseAdmin } from "@/lib/supabase-admin";
import * as XLSX from "xlsx";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Shipment = {
  station_code: string; work_date: string; provider_employee_id: string; provider_employee_name: string | null;
  amazon_delivery: number | string | null; c_return: number | string | null; del_rate: number | string | null; c_return_rate: number | string | null;
  da_total_pay: number | string | null; pay_type: string | null; mapping_status: string | null;
};
type Mapping = { provider_member_id: string | null; station_id: string | null; effective_from: string; effective_to: string | null; payment_method_id: string | null; payment_values: unknown; pay_type: string | null; delivery_rate: unknown; pickup_rate: unknown };

const number = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
const normalized = (value: unknown) => String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
const rate = (value: unknown) => { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? parsed : null; };
const identity = (station: string, id: string) => `${station.trim().toUpperCase()}|${id.trim().toUpperCase()}`;

function paymentValues(mapping: Mapping | undefined) {
  return mapping?.payment_values && typeof mapping.payment_values === "object" && !Array.isArray(mapping.payment_values)
    ? mapping.payment_values as Record<string, unknown>
    : {};
}

function componentRate(mapping: Mapping | undefined, components: any[], kind: "delivery" | "return") {
  if (!mapping) return null;
  const values = paymentValues(mapping);
  for (const component of components) {
    const field = Array.isArray(component.payment_fields) ? component.payment_fields[0] : component.payment_fields;
    const code = String(field?.code ?? component.component_code ?? "").trim();
    const source = normalized(field?.provider_calculation_sources?.amazon ?? field?.calculation_source ?? code);
    const production = component.component_type === "production" || normalized(field?.calculation_type) === "COUNT_X_RATE";
    const isDelivery = ["DELIVERY", "AMAZON_DELIVERY", "TOTAL_DELIVERY"].includes(source);
    const isReturn = ["C_RETURN", "CUSTOMER_RETURN", "RETURN"].includes(source);
    if (!production || (kind === "delivery" ? !isDelivery : !isReturn)) continue;
    const value = rate(values[code] ?? values[String(component.component_code ?? "")]);
    if (value != null) return value;
  }
  for (const [code, value] of Object.entries(values)) {
    const key = normalized(code);
    const match = kind === "delivery"
      ? /DELIVERY|DEL_RATE|PER_PACKET/.test(key) && !/RETURN|MFN|FUEL|MG|GUARANTEE/.test(key)
      : /C_RETURN|CUSTOMER_RETURN|RETURN_RATE/.test(key) && !/MFN/.test(key);
    if (!match) continue;
    const parsed = rate(value);
    if (parsed != null) return parsed;
  }
  return null;
}

function card(delivery: number | null, returned: number | null) {
  const entries = [delivery == null ? null : `Delivery ₹${delivery.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`, returned == null ? null : `C-return ₹${returned.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`].filter(Boolean);
  return entries.length ? entries.join(" | ") : "Not mapped";
}

function workbookResponse(sheets: Array<{ name: string; rows: Record<string, unknown>[] }>, filename: string) {
  const workbook = XLSX.utils.book_new();
  for (const { name, rows } of sheets) {
    const sheet = XLSX.utils.json_to_sheet(rows);
    sheet["!freeze"] = { ySplit: 1 };
    sheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(rows.length, 1), c: Math.max(Object.keys(rows[0] ?? {}).length - 1, 0) } }) };
    sheet["!cols"] = Object.keys(rows[0] ?? {}).map((label) => ({ wch: Math.min(34, Math.max(12, label.length + 3)) }));
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  }
  return new Response(XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }), { headers: {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "no-store"
  } });
}

export async function GET(request: Request) {
  const authorization = await getAuthorization();
  if (!authorization || !hasPermission(authorization, "capacity_associates", "access")) return Response.json({ error: "Associate productivity access denied." }, { status: 403 });
  if (!supabaseAdmin) return Response.json({ error: "Database unavailable." }, { status: 500 });
  const url = new URL(request.url);
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  if (!validDate(from) || !validDate(to) || from > to) return Response.json({ error: "Select a valid date range." }, { status: 400 });

  const companyId = requireCompanyId(authorization);
  const locationsResult = await loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
  const permittedLocations = locationsResult.locations.filter(isAmazonEdspXptLocation);
  const requested = (url.searchParams.get("stations") ?? "").split(",").map((code) => code.trim().toUpperCase()).filter(Boolean);
  const locations = requested.length ? permittedLocations.filter((location) => requested.includes(location.station_code)) : permittedLocations;
  const stationCodes = locations.map((location) => location.station_code);
  if (!stationCodes.length) return Response.json({ error: "No permitted stations match this export." }, { status: 403 });

  const shipmentsResult = await supabaseAdmin.from("cps_shipment_daily")
    .select("station_code,work_date,provider_employee_id,provider_employee_name,amazon_delivery,c_return,del_rate,c_return_rate,da_total_pay,pay_type,mapping_status")
    .eq("company_id", companyId).in("station_code", stationCodes).gte("work_date", from).lte("work_date", to)
    .not("provider_employee_id", "is", null).order("work_date").limit(50000);
  if (shipmentsResult.error) return Response.json({ error: shipmentsResult.error.message }, { status: 500 });
  const shipments = (shipmentsResult.data ?? []) as Shipment[];
  const ids = [...new Set(shipments.map((row) => String(row.provider_employee_id ?? "").trim()).filter(Boolean))];
  const mappingsResult = ids.length ? await supabaseAdmin.from("field_executive_provider_mappings")
    .select("provider_member_id,station_id,effective_from,effective_to,payment_method_id,payment_values,pay_type,delivery_rate,pickup_rate")
    .eq("company_id", companyId).neq("status", "cancelled").in("provider_member_id", ids) : { data: [] as Mapping[], error: null };
  if (mappingsResult.error) return Response.json({ error: mappingsResult.error.message }, { status: 500 });
  const mappings = (mappingsResult.data ?? []) as Mapping[];
  const methodIds = [...new Set(mappings.map((mapping) => mapping.payment_method_id).filter(Boolean))] as string[];
  const componentsResult = methodIds.length ? await supabaseAdmin.from("payment_method_components")
    .select("payment_method_id,component_code,component_type,payment_fields(code,calculation_type,calculation_source,provider_calculation_sources)")
    .in("payment_method_id", methodIds).eq("is_active", true) : { data: [] as any[], error: null };
  if (componentsResult.error) return Response.json({ error: componentsResult.error.message }, { status: 500 });
  const stationIdByCode = new Map(locations.map((location) => [location.station_code, location.id]));
  const componentsByMethod = new Map<string, any[]>();
  for (const component of componentsResult.data ?? []) componentsByMethod.set(component.payment_method_id, [...(componentsByMethod.get(component.payment_method_id) ?? []), component]);

  const daily = new Map<string, { date: string; station: string; name: string; id: string; delivery: number; returned: number; earnings: number; payType: string; deliveryRate: number | null; returnRate: number | null; mappingStatus: string }>();
  for (const row of shipments) {
    const id = String(row.provider_employee_id ?? "").trim();
    if (!id) continue;
    const station = String(row.station_code ?? "").trim();
    const mapping = mappings.find((candidate) => normalized(candidate.provider_member_id) === normalized(id) && (!candidate.station_id || candidate.station_id === stationIdByCode.get(station)) && candidate.effective_from <= row.work_date && (!candidate.effective_to || candidate.effective_to >= row.work_date));
    const importedDeliveryRate = rate(row.del_rate);
    const importedReturnRate = rate(row.c_return_rate);
    const deliveryRate = importedDeliveryRate ?? rate(mapping?.delivery_rate) ?? componentRate(mapping, mapping?.payment_method_id ? componentsByMethod.get(mapping.payment_method_id) ?? [] : [], "delivery");
    const returnRate = importedReturnRate ?? rate(mapping?.pickup_rate) ?? componentRate(mapping, mapping?.payment_method_id ? componentsByMethod.get(mapping.payment_method_id) ?? [] : [], "return");
    const item = { date: row.work_date, station, name: String(row.provider_employee_name || id), id, delivery: number(row.amazon_delivery), returned: number(row.c_return), earnings: number(row.da_total_pay), payType: row.pay_type || mapping?.pay_type || "Not configured", deliveryRate, returnRate, mappingStatus: row.mapping_status || (mapping ? "Mapped" : "Unmapped") };
    const itemKey = `${station}|${item.date}|${identity(station, id)}`;
    const current = daily.get(itemKey);
    if (!current || item.delivery + item.returned > current.delivery + current.returned) daily.set(itemKey, item);
  }

  const associates = new Map<string, { name: string; id: string; station: string; days: number; delivery: number; returned: number; earnings: number; payTypes: Set<string>; cards: Set<string>; deliveryRates: Set<number>; returnRates: Set<number>; mapped: boolean }>();
  for (const row of daily.values()) {
    const associateKey = identity(row.station, row.id);
    const current = associates.get(associateKey) ?? { name: row.name, id: row.id, station: row.station, days: 0, delivery: 0, returned: 0, earnings: 0, payTypes: new Set(), cards: new Set(), deliveryRates: new Set(), returnRates: new Set(), mapped: false };
    if (row.delivery + row.returned > 0) current.days++;
    current.delivery += row.delivery; current.returned += row.returned; current.earnings += row.earnings;
    current.payTypes.add(row.payType); current.cards.add(card(row.deliveryRate, row.returnRate)); current.mapped ||= row.mappingStatus.toLowerCase() === "mapped" || row.deliveryRate != null || row.returnRate != null;
    if (row.deliveryRate != null) current.deliveryRates.add(row.deliveryRate);
    if (row.returnRate != null) current.returnRates.add(row.returnRate);
    associates.set(associateKey, current);
  }
  const summary = [...associates.values()].sort((left, right) => left.station.localeCompare(right.station) || left.name.localeCompare(right.name)).map((row) => {
    const total = row.delivery + row.returned;
    const rateCell = (rates: Set<number>) => { const values = [...rates].sort((left, right) => left - right); return values.length === 1 ? values[0] : values.length ? values.map((value) => `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`).join(" | ") : null; };
    return { "Associate name": row.name, "Provider ID": row.id, Station: row.station, "Active days": row.days, Delivery: row.delivery, "C-return": row.returned, "Total count": total, "Pay type": [...row.payTypes].sort().join(" | "), "Rate card": [...row.cards].sort().join(" | "), "Delivery rate / package": rateCell(row.deliveryRates), "C-return rate / package": rateCell(row.returnRates), "Total earning": Number(row.earnings.toFixed(2)), CPS: total ? Number((row.earnings / total).toFixed(2)) : null, "Rate card mapped": row.mapped ? "Yes" : "No" };
  });
  const ledger = [...daily.values()].sort((left, right) => `${left.date}|${left.station}|${left.name}`.localeCompare(`${right.date}|${right.station}|${right.name}`)).map((row) => {
    const total = row.delivery + row.returned;
    return { Date: row.date, "Associate name": row.name, "Provider ID": row.id, Station: row.station, "Pay type": row.payType, "Delivery rate / package": row.deliveryRate, "C-return rate / package": row.returnRate, "Rate card": card(row.deliveryRate, row.returnRate), Delivery: row.delivery, "C-return": row.returned, "Total count": total, Earning: Number(row.earnings.toFixed(2)), CPS: total ? Number((row.earnings / total).toFixed(2)) : null, "Rate card mapped": row.mappingStatus };
  });
  return workbookResponse([{ name: "Associate summary", rows: summary }, { name: "Daily earnings", rows: ledger }], `associate-spr-${from}-to-${to}.xlsx`);
}
