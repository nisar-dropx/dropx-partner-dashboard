import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadCapacityRules } from "@/lib/ops-pulse/capacity";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { isAmazonEdspXptLocation } from "@/lib/ops-pulse/operating-context";
import { supabaseAdmin } from "@/lib/supabase-admin";
import * as XLSX from "xlsx";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const num = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const valid = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
const key = (station: string, id: string, name: string | null) => `${station}|${String(name || id).replace(/[^a-z0-9]/gi, "").toUpperCase()}`;
function response(sheets: Array<{ name: string; rows: Record<string, unknown>[] }>, filename: string) {
  const workbook = XLSX.utils.book_new();
  sheets.forEach(({ name, rows }) => { const sheet = XLSX.utils.json_to_sheet(rows); sheet["!freeze"] = { ySplit: 1 }; XLSX.utils.book_append_sheet(workbook, sheet, name); });
  return new Response(XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  const authorization = await getAuthorization();
  if (!authorization || !hasPermission(authorization, "capacity_associates", "access")) return Response.json({ error: "Associate productivity access denied." }, { status: 403 });
  if (!supabaseAdmin) return Response.json({ error: "Database unavailable." }, { status: 500 });
  const url = new URL(request.url); const from = url.searchParams.get("from") || ""; const to = url.searchParams.get("to") || "";
  if (!valid(from) || !valid(to) || from > to) return Response.json({ error: "Select a valid date range." }, { status: 400 });
  const companyId = requireCompanyId(authorization);
  const locationResult = await loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
  const cluster = url.searchParams.get("cluster") || "";
  const permitted = locationResult.locations.filter(isAmazonEdspXptLocation).filter((location) => !cluster || location.cluster === cluster);
  const requested = (url.searchParams.get("stations") || "").split(",").map((value) => value.trim().toUpperCase()).filter(Boolean);
  const stations = requested.length ? permitted.filter((location) => requested.includes(location.station_code)).map((location) => location.station_code) : permitted.map((location) => location.station_code);
  if (!stations.length) return Response.json({ error: "No permitted stations match these filters." }, { status: 403 });
  const [rules, shipments] = await Promise.all([
    loadCapacityRules(companyId),
    supabaseAdmin.from("cps_shipment_daily").select("station_code,work_date,provider_employee_id,provider_employee_name,amazon_delivery,c_return,variable_pay,mg_pay,fuel_pay,da_total_pay,pay_type,mapping_status").eq("company_id", companyId).in("station_code", stations).gte("work_date", from).lte("work_date", to).not("provider_employee_id", "is", null).order("work_date").limit(50000)
  ]);
  if (shipments.error) return Response.json({ error: shipments.error.message }, { status: 500 });
  const targetByStation = new Map(rules.rows.map((rule) => [rule.stationCode, rule.targetSpr ?? 40]));
  const daily = new Map<string, { station: string; date: string; id: string; name: string; delivery: number; returns: number; variable: number; salary: number; fuel: number; paid: number; payType: string; mapping: string }>();
  for (const row of shipments.data ?? []) { const id = String(row.provider_employee_id || "").trim(); if (!id) continue; const item = { station: row.station_code, date: row.work_date, id, name: row.provider_employee_name || id, delivery: num(row.amazon_delivery), returns: num(row.c_return), variable: num(row.variable_pay), salary: num(row.mg_pay), fuel: num(row.fuel_pay), paid: num(row.da_total_pay), payType: row.pay_type || "Not configured", mapping: row.mapping_status || "Unmapped" }; const itemKey = `${item.station}|${item.date}|${key(item.station, item.id, item.name)}`; const existing = daily.get(itemKey); if (!existing || item.delivery + item.returns > existing.delivery + existing.returns) daily.set(itemKey, item); }
  const people = new Map<string, { station: string; id: string; name: string; days: number; delivery: number; returns: number; variable: number; salary: number; fuel: number; paid: number }>();
  daily.forEach((row) => { const personKey = key(row.station, row.id, row.name); const person = people.get(personKey) ?? { station: row.station, id: row.id, name: row.name, days: 0, delivery: 0, returns: 0, variable: 0, salary: 0, fuel: 0, paid: 0 }; person.days++; person.delivery += row.delivery; person.returns += row.returns; person.variable += row.variable; person.salary += row.salary; person.fuel += row.fuel; person.paid += row.paid; people.set(personKey, person); });
  const summary = [...people.values()].map((person) => { const total = person.delivery + person.returns; const productivity = person.days ? total / person.days : 0; return { Associate: person.name, "Associate ID": person.id, Station: person.station, "Days worked": person.days, Delivery: person.delivery, "C-return": person.returns, "Total count": total, Productivity: Number(productivity.toFixed(2)), "Configured target": targetByStation.get(person.station) ?? 40, "Variable pay": person.variable, "Salary / MG": person.salary, "Fuel pay": person.fuel, "Total paid": person.paid, "Cost per shipment": total ? Number((person.paid / total).toFixed(2)) : null, Status: productivity < (targetByStation.get(person.station) ?? 40) ? "Below target" : "At / above target" }; }).filter((row) => row.Status === "Below target").sort((a, b) => a.Productivity - b.Productivity || b["Total count"] - a["Total count"]);
  const visible = new Set(summary.map((row) => `${row.Station}|${row["Associate ID"]}`));
  const ledger = [...daily.values()].filter((row) => visible.has(`${row.station}|${row.id}`)).sort((a, b) => `${a.date}|${a.station}|${a.name}`.localeCompare(`${b.date}|${b.station}|${b.name}`)).map((row) => { const total = row.delivery + row.returns; return { Date: row.date, Associate: row.name, "Associate ID": row.id, Station: row.station, Delivery: row.delivery, "C-return": row.returns, "Total count": total, "Variable pay": row.variable, "Salary / MG": row.salary, "Fuel pay": row.fuel, "Total paid": row.paid, "Daily CPS": total ? Number((row.paid / total).toFixed(2)) : null, "Pay type": row.payType, "Payment mapping": row.mapping }; });
  return response([{ name: "Below target summary", rows: summary }, { name: "Daily CPS ledger", rows: ledger }], `low-productivity-associates-${from}-to-${to}.xlsx`);
}
