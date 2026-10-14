import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
const module = { exports: {} };
new Function("exports", "module", ts.transpileModule(readFileSync(new URL("./review-associate-pay.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText)(module.exports, module);
const { buildReviewAssociatePay, reviewMappingRates } = module.exports;
const date = "2026-10-13";
const mapping = { id: "m", station_id: "kgqa", workforce_id: "w", provider_member_id: "20001", status: "active",
  effective_from: "2026-08-01", effective_to: null, payment_method_id: "daily", payment_values: { FIXED: 1000 }, payment_methods: { name: "Fixed per day" } };
const cost = { worker_id: "w", station_code: "KGQA", dropx_id: "D1", name: "Associate", provider_ids: ["20001"],
  cohort: "guarantee", deliveries: 49, customer_returns: 1, salary: 1000, variable: 0, fuel: 50, van: 900,
  cost_dates: [date], work_dates: [date], work_bases: [], periods: [{ from: date, to: date, rates: [{ label: "Fixed", rate: 1000, basis: "per day" }] }] };
function input() { return { date, stations: [{ id: "kgqa", station_code: "KGQA" }],
  mappings: [structuredClone(mapping)], components: [{ payment_method_id: "daily", component_code: "FIXED", component_type: "amount", label: "Fixed", pay_schedule: "per_day", payment_fields: {} }],
  links: [{ workforce_id: "w", transporter_id: "A12345" }], scc: [],
  details: [{ station_code: "KGQA", work_date: date, driver_id: "A12345", driver_name: "Associate raw", package_count: 41 }],
  shipments: [{ station_code: "KGQA", work_date: date, provider_employee_id: "20001", total_delivery: 49, assigned_count: 55 }],
  snapshot: { daily: [{ station_code: "KGQA", work_date: date, deliveries: 790, c_return: 10 }], da_details: [structuredClone(cost)] }
}; }
const rows = i => buildReviewAssociatePay(i).get("KGQA");
test("exact portal link merges Amazon/payment IDs, uses live cost and keeps denominators explicit", () => {
  const [r] = rows(input()); assert.equal(rows(input()).length, 1);
  assert.equal(r.delivered, 41); assert.equal(r.assigned, 55); assert.equal(r.totalPay, 1050);
  assert.equal(r.cpsShipments, 50); assert.equal(r.associateCps, 21); assert.equal(r.stationCpsImpact, 1.3125);
  assert.equal(r.paymentScheme, "Fixed per day"); assert.equal(r.rates[0].rate, 1000);
  assert.deepEqual(new Set(r.providerIds), new Set(["A12345", "20001"]));
});
test("SCC exact IDs merge without a portal link; no name matching", () => {
  const i = input(); i.links = []; i.scc = [{ station_id: "kgqa", observed_at: "2026-10-14T03:00:00Z", drivers: [{ employeeId: "20001", tasId: "A12345" }] }];
  assert.equal(rows(i).length, 1);
  i.scc = []; assert.equal(rows(i).length, 2);
  assert.equal(rows(i).find(r => r.associateId === "A12345").associateCps, null);
});
test("SCC pair also deduplicates truly unmapped IDs without fabricating pay", () => {
  const i = input(); i.links = []; i.mappings = []; i.snapshot = null;
  i.scc = [{ station_id: "kgqa", observed_at: "2026-10-14T03:00:00Z", drivers: [{ employeeId: "20001", tasId: "A12345" }] }];
  const result = rows(i); assert.equal(result.length, 1); assert.equal(result[0].delivered, 41); assert.equal(result[0].totalPay, null);
});
test("conflicting and stale SCC evidence cannot assign another person's money", () => {
  const i = input(); i.links = []; i.scc = [{ station_id: "kgqa", observed_at: "2026-10-14T03:00:00Z",
    drivers: [{ employeeId: "20001", tasId: "A12345" }, { employeeId: "20002", tasId: "A12345" }] }];
  assert.match(rows(i).find(r => r.associateId === "A12345").paymentSetupStatus, /conflict/);
  i.scc[0].drivers.pop(); i.scc[0].observed_at = "2026-09-01T00:00:00Z";
  assert.equal(rows(i).length, 2);
});
test("historical closed cards are valid, future/cancelled and other-station cards are not", () => {
  const i = input(); i.mappings[0].status = "closed"; i.mappings[0].effective_to = date;
  assert.equal(rows(i).length, 1);
  for (const change of [{ effective_from: "2026-10-14" }, { status: "cancelled" }, { station_id: "other" }]) {
    const j = input(); j.snapshot = null; Object.assign(j.mappings[0], change);
    assert.equal(rows(j).length, 2); assert.equal(rows(j)[0].paymentScheme, null);
  }
});
test("daily, monthly, MG, per-package and zero amounts retain their units", () => {
  const components = [
    { component_code: "DAILY", component_type: "amount", pay_schedule: "per_day" },
    { component_code: "MONTH", component_type: "amount", pay_schedule: "per_month" },
    { component_code: "MG", component_type: "amount", pay_schedule: "per_day" },
    { component_code: "DELIVERY", component_type: "production", payment_fields: { calculation_source: "amazon_delivery" } },
  ].map(c => ({ ...c, payment_method_id: "m" }));
  const rates = reviewMappingRates({ payment_method_id: "m", payment_values: { DAILY: 1000, MONTH: 24000, MG: 769, DELIVERY: 0 } }, components);
  assert.deepEqual(rates.map(r => [r.rate, r.basis]), [[1000, "per day"], [24000, "per month"], [769, "per day"], [0, "amazon delivery"]]);
});
test("monthly amount is not charged in full or independently prorated by Review", () => {
  const i = input(); i.snapshot.da_details[0].salary = 800; i.snapshot.da_details[0].fuel = 0;
  i.snapshot.da_details[0].periods[0].rates = [{ label: "Monthly", rate: 24000, basis: "per month · attendance based" }];
  const r = rows(i)[0]; assert.equal(r.totalPay, 800); assert.equal(r.rates[0].rate, 24000); assert.equal(r.associateCps, 16);
});
test("pending attendance/fuel never gives misleading zero or partial CPS", () => {
  const i = input(); i.snapshot.da_details[0].pending_fixed_dates = [date];
  const r = rows(i)[0]; assert.equal(r.totalPay, 1050); assert.equal(r.associateCps, null); assert.equal(r.stationCpsImpact, null); assert.match(r.costStatus, /pending/);
});
test("zero shipment cost still contributes station CPS without division by zero", () => {
  const i = input(); i.details = []; i.shipments = []; i.snapshot.da_details[0].deliveries = 0; i.snapshot.da_details[0].customer_returns = 0;
  const r = rows(i)[0]; assert.equal(r.delivered, 0); assert.equal(r.associateCps, null); assert.equal(r.stationCpsImpact, 1.3125);
});
test("MTD uses detail per day and shipment fallback only for missing days", () => {
  const i = input(); i.shipments.push({ ...i.shipments[0], work_date: "2026-10-12", total_delivery: 35 });
  const r = rows(i)[0]; assert.equal(r.mtdActiveDays, 2); assert.equal(r.mtdDelivered, 76);
});
test("lookup failure preserves delivery evidence without stale imported rates or payouts", () => {
  const i = input(); i.snapshot = null; i.error = "Live CPS calculation unavailable";
  i.shipments[0].da_total_pay = 99999; i.shipments[0].del_rate = 500;
  const r = rows(i)[0]; assert.equal(r.delivered, 41); assert.equal(r.totalPay, null); assert.equal(r.rates[0].rate, 1000); assert.equal(r.associateCps, null);
});
test("production code uses shared CPS, scoped dated mappings and complete pagination", () => {
  const data = readFileSync(new URL("./review-associate-pay-data.ts", import.meta.url), "utf8");
  assert.match(data, /loadCpsSnapshot\(companyId, date, date, locations\)/);
  assert.match(data, /in\("status", \["active", "closed"\]\)/);
  assert.match(data, /eq\("company_id", companyId\)\.in\("station_id", ids\)/);
  const review = readFileSync(new URL("./performance-review.ts", import.meta.url), "utf8");
  assert.match(review, /shipmentResult.error/); assert.doesNotMatch(review, /importedRate|mappedDeliveryRate/);
  assert.equal((review.match(/readAllRows\(supabaseAdmin.from/g) ?? []).length, 4);
});

function loader({ failTable, failCost = false } = {}) {
  const i = input(), calls = [];
  const tableData = { field_executive_provider_mappings: i.mappings, workforce_amazon_portal_links: i.links,
    payment_method_components: i.components, workforce_route_scc_snapshots: [] };
  const db = { from(table) {
    const call = { table, filters: [] }; calls.push(call);
    const q = { then(resolve) { return Promise.resolve(resolve(table === failTable ? { data: null, error: { message: "test failure" } } : { data: tableData[table] ?? [], error: null })); } };
    for (const method of ["select", "eq", "in", "lte", "or", "order"]) q[method] = (...args) => { call.filters.push([method, ...args]); return q; };
    return q;
  } };
  const m = { exports: {} };
  const dependencies = { "server-only": {}, "../supabase-admin": { supabaseAdmin: db }, "../supabase-pagination": { readAllRows: async q => q },
    "./cps-snapshot": { loadCpsSnapshot: async (...args) => { calls.push({ snapshot: args }); if (failCost) throw Error("offline"); return i.snapshot; } },
    "./review-associate-pay": module.exports };
  new Function("require", "exports", "module", ts.transpileModule(readFileSync(new URL("./review-associate-pay-data.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText)(name => { assert.ok(name in dependencies, name); return dependencies[name]; }, m.exports, m);
  return { calls, run: () => m.exports.loadReviewAssociatePay("company", date, i.stations, i.details, i.shipments) };
}
test("server loader reuses the exact scoped daily CPS calculation and historic mapping rows", async () => {
  const l = loader(); const result = await l.run(); assert.equal(result.get("KGQA").length, 1);
  assert.equal(result.get("KGQA")[0].associateCps, 21);
  assert.deepEqual(l.calls.find(c => c.snapshot).snapshot, ["company", date, date, [{ id: "kgqa", station_code: "KGQA" }]]);
  for (const call of l.calls.filter(c => c.table)) assert.ok(call.filters.some(f => f[0] === "eq" && f[1] === "company_id" && f[2] === "company"));
});
test("server cost failure preserves saved amounts but withholds CPS", async () => {
  const result = (await loader({ failCost: true }).run()).get("KGQA");
  assert.equal(result[0].rates[0].rate, 1000); assert.equal(result[0].associateCps, null);
  assert.match(result[0].costStatus, /unavailable/);
});
test("mapping/identity/component read failures cannot masquerade as missing pay or zero CPS", async () => {
  for (const table of ["field_executive_provider_mappings", "workforce_amazon_portal_links", "payment_method_components"]) {
    const result = (await loader({ failTable: table }).run()).get("KGQA");
    assert.ok(result.length); assert.ok(result.every(r => r.totalPay === null && r.associateCps === null));
    assert.ok(result.every(r => /could not be loaded/.test(r.costStatus)));
  }
});
test("optional SCC outage does not block exact verified portal IDs", async () => {
  assert.equal((await loader({ failTable: "workforce_route_scc_snapshots" }).run()).get("KGQA").length, 1);
});
test("real component renders daily/monthly/MG/package amounts and pending state", async () => {
  const { previewMarkup } = await import("../../../scripts/preview-review-associate-pay.mjs");
  const html = previewMarkup();
  for (const text of ["₹24,000", "₹1,000", "₹769", "₹15", "Station CPS impact", "CPS shipments", "Pending"]) assert.ok(html.includes(text), text);
  const head = html.match(/class="performance-associate-popover-head">(.*?)<\/div>/)?.[1];
  assert.equal((head.match(/<span>/g) || []).length, 5, "compact five-column split");
  assert.ok(head.endsWith("<span>CPS</span>"), "CPS is the final column");
  assert.ok(html.includes("Station impact:"), "station contribution remains visible with CPS");
});
