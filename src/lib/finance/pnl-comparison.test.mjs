import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
const require = createRequire(import.meta.url);
function compile(file, mocks = {}) {
  const module = { exports: {} };
  new Function("require", "exports", "module", ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText)(id => id in mocks ? mocks[id] : require(id), module.exports, module);
  return module.exports;
}
const pricing = compile("./pricing.ts"), cps = compile("../ops-pulse/cps.ts"), pnl = compile("./pnl.ts", { "./pricing": pricing, "../ops-pulse/cps": cps });
const c = compile("./pnl-comparison.ts", { "./pnl": pnl });
const e = compile("./pnl-export.ts", { "./pnl": pnl, "./pnl-comparison": c, "./pricing": pricing });
const options = c.comparisonOptions({});
const locations = [
  { station_code: "P", station_name: "Parent", region: "South", pricing_model: "mg" },
  { station_code: "X", station_name: "Child", region: "Old region", pricing_model: "xpt", parent_station_code: "P" },
  { station_code: "Z", station_name: "Zero", region: "North" },
  { station_code: "N", station_name: "No data", region: "North" },
];
const day = (station, revenue, cost, deliveries, date = "2026-09-01") => ({ station, name: station, region: "North", date, revenue, cost, deliveries, base: revenue, variable: 0, swa: 0, mfn: 0, da: cost ?? 0, utr: 0, van: 0, rent: 0, other: 0, issues: revenue === null ? ["Pricing missing"] : [] });
const days = [day("P", 100, 60, 10), day("X", 30, 80, 5), day("Z", 0, 0, 0), day("N", null, null, null)];
const report = { days, locations, costs: days.map(d => ({ station_code: d.station, work_date: d.date, head: "DA", sub_head: "Payment", source: "Rate card", amount: d.cost })), reviews: [{station:"X",kind:"Mapping",reference:"DX1",from:"2026-09-01",to:"2026-09-01",deliveries:5,href:"/id-mapping"},{station:"X",kind:"Future gap",reference:"DX2",from:"2026-09-03",to:"2026-09-04",deliveries:10,href:"/id-mapping"}], filters:{from:"2026-09-01",to:"2026-09-02",location:"",provider:"",region:"",cluster:""}, readAt:"2026-10-06T01:00:00Z" };
test("parent plus XPT count once with weighted CPS, and reconcile to the original business total", () => {
  const result = c.comparisonSelection(report, options);
  assert.equal(result.entries.length, 3);
  const parent = result.entries.find(r => r.key === "P");
  assert.deepEqual(parent.members, ["P", "X"]); assert.equal(parent.revenue, 130); assert.equal(parent.cost, 140); assert.equal(parent.profit, -10); assert.equal(parent.cps, 140 / 15);
  assert.match(parent.subtitle, /Includes XPT X/);
  assert.equal(result.total.profit, pnl.pnlTotal(days).profit);
});
test("search by child code/name retains the whole authorized parent group", () => {
  const result = c.comparisonSelection(report, {...options, search:"child"});
  assert.deepEqual(result.entries.map(r=>r.key),["P"]); assert.equal(result.total.deliveries, 15);
});
test("XPT-only scope cannot pull parent or sibling financials", () => {
  const result = c.comparisonSelection({...report, days:[days[1]], locations:[locations[1]]}, options);
  assert.equal(result.entries[0].key,"P"); assert.equal(result.total.cost,80); assert.match(result.entries[0].subtitle,/XPT only/);
});
test("regions follow the parent relationship and no data is duplicated", () => {
  const result = c.comparisonSelection(report,{...options,view:"regions"});
  const south = result.entries.find(r=>r.key==="South"); assert.deepEqual(south.members,["P","X"]); assert.equal(south.revenue,130);
});
test("numeric sorting keeps missing values last in both directions and respects zero", () => {
  for(const direction of ["asc","desc"]) {
    const result=c.comparisonSelection(report,{...options,sort:"profit",direction});
    assert.equal(result.entries.at(-1).key,"N");
    assert.deepEqual(result.entries.slice(0,2).map(r=>r.key),direction==="asc"?["P","Z"]:["Z","P"]);
  }
});
test("loss filters and shown totals exclude hidden results; unavailable is not break-even or profit", () => {
  assert.equal(c.comparisonSelection(report,{...options,focus:"loss"}).total.cost,140);
  assert.deepEqual(c.comparisonSelection(report,{...options,focus:"unavailable"}).entries.map(r=>r.key),["N"]);
  assert.equal(c.comparisonSelection(report,{...options,focus:"profit"}).entries.length,0);
  assert.equal(c.pnlResultClass(null),"pnl-neutral"); assert.equal(c.pnlResultLabel(0),"Break-even");
});
test("mixed member cutoffs and absent member reports remain visible", () => {
  const result=c.comparisonSelection({...report,days:[days[0],day("X",30,80,5,"2026-09-02"),day("P",null,null,null,"2026-09-02")]},options);
  assert.equal(result.entries[0].earliestThrough,"2026-09-01"); assert.equal(result.entries[0].dataThrough,"2026-09-02");
  const missing=c.comparisonSelection({...report,days:[days[0],day("X",null,null,null)]},options);assert.equal(missing.entries[0].missingMembers,1);
});
test("invalid query and prototype keys cannot select unexpected groupings", () => {
  assert.deepEqual(c.comparisonOptions({view:"__proto__",focus:"toString",sort:"constructor",direction:"bad"}),options);
});
test("loader expands a requested parent or child only within authorized locations", async () => {
  let seen;
  const query = {}; for (const method of ["select", "eq", "in", "lte", "order"]) query[method] = () => query;
  query.range = async () => ({ data: [] });
  const loader = compile("./pnl-data.ts", { "server-only": {}, "./data": { loadPricing: async () => [], effectiveCards: () => [] }, "./performance": { buildBusinessRows: () => [] }, "./pnl": pnl, "./pricing": pricing, "./pnl-comparison": c, "../ops-pulse/cps-data": { loadCpsSnapshot: async (company, from, to, selected) => { assert.deepEqual(selected.map(l=>l.station_code),seen); return {daily:[],breakup:[]}; } } });
  const context = { companyId: "company", locations, db: { from: () => query, rpc: async (name,args) => { seen=args.p_station_codes; return {data:{daily_shipments:[],read_at:"2026-10-06",availability:{}}}; } } };
  for (const location of ["P","X"]) {
    await loader.loadPnl(context,{location,region:"South",period:"month",month:"2026-09",includeXpts:"0"});
    assert.deepEqual(seen,["P","X"]);
  }
  await loader.loadPnl({...context,locations:[locations[1]]},{location:"P",period:"month",month:"2026-09"});
  assert.deepEqual(seen,["X"]);
});
test("Excel preserves numbers, nulls and filtered evidence without formula injection",async()=>{
  const XLSX=require("xlsx");
  const buffer=await e.exportPnlExcel(report,{...options,focus:"loss"});const book=XLSX.read(buffer,{type:"buffer"});
  assert.deepEqual(book.SheetNames,["Comparison","Station days","Source costs","Items to review","Report notes"]);
  assert.equal(book.Sheets.Comparison.D2.v,130);assert.equal(book.Sheets.Comparison.D2.t,"n");assert.equal(book.Sheets.Comparison.F2.v,-10);
  const costs=XLSX.utils.sheet_to_json(book.Sheets["Source costs"]);assert.equal(costs.length,2);assert.deepEqual(costs.map(r=>r.Station),["P","X"]);
  assert.equal(XLSX.utils.sheet_to_json(book.Sheets["Items to review"]).length,1);
  const injected={...report,locations:report.locations.map(l=>({...l,station_name:"=HYPERLINK(\"bad\")"}))};
  const safe=XLSX.read(await e.exportPnlExcel(injected,options),{type:"buffer"});assert.equal(safe.Sheets.Comparison.A2.f,undefined);
});
test("CSV contains grouping, source cutoff and scope, and escapes spreadsheet formulas",()=>{
  const csv=e.exportPnlCsv(report,{...options,focus:"loss",search:"=1+1"});assert.match(csv,/'=1\+1/);assert.match(csv,/Requested through/);assert.match(csv,/Latest station cutoff/);
});
test("PDF produces a real multipage document with all results",async()=>{
  const large={...report,days:Array.from({length:60},(_,i)=>day(`S${String(i).padStart(3,"0")}`,100,150,10)),locations:[]};
  const bytes=await e.exportPnlPdf(large,options);const {PDFDocument}=require("pdf-lib");const doc=await PDFDocument.load(bytes);assert.ok(doc.getPageCount()>=3);assert.match(doc.getTitle(),/DropX P&L/);
});

test("XPT payouts split from parent fixed revenue without changing the total or treating missing rates as zero",()=>{
  const split=c.fixedRevenueBreakdown(days,locations);
  assert.deepEqual(split,{base:100,xpt:30,hasXpt:true});
  assert.equal(split.base+split.xpt,pnl.pnlTotal(days).base);
  assert.equal(c.fixedRevenueBreakdown([day("X",null,null,5)],locations).xpt,null);
  const exported=e.pnlExportData(report,options).sheets["Station days"];
  const x=exported.find(r=>r[1]==="X"), parent=exported.find(r=>r[1]==="P");
  assert.equal(x[8],null);assert.equal(x[9],30);assert.equal(parent[8],100);assert.equal(parent[9],null);
});
