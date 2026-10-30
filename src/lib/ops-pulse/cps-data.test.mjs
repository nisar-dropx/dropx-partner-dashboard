import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as XLSX from "xlsx";
import JSZip from "jszip";
const compile = (path, mocks = {}) => {
  const m = { exports: {} };
  new Function(
    "require",
    "exports",
    "module",
    ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
  )(
    (name) => {
      if (name in mocks) return mocks[name];
      throw Error(`Unexpected dependency ${name}`);
    },
    m.exports,
    m,
  );
  return m.exports;
};
const domain = compile("./cps.ts");
const all = [
  { id: "1", station_code: "A", cluster: "North", region: "KL" },
  { id: "2", station_code: "B", cluster: "South", region: "TN" },
];
const context = {
  companyId: "company-a",
  locationScopeIds: ["1"],
  hasAllLocationAccess: false,
};
const emptyQuery = (data = []) => ({
  select() { return this; },
  limit() { return this; },
  eq() { return this; },
  in() { return this; },
  gte() { return this; },
  lte() { return this; },
  order() { return this; },
  then(resolve) { return Promise.resolve(resolve({ data, error: null })); },
});
function dataModule(db, locations = all, rebuildCps = (base) => base) {
  const database = db ? { ...db, from: db.from ?? (() => emptyQuery()) } : db;
  return compile("./cps-data.ts", {
    "server-only": {},
    react: { cache: (fn) => fn },
    "./cps-engine": { rebuildCps },
    "./advertising": { excludeAdvertisingSettlements: base => base },
    "./advertising-data": { loadAdvertising: async () => ({breakup:[],gaps:[],rows:[],settlements:[]}) },
    "@/lib/company-scope": { requireCompanyId: (a) => a.companyId },
    "@/lib/authorization": {},
    "./cod": {
      loadCodLocations: async () => ({ locations, error: null }),
      todayKolkata: () => "2026-09-11",
    },
    "./adhoc-activity": { adHocClusterLabel: (l) => l.cluster },
    "./cps": domain,
    "@/lib/supabase-admin": { supabaseAdmin: database },
    "@/lib/supabase-pagination": { readAllRows: async (query) => await query },
    "@/lib/workforce-payment-policy": { workforcePaymentMonthStart: (date) => `${date.slice(0, 7)}-01` },
  });
}
test("forged station and intersecting filters cannot widen permitted locations", async () => {
  const d = dataModule(null, [all[0]]);
  assert.equal(
    (await d.cpsScope(context, { station: "B" })).selected.length,
    0,
  );
  assert.equal(
    (await d.cpsScope(context, { station: "A", region: "TN" })).selected.length,
    0,
  );
  assert.equal((await d.cpsScope(context, {})).selected.length, 1);
  const withHidden = dataModule(null, [
    all[0],
    { ...all[1], hide_from_location_list: true },
  ]);
  assert.deepEqual(
    (await withHidden.cpsScope(context, {})).all.map((l) => l.station_code),
    ["A"],
  );
  assert.equal(
    (await withHidden.cpsScope(context, { station: "B" })).selected.length,
    0,
  );
});
test("RPC receives company, sorted station scope and exact period; empty scope does not query", async () => {
  const calls = [];
  const db = {
    rpc: async (...args) => {
      if(args[0] === "ops_cps_source_facts") return { data: { shipments: [], stations: [] }, error: null };
      if(args[0] === "ops_cps_vehicle_costs") return { data: { breakup: [], gaps: [], vehicles: [] }, error: null };
      if(args[0] === "ops_cps_people_assignments") return {data:{employees:[],salaries:[],stations:[],volumes:[],assignments:[]},error:null};
      if(args[0] === "ops_cps_period_expenses") return {data:[],error:null};
      calls.push(args);
      return { data: { daily: [], breakup: [] }, error: null };
    },
  };
  const d = dataModule(db);
  await d.loadCpsSnapshot("company-a", "2026-09-01", "2026-09-08", []);
  assert.equal(calls.length, 0);
  await d.loadCpsSnapshot(
    "company-a",
    "2026-09-01",
    "2026-09-08",
    all.toReversed(),
  );
  await d.loadCpsSnapshot("company-b", "2026-09-09", "2026-09-09", [all[1]]);
  assert.deepEqual(calls[0][1], {
    p_company: "company-a",
    p_from: "2026-09-01",
    p_through: "2026-09-08",
    p_stations: ["A", "B"],
  });
  assert.equal(calls[1][1].p_company, "company-b");
  assert.deepEqual(calls[1][1].p_stations, ["B"]);
});
test("daily CPS passes calendar-month production context to the engine without widening display facts", async () => {
  let captured;
  const mapping = {
    id: "mapping-1", workforce_id: "worker-1", provider_id: "provider-1",
    provider_member_id: "member-1", station_id: "1", effective_from: "2026-01-01",
    effective_to: null, status: "active", payment_method_id: "method-1",
    payment_values: { DELIVERY: 10 },
  };
  const currentShipment = { id: "current", work_date: "2026-09-15", station_code: "A" };
  const carryInShipment = { id: "carry-in", work_date: "2026-09-01", station_code: "A" };
  const commonFacts = {
    mappings: [mapping], workforce: [{ id: "worker-1" }],
    components: [{ payment_method_id: "method-1", component_code: "DELIVERY" }],
    providers: [{ id: "provider-1", code: "AMAZON", name: "Amazon" }],
    stations: [{ id: "1", station_code: "A" }], employees: [], salaries: [], volumes: [],
  };
  const db = {
    rpc: async (name, args) => {
      if (name === "ops_cps_base_v2") return { data: { daily: [{ station_code: "A", work_date: "2026-09-15" }], breakup: [] }, error: null };
      if (name === "ops_cps_source_facts") return {
        data: { ...commonFacts, shipments: args.p_from === "2026-09-01" ? [carryInShipment, currentShipment] : [currentShipment] },
        error: null,
      };
      if (name === "ops_cps_vehicle_costs") return { data: { breakup: [], gaps: [], vehicles: [] }, error: null };
      if (name === "ops_cps_people_assignments") return { data: { employees: [], salaries: [], stations: [], volumes: [], assignments: [] }, error: null };
      throw Error(`Unexpected RPC ${name}`);
    },
    from: (table) => emptyQuery({
      field_executive_provider_mappings: [{ id: "mapping-1", production_threshold_config: { period: "month", component_codes: ["DELIVERY"], minimum_units: 100 } }],
      payment_methods: [{ id: "method-1", production_threshold_config: { period: "month", component_codes: ["DELIVERY"] } }],
      payment_method_components: [{ payment_method_id: "method-1", component_code: "DELIVERY", sort_order: 7 }],
    }[table] ?? []),
  };
  const d = dataModule(db, [all[0]], (base, facts) => { captured = facts; return base; });
  await d.loadCpsSnapshot("company-a", "2026-09-15", "2026-09-15", [all[0]]);
  assert.deepEqual(captured.shipments.map((row) => row.id), ["current"]);
  assert.deepEqual(captured.production_threshold_context.shipments.map((row) => row.id), ["carry-in", "current"]);
  assert.equal(captured.production_threshold_context.mappings[0].production_threshold_config.minimum_units, 100);
  assert.equal(captured.production_threshold_context.components[0].sort_order, 7);
});
test("failed or malformed snapshot cannot become a healthy empty report", async () => {
  for (const result of [
    { data: null, error: { code: "503" } },
    { data: { daily: [] }, error: null },
  ])
    await assert.rejects(
      dataModule({ rpc: async () => result }).loadCpsSnapshot(
        "company-a",
        "2026-09-01",
        "2026-09-08",
        all,
      ),
    );
});
test("Excel endpoint denies missing report or view permission before any data reads", async () => {
  for (const permissions of [[], ["cps_reports"], ["cps_daily"]]) {
    const endpoint = compile("../../app/api/ops-pulse/cps/report/route.ts", {
      "@/lib/authorization": {
        getAuthorization: async () => context,
        hasPermission: (_a, p) => permissions.includes(p),
      },
      "@/lib/ops-pulse/cps-data": {
        cpsScope: () => {
          throw Error("Data queried before permission");
        },
      },
      "@/lib/ops-pulse/cps": domain,
      "@/lib/report-workbook": {},
      "@/lib/ops-pulse/adhoc-activity": {},
    });
    assert.equal(
      (
        await endpoint.GET(
          new Request(
            "https://ops.dropxlogistics.com/api/ops-pulse/cps/report?view=daily",
          ),
        )
      ).status,
      403,
    );
  }
});
test("shared-cost edit cannot move an out-of-scope allocation into scope", async () => {
  let wrote = false;
  const record = { station_codes: ["A", "B"], updated_at: "v1" };
  const query = {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    async maybeSingle() {
      return { data: record, error: null };
    },
    update() {
      wrote = true;
      return this;
    },
  };
  const actions = compile("../../app/cps/actions.ts", {
    "next/cache": { revalidateTag() {} },
    "@/lib/authorization": {
      getAuthorization: async () => context,
      hasPermission: () => true,
    },
    "@/lib/ops-pulse/cps-data": {
      cpsScope: async () => ({ companyId: "company-a", all: [all[0]] }),
    },
    "@/lib/ops-pulse/cps": domain,
    "@/lib/supabase-admin": { supabaseAdmin: { from: () => query } },
  });
  const form = new FormData();
  for (const [k, v] of Object.entries({
    id: "00000000-0000-4000-8000-000000000001",
    label: "staff",
    head: "UTR",
    station_codes: "A",
    amount: "0",
    frequency: "monthly",
    allocation: "equal",
    effective_from: "2026-09-01",
    updated_at: "v1",
  }))
    form.set(k, v);
  assert.equal((await actions.saveCpsCost(form)).ok, false);
  assert.equal(wrote, false);
});
test("Excel round-trip keeps all days, numeric costs, data gaps and safe text", async () => {
  const days = Array.from({ length: 31 }, (_, i) => ({
    station_code: "A",
    work_date: `2026-08-${String(i + 1).padStart(2, "0")}`,
    deliveries: 100,
    activity: 110,
    associate_rows: 2,
    unmapped: 1,
    unpaid: 0,
    da: 900,
    utr: 100,
    van: 200,
    other: 300,
    rent: 100,
    total: 1500,
    target: null,
    shipment_present: true,
    utr_configured: true,
  }));
  const workbook = compile("../report-workbook.ts", {
    xlsx: XLSX,
    jszip: { default: JSZip },
  });
  const endpoint = compile("../../app/api/ops-pulse/cps/report/route.ts", {
    "@/lib/authorization": {
      getAuthorization: async () => context,
      hasPermission: () => true,
    },
    "@/lib/ops-pulse/cps-data": {
      cpsScope: async () => ({
        companyId: "company-a",
        selected: [all[0]],
        period: domain.cpsPeriod(
          { view: "monthly", month: "2026-08" },
          "2026-09-11",
        ),
      }),
      loadCpsSnapshot: async () => ({
        daily: days,
        breakup: days.map((d) => ({
          work_date: d.work_date,
          station_code: "A",
          head: "Other",
          source: "CPS Inputs",
          sub_head: '=HYPERLINK("https://invalid.example")',
          amount: 300,
        })),
        generated_at: "2026-09-11T00:00:00Z",
      }),
    },
    "@/lib/ops-pulse/cps": domain,
    "@/lib/report-workbook": workbook,
    "@/lib/ops-pulse/adhoc-activity": { adHocClusterLabel: (l) => l.cluster },
  });
  const response = await endpoint.GET(
    new Request(
      "https://ops.dropxlogistics.com/api/ops-pulse/cps/report?view=monthly&month=2026-08",
    ),
  );
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-disposition"),
    /cps-monthly-2026-08-01-to-2026-08-31.xlsx/,
  );
  const book = XLSX.read(new Uint8Array(await response.arrayBuffer()), {
    type: "array",
  });
  assert.deepEqual(book.SheetNames, [
    "Summary",
    "Station CPS",
    "Daily CPS",
    "Cost breakup",
    "Staff cost allocation", "Bill periods",
    "Vehicle rent",
  ]);
  assert.equal(XLSX.utils.sheet_to_json(book.Sheets["Daily CPS"]).length, 31);
  const [summary] = XLSX.utils.sheet_to_json(book.Sheets.Summary);
  assert.equal(summary.Deliveries, 3100);
  assert.equal(summary["Recorded cost"], 46500);
  assert.equal(summary["Recorded CPS"], 15);
  assert.equal(summary.Status, "Provisional");
  assert.match(summary["Data gaps"], /payment setup/);
  const cell = book.Sheets["Cost breakup"].D2;
  assert.equal(cell.t, "s");
  assert.equal(cell.f, undefined);
});

test('multiple station selection respects access and excludes HO masters',async()=>{
 const d=dataModule(null,[...all,{id:'3',station_code:'OFFICE',is_ho:true}]);
 assert.deepEqual((await d.cpsScope(context,{station:'a,B,FORGED'})).selected.map(s=>s.station_code),['A','B']);
 assert.equal((await d.cpsScope(context,{station:'OFFICE'})).selected.length,0);
});
test('cross-month reads split RPC boundaries and reuse bill snapshot without another bill RPC',async()=>{
 const calls=[];
 const db={rpc:async(name,args)=>{
  calls.push([name,args]);
  if(name==='ops_cps_source_facts')return {data:{shipments:[],stations:[]},error:null};
  if(name==='ops_cps_vehicle_costs')return {data:{breakup:[],gaps:[],vehicles:[]},error:null};
  if(name==='ops_cps_people_assignments')return {data:{employees:[],salaries:[],stations:[],volumes:[],assignments:[]},error:null};
  return {data:{daily:[],breakup:[],expense_periods:[{source:'payment',source_id:'shared-bill'}]},error:null};
 }};
 const result=await dataModule(db).loadCpsSnapshot('company-a','2026-08-31','2026-09-02',all);
 const base=calls.filter(([name])=>name==='ops_cps_base_v2');
 assert.deepEqual(base.map(([,a])=>[a.p_from,a.p_through]),[['2026-08-31','2026-08-31'],['2026-09-01','2026-09-02']]);
 assert.ok(base.every(([,a])=>a.p_company==='company-a'&&a.p_stations.join(',')==='A,B'));
 assert.equal(calls.some(([n])=>n==='ops_cps_period_expenses'),false);assert.equal(result.expense_periods.length,1);
});

test('Fleet rent replaces base-RPC rent exactly once while genuine ad hoc costs survive',async()=>{
 const rent={station_code:'A',work_date:'2026-09-01',head:'Van',sub_head:'Vehicle rent · V1',source:'Fleet Vehicle Master',amount:500};
 const adhoc={...rent,source:'Approved payment requests',sub_head:'Adhoc Van',amount:250};
 const db={rpc:async(name)=>({error:null,data:name==='ops_cps_source_facts'?{shipments:[],stations:[]}:name==='ops_cps_people_assignments'?{employees:[],salaries:[],stations:[],volumes:[],assignments:[]}:name==='ops_cps_vehicle_costs'?{breakup:[{...rent,amount:0}],gaps:[],vehicles:[]}:{daily:[],breakup:[rent,adhoc]}})};
 const result=await dataModule(db).loadCpsSnapshot('company-a','2026-09-01','2026-09-01',[all[0]]);
 assert.equal(result.breakup.filter(l=>l.source==='Fleet Vehicle Master').length,1);
 assert.equal(result.breakup.find(l=>l.source==='Fleet Vehicle Master').amount,0,'canonical rent-blocked day wins over stale base rent');
 assert.equal(result.breakup.find(l=>l.source==='Approved payment requests').amount,250);
});
