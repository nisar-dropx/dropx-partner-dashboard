import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
const require = createRequire(import.meta.url);
function compile(path, mocks = {}) {
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
  )((n) => (n in mocks ? mocks[n] : require(n)), m.exports, m);
  return m.exports;
}
const pricing = compile("./pricing.ts"),
  cps = compile("../ops-pulse/cps.ts");
const p = compile("./pnl.ts", {
  "./pricing": pricing,
  "../ops-pulse/cps": cps,
});
const comparison = compile("./pnl-comparison.ts", { "./pnl": p });
const exportsPnl = compile("./pnl-export.ts", { "./pnl": p, "./pnl-comparison": comparison, "./pricing": pricing });
const perf = compile("./performance.ts", { "./pricing": pricing });
const place = { station_code: "A", station_name: "Station A", region: "South" };
const cday = {
  station_code: "A",
  work_date: "2026-09-01",
  deliveries: 10,
  da: 50,
  utr: 20,
  van: 10,
  rent: 10,
  other: 5,
  overhead: 5,
  total: 100,
  shipment_present: true,
};
const day = {
  date: "2026-09-01",
  revenue: "200",
  deliveries: "10",
  base: "100",
  variable: "60",
  swaRevenue: "30",
  mfnRevenue: "10",
  issues: ["Cost report pending"],
  shipmentReported: true,
};
const snapshot = {
  daily: [cday],
  breakup: [],
  generated_at: "2026-10-05",
  people: [{ name: "PRIVATE STAFF", salary: 12345 }],
  staff: [{ name: "PRIVATE STAFF" }],
};
test("MTD, previous month and leap month use actual calendar boundaries", () => {
  assert.deepEqual(
    [p.pnlFilters({}, "2026-10-05").from, p.pnlFilters({}, "2026-10-05").to],
    ["2026-10-01", "2026-10-05"],
  );
  const last = p.pnlFilters({ period: "last-month" }, "2026-10-05");
  assert.equal(last.from, "2026-09-01");
  assert.equal(last.to, "2026-09-30");
  assert.equal(
    p.pnlFilters({ period: "month", month: "2024-02" }, "2026-10-05").to,
    "2024-02-29",
  );
});
test("invalid, reversed, future and oversized custom ranges are rejected", () => {
  for (const [from, to] of [
    ["2026-02-30", "2026-03-01"],
    ["2026-10-03", "2026-10-01"],
    ["2026-10-01", "2026-10-06"],
    ["2024-01-01", "2026-01-01"],
  ])
    assert.throws(() =>
      p.pnlFilters({ period: "custom", from, to }, "2026-10-05"),
    );
});
test("known costs and expenses reconcile; legacy unavailable costs do not hide profit", () => {
  const r = p.buildPnl(
    [{ station: "A", daily: [day] }],
    snapshot,
    [place],
    "2026-09-01",
    "2026-09-01",
  );
  assert.equal(r.total.profit, 100);
  assert.equal(r.total.cps, 10);
  assert.equal(r.total.rps, 20);
  assert.equal(
    r.total.da + r.total.utr + r.total.van + r.total.rent + r.total.other,
    r.total.cost,
  );
  assert.equal(r.days[0].issues.length, 0);
  assert.ok(!JSON.stringify(r).includes("PRIVATE STAFF"));
});
test("costs are counted once when a station has multiple revenue clients", () => {
  const r = p.buildPnl(
    [
      { station: "A", daily: [day] },
      { station: "A", daily: [{ ...day, revenue: "50", deliveries: "5" }] },
    ],
    snapshot,
    [place],
    "2026-09-01",
    "2026-09-01",
  );
  assert.equal(r.total.revenue, 250);
  assert.equal(r.total.cost, 100);
  assert.equal(r.total.deliveries, 15);
});
test("business CPS uses weighted totals, never average station CPS", () => {
  const r = p.buildPnl(
    [
      { station: "A", daily: [day] },
      { station: "B", daily: [{ ...day, revenue: "1000", deliveries: "100" }] },
    ],
    { ...snapshot, daily: [cday, { ...cday, station_code: "B", total: 200 }] },
    [place, { ...place, station_code: "B" }],
    "2026-09-01",
    "2026-09-01",
  );
  assert.equal(r.total.cps, 300 / 110);
  assert.equal(r.regions.length, 1);
  assert.equal(r.regions[0].cost, 300);
});
test("no source data stays unknown rather than zero or invented profit", () => {
  const r = p.buildPnl(
    [],
    { daily: [], breakup: [], generated_at: "" },
    [place],
    "2026-09-01",
    "2026-09-01",
  );
  assert.equal(r.total.revenue, null);
  assert.equal(r.total.cost, null);
  assert.equal(r.total.profit, null);
  assert.equal(r.total.cps, null);
  assert.ok(r.days[0].issues.length);
});
test("partial data exposes coverage and produces a labelled known result", () => {
  const r = p.buildPnl(
    [{ station: "A", daily: [day] }],
    snapshot,
    [place],
    "2026-09-01",
    "2026-09-02",
  );
  assert.equal(r.total.profit, 100);
  assert.equal(r.total.stationDays, 1);
  assert.equal(r.total.shipmentDays, 1);
  assert.equal(r.total.issueDays, 0);
});
test("custom ranges exclude earlier days while preserving source monthly calculations", () => {
  const r = p.buildPnl(
    [
      {
        station: "A",
        daily: [
          { ...day, date: "2026-08-31", revenue: "999" },
          day,
          { ...day, date: "2026-09-02", revenue: "400" },
        ],
      },
    ],
    snapshot,
    [place],
    "2026-09-01",
    "2026-09-02",
  );
  assert.equal(r.total.revenue, 600);
  assert.equal(r.months[0].key, "2026-09");
});
test("SWA is priced separately, never added to Amazon MG volume", () => {
  const card = {
    rates: {
      mg_amount_including_mhe: "3000",
      delivery_mg_volume: "300",
      variable_slab: "20",
      swa_delivery_rate: "20",
      mfn_rate: "1",
    },
  };
  const snap = {
    daily_shipments: [
      {
        station_code: "A",
        client: "Amazon",
        work_date: "2026-09-01",
        deliveries: "15",
        mg_deliveries: "10",
        returns: "0",
        swa: "5",
        mfn: "0",
        ihs: "0",
        smd: "0",
      },
    ],
  };
  const d = perf.buildDailyRows(
    snap,
    "A",
    "Amazon",
    card,
    "2026-09",
    "2026-09-01",
    false,
  )[0];
  assert.equal(d.eligibleDeliveries, "10");
  assert.equal(d.variable, "0.00");
  assert.equal(d.swaRevenue, "100.00");
  assert.equal(d.revenue, "200.00");
  assert.ok(!d.issues.some((i) => i.includes("SWA")));
  const missing = perf.buildDailyRows(
    snap,
    "A",
    "Amazon",
    undefined,
    "2026-09",
    "2026-09-01",
    false,
  )[0];
  assert.equal(missing.revenue, null);
});
test("monthly MG daily accrual reconciles across 30 and 31 day months", () => {
  for (const [month, days] of [
    ["2026-09", 30],
    ["2026-10", 31],
  ]) {
    const rows = perf.buildDailyRows(
      {},
      "A",
      "Amazon",
      { rates: { mg_amount_including_mhe: "1000", delivery_mg_volume: "300" } },
      month,
      `${month}-${days}`,
      false,
    );
    assert.equal(pricing.addAmounts(rows.map((d) => d.base)), "1000.00");
  }
});
test("zero deliveries never produces Infinity CPS", () => {
  const r = p.buildPnl(
    [{ station: "A", daily: [{ ...day, deliveries: "0" }] }],
    snapshot,
    [place],
    "2026-09-01",
    "2026-09-01",
  );
  assert.equal(r.total.cps, null);
});
test("unknown station scope stays closed and does not query unrestricted source data", async () => {
  const calls = [];
  const data = compile("./pnl-data.ts", {
    "server-only": {},
    "./data": { loadPricing: async () => [], effectiveCards: () => [] },
    "./performance": perf,
    "./pnl": p,
    "./pnl-comparison": comparison,
    "./pricing": pricing,
    "../ops-pulse/cps-data": {
      loadCpsSnapshot: async (company, from, to, locations) => {
        assert.deepEqual(locations, []);
        return { daily: [], breakup: [], generated_at: "" };
      },
    },
  });
  const report = await data.loadPnl(
    {
      companyId: "C",
      locations: [{ ...place, providers: { name: "Amazon" } }],
      db: {
        rpc: async (name, args) => {
          calls.push(args);
          return {
            data: {
              shipments: [],
              costs: [],
              daily_shipments: [],
              read_at: "2026-10-05",
              availability: {},
            },
          };
        },
      },
    },
    { location: "OUTSIDE" },
  );
  assert.deepEqual(calls[0].p_station_codes, []);
  assert.equal(report.total.stations, 0);
});
test("public cost review projection strips employee names and groups duplicate billing issues", () => {
  const r = p.buildPnl(
    [],
    {
      ...snapshot,
      gaps: [
        {
          key: "k",
          kind: "Billing period unconfirmed",
          station_code: "A",
          provider_id: "bill",
          name: "PRIVATE STAFF",
        },
      ],
      expense_periods: [
        {
          station_code: "A",
          source_id: "bill",
          reference: "ELEC-1",
          confirmed: false,
          period_from: "2026-09-01",
          period_to: "2026-09-30",
        },
      ],
    },
    [place],
    "2026-09-01",
    "2026-09-01",
  );
  assert.equal(r.reviews.length, 1);
  assert.equal(r.reviews[0].reference, "ELEC-1");
  assert.ok(!JSON.stringify(r).includes("PRIVATE STAFF"));
});
test("P&L CSV uses scoped live loader, exports reconciled totals and no staff identities", async () => {
  const report = {
    ...p.buildPnl(
      [{ station: "A", daily: [day] }],
      snapshot,
      [place],
      "2026-09-01",
      "2026-09-01",
    ),
    filters: { from: "2026-09-01", to: "2026-09-01" },
    readAt: "2026-10-05",
    locations: [place],
  };
  let seen;
  class NR extends Response {
    static json(value, options) {
      return new Response(JSON.stringify(value), options);
    }
  }
  const route = compile("../../app/finance/business/export/route.ts", {
    "next/server": { NextResponse: NR },
    "@/lib/finance/pnl-data": {
      loadPnl: async (context, q) => {
        seen = { context, q };
        return report;
      },
    },
    "@/lib/finance/pnl-comparison": comparison,
    "@/lib/finance/pnl-export": exportsPnl,
    "@/lib/finance/data": {
      financeContext: async (code) => {
        assert.equal(code, "finance_pnl");
        return { companyId: "C" };
      },
      loadBusiness: async () => {
        throw Error("Legacy costs must not be used");
      },
    },
    "@/lib/finance/performance": perf,
    "@/lib/finance/pricing": pricing,
  });
  const response = await route.GET(
    new Request(
      "https://fin.dropxlogistics.com/finance/business/export?tab=pnl&location=A&region=South",
    ),
  );
  assert.equal(response.status, 200);
  assert.equal(seen.q.location, "A");
  assert.equal(seen.q.region, "South");
  assert.equal(seen.context.companyId, "C");
  assert.match(response.headers.get("Cache-Control"), /no-store/);
  const text = await response.text(),
    rows = pricing.parseCsv(text),
    header = rows.findIndex(r => r[0] === "Group"),
    fields = Object.fromEntries(rows[header].map((h, i) => [h, rows[header + 1][i]]));
  assert.equal(fields["Revenue INR"], "200");
  assert.equal(fields["Expenses INR"], "100");
  assert.equal(fields["Profit / loss INR"], "100");
  assert.equal(fields["CPS INR"], "10");
  assert.equal(fields["Latest station cutoff"], "2026-09-01");
  assert.ok(!text.includes("PRIVATE STAFF"));
  assert.match(text, /unavailable, never zero/);
});

test("delivery cutoff excludes later fixed revenue, all expense heads and future source details",()=>{
 const days=[cday,{...cday,work_date:'2026-09-02',shipment_present:false,deliveries:0,total:999}];
 const r=p.buildPnl([{station:'A',daily:[day,{...day,date:'2026-09-02',shipmentReported:false,deliveries:null,revenue:'999'}]}],{...snapshot,daily:days,breakup:[{station_code:'A',work_date:'2026-09-02',head:'Van',amount:999}]},[place],'2026-09-01','2026-09-05');
 assert.equal(r.total.revenue,200);assert.equal(r.total.cost,100);assert.equal(r.total.profit,100);
 assert.equal(r.days.length,1);assert.deepEqual(r.costs,[]);assert.equal(r.coverage[0].through,'2026-09-01');assert.equal(r.coverage[0].excludedDays,4);
});
test("each station uses its own cutoff, and a reported zero-delivery day still accrues",()=>{
 const r=p.buildPnl([{station:'A',daily:[day]},{station:'B',daily:[{...day,deliveries:'0',date:'2026-09-02'}]}],{...snapshot,daily:[cday,{...cday,station_code:'B',deliveries:0,work_date:'2026-09-02'}]},[place,{...place,station_code:'B'}],'2026-09-01','2026-09-03');
 assert.deepEqual(r.coverage.map(c=>c.through),['2026-09-01','2026-09-02']);assert.equal(r.total.cost,200);assert.equal(r.total.deliveries,10);
});
test("station without any delivery data never contributes unmatched fixed costs or fabricated profit",()=>{
 const r=p.buildPnl([{station:'A',daily:[{...day,shipmentReported:false,deliveries:null}]}],{...snapshot,daily:[{...cday,shipment_present:false,deliveries:0}]},[place],'2026-09-01','2026-09-03');
 assert.equal(r.total.revenue,null);assert.equal(r.total.cost,null);assert.equal(r.total.profit,null);assert.equal(r.coverage[0].through,null);
});

 test("Meta advertising evidence follows the same station delivery cutoff as costs and revenue",()=>{
 const advertising=[{station_code:"A",spend_date:"2026-09-01",spend:12},{station_code:"A",spend_date:"2026-09-02",spend:25},{station_code:"B",spend_date:"2026-09-01",spend:50}];
 const r=p.buildPnl([{station:"A",daily:[day]}],{...snapshot,advertising},[place],"2026-09-01","2026-09-05");
 assert.deepEqual(r.advertising,[advertising[0]]);
 });

test('shared CFO cost evidence cannot leak another model or unauthorized station into P&L detail',()=>{
 const line={station_code:'A',work_date:cday.work_date,head:'DA',sub_head:'Pay',source:'Workforce',amount:50};
 const common={...snapshot,daily:[cday,{...cday,station_code:'DS'}],breakup:[line,{...line,station_code:'DS',amount:99999}],staff:[{station_code:'A',group:'Team'},{station_code:'DS',group:'Private store'}]};
 const out=p.buildPnl([] ,common,[place],'2026-09-01','2026-09-01');
 assert.equal(out.total.cost,100);assert.deepEqual(out.costs,[line]);assert.equal(out.staffGroups.length,1);
 assert.ok(!JSON.stringify(out).includes('Private store'));assert.equal(common.daily.length,2);
});
