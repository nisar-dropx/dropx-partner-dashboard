import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import * as XLSX from "xlsx";

const source = readFileSync(new URL("../src/lib/ops-pulse/station-edd.ts", import.meta.url), "utf8");
const transpile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
// Negative evidence is time-sensitive. Freeze the scenario clock, never production time.
class EddTestDate extends Date { constructor(...args) { super(...(args.length ? args : ["2026-09-09T10:05:00Z"])); } static now() { return Date.parse("2026-09-09T10:05:00Z"); } }
const verification = {};
new Function("require","exports","Date",transpile(readFileSync(new URL("../src/lib/ops-pulse/edd-verification.ts",import.meta.url),"utf8")))(()=>({}),verification,EddTestDate);
const edd = {};
new Function("require","exports","Date",transpile(source))(()=>verification,edd,EddTestDate);
const today = "2026-09-09";
const pkg = (trackingId, state, values = {}) => ({ trackingId, state, ead: today, bucket: "future", packageType: "Delivery", driverId: "", verifiedAt:today+"T10:00:00Z", verification:{ state, historyComplete:true, firstAttemptAt:null, firstDispatchAt:null }, ...values });
const packages = [
  pkg("1", "INDUCTED"),
  pkg("2", "INDUCTED", { driverId: "retained-id" }),
  pkg("3", "RECEIVED", { driverId: "retained-id" }),
  pkg("4", "IN_TRANSIT_TO_CUSTOMER"),
  pkg("5", "DELIVERY_FAILED"),
  pkg("6", "DELIVERED"),
  pkg("7", "INDUCTED", { ead: "2026-09-08" }),
  pkg("8", "INDUCTED", { ead: "2026-09-10" }),
  pkg("9", "INDUCTED", { packageType: "CReturns" }),
  pkg("10", "INDUCTED", { shipOption: "in-ez-rto" }),
  pkg("11", "MANIFESTED"),
  pkg("12", "INDUCTED", { ead: null }),
  pkg("1", "INDUCTED")
];
const summary = edd.summarizeStationEdd("AWEZ", packages, "2026-09-09T11:13:12Z", today);
assert.equal(summary.todayAtStation, 3, "INDUCTED/RECEIVED count even with retained driver IDs");
assert.equal(summary.todayOnRoad, 1, "on-road status stays separate even without a driver ID");
assert.equal(summary.todayOther, 1, "only manifested remains other");
assert.equal(summary.todayDelivered, 1);
assert.equal(summary.todayAttempted, 1);
assert.equal(summary.todayTotal, 7, "same EDD cohort with reverse shipments excluded and TIDs deduplicated");
assert.equal(summary.overdueAtStation, 1);
assert.equal(summary.missingDate, 1);
assert.equal(summary.excludedReverse, 2);
assert.equal(edd.stationEddPackageMatches(packages[0], "atStation", "today", today), true, "old upstream future bucket must not override today's actual date");
assert.equal(edd.stationEddPackageMatches(packages[6], "atStation", "today", today), false);
assert.equal(edd.stationEddPackageMatches(packages[6], "atStation", "overdue", today), true);
assert.equal(edd.stationEddPackageMatches(packages[8], "all", "all", today), false);
assert.equal(edd.stationEddPackageMatches(packages[0], "atStation", "pending", today), true);
assert.equal(edd.stationEddPackageMatches(packages[6], "atStation", "pending", today), true);
assert.equal(edd.stationEddPackageMatches(packages[7], "atStation", "pending", today), false, "future EDD excluded from pending");
assert.equal(edd.stationEddPackageMatches(packages[11], "atStation", "pending", today), false, "unknown EDD excluded from pending");
assert.equal(edd.stationEddSearchMatches(packages[1], "INDUCTED", " RETAINED-ID "), true);
assert.equal(edd.stationEddSearchMatches(packages[1], "RECEIVED", ""), false);
assert.deepEqual(edd.stationEddSelection(["overdue"], ["all"]), { day: "today", position: "atStation" });
assert.deepEqual(edd.stationEddSelection("overdue", "onRoad"), { day: "overdue", position: "onRoad" });
assert.equal(edd.stationEddDate(pkg("x", "INDUCTED", { ead: "2026-02-30", internalEAD: today })), today);
assert.equal(edd.stationEddToday(new Date("2026-09-08T18:29:59Z")), "2026-09-08");
assert.equal(edd.stationEddToday(new Date("2026-09-08T18:30:00Z")), today);
assert.equal(edd.stationEddFreshness("2026-09-07T03:00:00Z", new Date("2026-09-09T11:00:00Z")), "Stale — previous day");
assert.equal(edd.summarizeStationEdd("X", null, null, today).hasSnapshot, false);
assert.equal(edd.summarizeStationEdd("X", [], "2026-09-09T11:00:00Z", today).hasSnapshot, true);
const sheets = edd.stationEddReportSheets({ stationCode: "AWEZ", fetchedAt: "2026-09-09T11:13:12Z", packages }, "Kalady", today);
const workbookSource = readFileSync(new URL("../src/lib/report-workbook.ts", import.meta.url), "utf8");
const workbookJs = ts.transpileModule(workbookSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
const workbookModule = {};
new Function("require", "exports", workbookJs)(createRequire(import.meta.url), workbookModule);
const response = await workbookModule.compressedWorkbookResponse(sheets, "station-edd-AWEZ.xlsx");
assert.match(response.headers.get("Content-Disposition"), /station-edd-AWEZ.xlsx/);
const bytes = Buffer.from(await response.arrayBuffer());
const parsed = XLSX.read(bytes, { type: "buffer" });
assert.deepEqual(parsed.SheetNames, ["Summary", "Source Statuses", "At Station EDD Today", "Overdue At Station", "Associates EDD Today", "HFR", "Attempt lifecycle", "All Snapshot TIDs"]);
const atStation = XLSX.utils.sheet_to_json(parsed.Sheets["At Station EDD Today"]);
assert.equal(atStation.length, 3);
assert.deepEqual(atStation.map(r => r["Tracking ID"]), ["1", "2", "3"]);
assert.equal(atStation[1]["Driver ID (source)"], "retained-id");
assert.equal(atStation[0]["EDD / EAD"], today);
assert.equal(atStation[0]["Snapshot Refreshed UTC"], "2026-09-09T11:13:12Z");
assert.equal(XLSX.utils.sheet_to_json(parsed.Sheets.Summary)[0]["At Station EDD Today"], atStation.length);
const largePackages = Array.from({ length: 8000 }, (_, i) => pkg(String(370000000000 + i), i % 2 ? "INDUCTED" : "RECEIVED", {
  city: "ERNAKULAM", postalCode: "683574", lastScanBy: "station-operator", driverId: "driver-" + i,
  orderingOrderId: "407-" + (1000000 + i) + "-1234567", promisedDeliveryDate: today, internalEAD: today,
  estimatedArrivalTimeUTC: "2026-09-09 14:30:00", packageType: "Delivery", shipOption: "Std IN National",
  lockerName: "Customer-" + i, paymentMethod: "PREPAY", minutesInState: i
}));
const largeSheets = edd.stationEddReportSheets({ stationCode: "ERSE", fetchedAt: "2026-09-09T11:13:12Z", packages: largePackages }, "Perumbavoor", today);
const largeResponse = await workbookModule.compressedWorkbookResponse(largeSheets, "station-edd-ERSE.xlsx");
const largeBytes = Buffer.from(await largeResponse.arrayBuffer());
assert.ok(largeBytes.length < 4_000_000, "8000-TID detailed workbook must fit the response budget");
const largeBook = XLSX.read(largeBytes, { type: "buffer" });
assert.equal(XLSX.utils.sheet_to_json(largeBook.Sheets["All Snapshot TIDs"]).length, 8000);
console.log(`PASS Large report: 8000 TIDs, ${largeBytes.length} bytes, all rows preserved.`);
const networkRows = Array.from({ length: 30000 }, (_, i) => edd.stationEddPackageRow(
  { ...largePackages[i % 8000], trackingId: String(370000000000 + i), ead: i % 2 ? today : "2026-09-08" },
  "ST" + i % 38, "Station " + i % 38, "2026-09-09T11:13:12Z", today
));
const networkResponse = await workbookModule.compressedWorkbookResponse([{ name: "Pending TIDs", rows: networkRows }], "pending-edd-all-locations.xlsx");
const networkBytes = Buffer.from(await networkResponse.arrayBuffer());
assert.ok(networkBytes.length < 4_000_000, "30000-TID network pending export fits response budget");
const networkBook = XLSX.read(networkBytes, { type: "buffer" });
const networkParsed = XLSX.utils.sheet_to_json(networkBook.Sheets["Pending TIDs"]);
assert.equal(networkParsed.length, 30000);
assert.equal(new Set(networkParsed.map(r => r["Station Code"])).size, 38);
assert.equal(networkParsed.filter(r => r["EDD Period"] === "Overdue").length, 15000);
// Verify the server loader never queries unscoped stations and preserves missing rows.
const loaderSource = readFileSync(new URL("../src/lib/ops-pulse/station-edd-data.ts", import.meta.url), "utf8");
const loaderJs = ts.transpileModule(loaderSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const requests = [];
const snapshots = [{ station_code: "ERSE", packages, fetched_at: "2026-09-09T11:13:12Z" }, { station_code: "AWEZ", packages, fetched_at: "2026-09-09T11:13:12Z" }];
const mockLedger = { loadEddLedger: async codes => { requests.push(codes); return new Map(snapshots.filter(s=>codes.includes(s.station_code)).map(s=>[s.station_code,{packages:s.packages,fetchedAt:s.fetched_at}])); } };
const loader = {};
new Function("require", "exports", loaderJs)(name => name === "server-only" ? {} : name.includes("edd-ledger") ? mockLedger : edd, loader);
const seen = [];
const scoped = await loader.loadStationEddNetwork(["AWEZ", "MISSING", "AWEZ"], code => seen.push(code));
assert.deepEqual(requests, [["AWEZ", "MISSING"]]);
assert.deepEqual(scoped.map(s => s.stationCode), ["AWEZ", "MISSING"]);
assert.deepEqual(seen, ["AWEZ"], "export callback must not see ERSE outside requested scope");
assert.equal(scoped[1].hasSnapshot, false);
console.log(`PASS All-location pending export: 30000 TIDs across 38 stations, ${networkBytes.length} bytes; scope and missing snapshots verified.`);
console.log("PASS Station EDD behavioral tests: statuses, dates, retained IDs, reverse shipments, duplicates, missing/stale data, and XLSX round-trip.");
const history = [{state:"INDUCTED",time:"2026-09-09T05:50:00Z"},{state:"DELIVERY_ATTEMPTED",time:"2026-09-08T11:00:00Z"},{state:"IN_TRANSIT",time:"2026-09-08T06:00:00Z"}];
const facts = verification.eddHistoryFacts(history);
assert.equal(facts.firstAttemptAt,"2026-09-08T11:00:00.000Z");
assert.equal(edd.stationEddPosition(pkg("hfr","INDUCTED",{verification:{...facts,state:"INDUCTED"}}),today),"hfr","previous-day attempt remains HFR after re-induction");
assert.equal(edd.stationEddPosition(pkg("same","INDUCTED",{verification:{...facts,state:"INDUCTED",firstAttemptAt:today+"T08:00:00Z"}}),today),"attempted","same-day attempt is never fresh EDD pending");
assert.equal(edd.stationEddPosition(pkg("unknown","INDUCTED",{verification:null}),today),"unverified");
assert.equal(edd.stationEddPosition(pkg("partial","RECEIVED",{verification:{historyComplete:false}}),today),"unverified");
assert.equal(edd.stationEddPosition(pkg("newer","INDUCTED",{sourceAt:today+"T11:00:00Z"}),today),"unverified","a newer source scan invalidates older no-dispatch evidence");
assert.equal(edd.stationEddPosition(pkg("372163051022","INDUCTED",{verification:{state:"DELIVERED"}}),today),"delivered","delivered lookup cannot remain in pending");
assert.equal(edd.stationEddPosition(pkg("stale-pending","INDUCTED",{verifiedAt:today+"T09:49:59Z"}),today),"unverified","a 15-minute-old negative history is not confirmed current pending");
assert.equal(verification.eddNextCheckAt("INDUCTED",Date.parse(today+"T10:00:00Z")),today+"T10:05:00.000Z");
assert.equal(verification.eddNextCheckAt("DELIVERED",Date.parse(today+"T10:00:00Z")),"2026-09-16T10:00:00.000Z");
const gntfLookup={packageStatus:"IN_TRANSIT",driverName:"Associate",driverId:"A2EVIYL88DSKW1",history:[
  {state:"IN_TRANSIT",time:"2026-09-10T05:14:18.783Z"},
  {state:"IN_TRANSIT",time:"2026-09-10T04:43:07.962Z"},
  {state:"INDUCTED",time:"2026-09-10T04:39:00Z"},
  {state:"INDUCTED",time:"2026-09-10T02:35:00Z"},
  {state:"MANIFESTED",time:"2026-09-03T10:33:00Z"}
]};
const gntf=verification.applyEddLookup(pkg("372261101629","INDUCTED",{ead:"2026-09-10",sourceAt:"2026-09-10T04:20:00Z"}),gntfLookup,"2026-09-10T05:15:00Z");
assert.equal(gntf.verification.firstDispatchAt,"2026-09-10T04:43:07.962Z");
assert.equal(edd.stationEddPosition(gntf,"2026-09-10"),"onRoad","live outbound scan must immediately remove the sample TID from pending");
assert.equal(edd.summarizeStationEdd("GNTF",[gntf],gntf.verifiedAt,"2026-09-10").todayAtStation,0);
assert.equal(edd.stationEddAssociates([gntf],"2026-09-10")[0].onRoad,1);
assert.equal(verification.eddVerificationFromLookup({...gntfLookup,historyComplete:false}).historyComplete,false);
const sent = [pkg("a","DELIVERED",{driverId:"A",driverName:"Associate A"}),pkg("b","IN_TRANSIT_TO_CUSTOMER",{driverId:"A"}),pkg("c","INDUCTED",{driverId:"A"}),pkg("a","DELIVERED",{driverId:"A",driverName:"Associate A"})];
assert.deepEqual(edd.stationEddAssociates(sent,today),[{id:"A",name:"Associate A",sent:2,delivered:1,onRoad:1,attempted:0,other:0}],"unique dispatched cohort, never retained station driver IDs");
assert.equal(verification.eddHistoryFacts([]).historyComplete,false);
assert.equal(verification.eddHistoryFacts([{state:"INDUCTED",time:null}]).historyComplete,false);
console.log("PASS Verified ledger rules: delivered override, HFR, same-day attempts, incomplete history, deduplicated associate counts.");
const sourceApi={};
new Function("require","exports",transpile(readFileSync(new URL("../src/lib/ops-pulse/edd-source.ts",import.meta.url),"utf8")))(()=>({}),sourceApi);
const realFetch=globalThis.fetch;
const fakeAuth={cookie:"test-session",x_api_usage_key:"test-key"};
try {
  let page=0;
  globalThis.fetch=async(url,options)=>{
    assert.equal(url,"https://www.amazonlogistics.eu/station/proxyapigateway/data");
    assert.equal(options.redirect,"manual","never forward the session through redirects");
    const body=JSON.parse(options.body);
    assert.equal(body.resourcePath,"/os/getPackageHistoryData");
    assert.equal(body.requestBody.pageToken,page===0?null:"continuation");
    return Response.json(page++===0?{packageHistory:Array.from({length:20},()=>({packageState:"INDUCTED",stateTime:1788950000000})),nextPageToken:"continuation"}:{packageHistory:[{packageState:"DELIVERY_ATTEMPTED",stateTime:1788850000000}]});
  };
  const paged=await sourceApi.eddSourceHistory("sample",fakeAuth);
  assert.equal(paged.history.length,21);
  assert.equal(paged.historyComplete,true);
  assert.ok(verification.eddHistoryFacts(paged.history).firstAttemptAt);
  globalThis.fetch=async()=>Response.json({packageHistory:Array.from({length:20},()=>({packageState:"INDUCTED",stateTime:1788950000000}))});
  assert.equal((await sourceApi.eddSourceHistory("sample",fakeAuth)).historyComplete,false,"full page without token cannot prove full history");
  globalThis.fetch=async()=>Response.json({packageSummaryList:[{trackingId:"allowed",currentPackageState:"DELIVERED"},{trackingId:"outside"}]});
  assert.deepEqual((await sourceApi.eddSourceSummaries("KTUO",["allowed"],fakeAuth)).map(r=>r.trackingId),["allowed"]);
} finally {globalThis.fetch=realFetch;}
console.log("PASS Source integration contracts: fixed origin, no redirects, paginated history, conservative completeness and requested-TID filtering.");
const pickupOnly=verification.eddHistoryFacts([{state:"IN_TRANSIT",time:"2026-09-01T12:00:00Z"},{state:"INDUCTED",time:"2026-09-09T05:00:00Z"}]);
assert.equal(pickupOnly.firstDispatchAt,null,"pickup/inbound transit before induction is not customer dispatch");
assert.equal(edd.stationEddPosition(pkg("pickup","INDUCTED",{verification:{...pickupOnly,state:"INDUCTED"}}),today),"atStation");
const actualDispatch=verification.eddHistoryFacts([{state:"IN_TRANSIT",time:"2026-08-31T12:00:00Z"},{state:"INDUCTED",time:"2026-09-04T05:00:00Z"},{state:"IN_TRANSIT",time:"2026-09-09T06:02:00Z"},{state:"DELIVERED",time:"2026-09-09T10:23:00Z"}]);
assert.equal(actualDispatch.firstDispatchAt,"2026-09-09T06:02:00.000Z","customer dispatch starts after station induction, not merchant pickup");
console.log("PASS Real-source regression: inbound transit vs customer dispatch.");
const cronScope={};
new Function("exports",transpile(readFileSync(new URL("../src/lib/ops-pulse/edd-cron-scope.ts",import.meta.url),"utf8")))(cronScope);
assert.equal(cronScope.isEddCronHost("ops.dropxlogistics.com"),true);
assert.equal(cronScope.isEddCronHost("dropx-ops-pulse-abc-dropx1.vercel.app"),true);
assert.equal(cronScope.isEddCronHost("dropx-partner-dashboard.vercel.app"),false);
assert.equal(cronScope.isEddCronHost("ops.dropxlogistics.com.example.org"),false);
assert.equal(cronScope.isEddCronHost("people.dropxlogistics.com"),false);
console.log("PASS Product isolation: EDD cron runs only on OpsPulse hosts.");

const tableControls = {};
new Function("require", "exports", transpile(readFileSync(new URL("../src/lib/ops-pulse/edd-table-controls.ts", import.meta.url), "utf8")))(name => name.includes("edd-verification") ? verification : edd, tableControls);
const selectionFor = values => tableControls.readEddControls(new URLSearchParams(values));
assert.equal(selectionFor({ sort: "bad", view: "unknown", day: "bad", size: "999" }).sort, "trackingId");
assert.equal(selectionFor({ size: "999" }).size, "50");
const controlPackages = [
  pkg("100", "DELIVERED", { driverId: "A", driverName: "Alpha", postalCode: "686691" }),
  pkg("9", "IN_TRANSIT_TO_CUSTOMER", { driverId: "A", driverName: "Alpha" }),
  pkg("8", "INDUCTED", { driverId: "A", driverName: "Alpha" }),
  pkg("7", "DELIVERY_FAILED", { driverId: "B", driverName: "Beta" }),
  pkg("6", "DELIVERED", { driverId: "B", driverName: "Beta", ead: "2026-09-08" }),
  pkg("5", "RECEIVED", { verification: { historyComplete: false } }),
  pkg("4", "INDUCTED", { ead: null }),
  pkg("3", "DELIVERED", { driverId: "C", driverName: "Gamma" }),
  pkg("2", "RECEIVED", { driverId: "B", driverName: "Beta", verification: { ...facts, state: "RECEIVED" } })
];
assert.deepEqual(tableControls.selectEddTids(controlPackages, selectionFor({ position: "all", query: "686691" }), today).map(p => p.trackingId), ["100"], "PIN search matches the displayed field");
assert.deepEqual(tableControls.selectEddTids(controlPackages, selectionFor({ position: "all", associate: "A", sentOnly: "true", direction: "desc" }), today).map(p => p.trackingId), ["100", "9"], "associate drill-down is unique sent cohort, numeric sort");
assert.equal(tableControls.selectEddTids(controlPackages, selectionFor({ position: "all", associate: "A" }), today).length, 3, "ordinary associate filter can include retained assignment at station");
assert.deepEqual(tableControls.selectEddTids(controlPackages, selectionFor({ position: "all", state: "RECEIVED", history: "incomplete" }), today).map(p => p.trackingId), ["5"]);
for (const direction of ["asc", "desc"]) assert.equal(tableControls.selectEddTids(controlPackages, selectionFor({ day: "all", position: "all", sort: "edd", direction }), today).at(-1).trackingId, "4", "undated rows sort last in both directions");
assert.deepEqual(tableControls.selectEddAssociates(controlPackages, selectionFor({ focus: "outstanding", associateSort: "name", associateDirection: "asc" }), today).map(a => a.id), ["A", "B"]);
assert.deepEqual(tableControls.selectEddAssociates(controlPackages, selectionFor({ focus: "complete" }), today).map(a => a.id), ["C"]);
assert.deepEqual(tableControls.selectEddAssociates(controlPackages, selectionFor({ day: "overdue", associateQuery: "beta" }), today).map(a => [a.id, a.sent, a.delivered]), [["B", 1, 1]]);
assert.equal(tableControls.selectEddAssociates(controlPackages, selectionFor({ day: "pending", associateQuery: "Beta" }), today)[0].sent, 2, "previous-day HFR excluded even from broader associate periods");
const testSummary = edd.summarizeStationEdd("KTUO", controlPackages, today + "T10:00:00Z", today);
assert.deepEqual(tableControls.selectEddStatuses(testSummary.statuses, selectionFor({ day: "pending", statusQuery: "DELIVERED" })).map(s => [s.state, s.count]), [["DELIVERED", 3]]);
const sampleStations = [testSummary, { ...testSummary, stationCode: "AWEZ", todayAtStation: 0, fetchedAt: "2026-09-08T10:00:00Z" }];
const stationNames = new Map([["KTUO", "Kothamangalam"], ["AWEZ", "Kalady"]]);
assert.deepEqual(tableControls.selectEddStations(sampleStations, stationNames, tableControls.readNetworkControls(new URLSearchParams({ query: "Kotham", focus: "pending" })), new Date(today + "T11:00:00Z")).map(r => r.stationCode), ["KTUO"]);
assert.deepEqual(tableControls.selectEddStations(sampleStations, stationNames, tableControls.readNetworkControls(new URLSearchParams({ freshness: "older" })), new Date(today + "T11:00:00Z")).map(r => r.stationCode), ["AWEZ"]);
const beforeOrder = controlPackages.map(p => p.trackingId);
tableControls.selectEddTids(controlPackages, selectionFor({ position: "all", sort: "associate" }), today);
assert.deepEqual(controlPackages.map(p => p.trackingId), beforeOrder, "sorting never mutates input");
console.log("PASS EDD table controls: combined filters, all periods, numeric sorting, missing values, HFR exclusion, station workload/freshness and immutable inputs.");

const routeRequire = createRequire(import.meta.url);
const reportModule = {};
let denied = false;
const reportMocks = {
  "@/lib/ops-pulse/station-edd-access": { stationEddApiContext: async () => denied ? new Response("Forbidden", { status: 403 }) : { companyId: "test", authorization: { locationScopeIds: ["KTUO"], hasAllLocationAccess: false } }, isStationEddApiDenied: context => context instanceof Response },
  "@/lib/ops-pulse/edd-stations": { loadEddStations: async () => [{ code: "KTUO", name: "Kothamangalam" }] },
  "@/lib/ops-pulse/station-edd": { ...edd, stationEddToday: () => today },
  "@/lib/ops-pulse/edd-table-controls": tableControls,
  "@/lib/ops-pulse/edd-ledger": { loadVerifiedEddStation: async () => ({ status: "ok", payload: { stationCode: "KTUO", fetchedAt: today + "T10:00:00Z", packages: controlPackages } }) },
  "@/lib/report-workbook": workbookModule
};
new Function("require", "exports", transpile(readFileSync(new URL("../src/app/api/ops-pulse/station-edd/report/route.ts", import.meta.url), "utf8")))(name => reportMocks[name] || routeRequire(name), reportModule);
async function readReport(query) {
  const response = await reportModule.GET(new Request("https://example.test/api?stationCode=KTUO&" + new URLSearchParams(query)));
  assert.equal(response.status, 200);
  return XLSX.read(Buffer.from(await response.arrayBuffer()), { type: "buffer" });
}
const filteredBook = await readReport({ report: "filtered", position: "all", associate: "A", sentOnly: "true", direction: "desc" });
assert.deepEqual(XLSX.utils.sheet_to_json(filteredBook.Sheets["Tracking IDs"]).map(row => row["Tracking ID"]), ["100", "9"]);
const associateBook = await readReport({ report: "associates", day: "pending", associateQuery: "Beta" });
assert.deepEqual(XLSX.utils.sheet_to_json(associateBook.Sheets.Associates).map(row => [row.Associate, row.Sent]), [["Beta", 2]]);
const statusBook = await readReport({ report: "statuses", day: "pending", statusQuery: "DELIVERED" });
assert.deepEqual(XLSX.utils.sheet_to_json(statusBook.Sheets["Source Statuses"]).map(row => [row["Source Status"], row["Selected Period"]]), [["DELIVERED", 3]]);
assert.equal((await reportModule.GET(new Request("https://example.test/api?stationCode=OUTSIDE&report=associates"))).status, 403);
denied = true;
assert.equal((await reportModule.GET(new Request("https://example.test/api?stationCode=KTUO&report=filtered"))).status, 403);
console.log("PASS EDD report endpoints: same filtered/sorted rows as UI, all matching rows exported, associate/status workbooks, authorization preserved.");
denied = false;
const networkReportModule = {};
const networkReportMocks = {
  ...reportMocks,
  "@/lib/ops-pulse/edd-verification": verification,
  "@/lib/ops-pulse/edd-stations": { loadEddStations: async () => [{ code: "KTUO", name: "Kothamangalam" }, { code: "AWEZ", name: "Kalady" }] },
  "@/lib/ops-pulse/station-edd-data": { loadStationEddNetwork: async (codes, callback) => {
    assert.ok(codes.every(code => ["KTUO", "AWEZ"].includes(code)), "report loader gets only authorized station codes");
    for (const code of codes) callback?.(code, controlPackages, today + "T10:00:00Z", today);
    return sampleStations.filter(row => codes.includes(row.stationCode));
  } }
};
new Function("require", "exports", transpile(readFileSync(new URL("../src/app/api/ops-pulse/station-edd/network/report/route.ts", import.meta.url), "utf8")))(name => networkReportMocks[name] || routeRequire(name), networkReportModule);
const networkFilteredResponse = await networkReportModule.GET(new Request("https://example.test/api?report=pending&day=today&query=Kotham&focus=pending"));
assert.equal(networkFilteredResponse.status, 200);
const networkFilteredBook = XLSX.read(Buffer.from(await networkFilteredResponse.arrayBuffer()), { type: "buffer" });
assert.deepEqual(XLSX.utils.sheet_to_json(networkFilteredBook.Sheets["Station EDD"]).map(r => r["Station Code"]), ["KTUO"]);
assert.ok(XLSX.utils.sheet_to_json(networkFilteredBook.Sheets["Pending TIDs"]).every(r => r["Station Code"] === "KTUO"));
assert.equal(XLSX.utils.sheet_to_json(networkFilteredBook.Sheets["Pending TIDs"]).length, testSummary.todayAtStation);
const selectedStatusResponse = await networkReportModule.GET(new Request("https://example.test/api?report=statuses&day=today&stations=KTUO,AWEZ&statuses=INDUCTED,DELIVERED"));
assert.equal(selectedStatusResponse.status,200);
const selectedStatusBook = XLSX.read(Buffer.from(await selectedStatusResponse.arrayBuffer()), {type:"buffer"});
const selectedStatusRows = XLSX.utils.sheet_to_json(selectedStatusBook.Sheets["Selected status TIDs"]);
assert.ok(selectedStatusRows.length>0);
assert.ok(selectedStatusRows.every(row => ["INDUCTED","DELIVERED"].includes(row["Raw Status"])));
assert.equal(new Set(selectedStatusRows.map(row=>row["Station Code"])).size,2,"multiple selected stations share one workbook");
assert.equal((await networkReportModule.GET(new Request("https://example.test/api?report=statuses&stations=NOT_ALLOWED"))).status,403);
const singleStatusResponse=await networkReportModule.GET(new Request("https://example.test/api?report=statuses&day=today&stations=KTUO&statuses=INDUCTED"));
const singleStatusBook=XLSX.read(Buffer.from(await singleStatusResponse.arrayBuffer()),{type:"buffer"});
assert.ok(XLSX.utils.sheet_to_json(singleStatusBook.Sheets["Selected status TIDs"]).every(row=>row["Station Code"]==="KTUO"));
denied = true;
assert.equal((await networkReportModule.GET(new Request("https://example.test/api?report=pending"))).status, 403);
console.log("PASS Network export: station search/workload filters apply to summaries and TID sheets without expanding access.");

// Execute polling lifecycle with controlled effects, rather than sleeping in tests.
const hookEffects=[]; const windowEvents=new Map(); const documentEvents=new Map(); let tick; let cleared=false;
const fakeDocument={visibilityState:"visible",addEventListener:(key,fn)=>documentEvents.set(key,fn),removeEventListener:(key)=>documentEvents.delete(key)};
const fakeWindow={setInterval:(fn,delay)=>{assert.equal(delay,60000);tick=fn;return 1;},clearInterval:()=>{cleared=true;},addEventListener:(key,fn)=>windowEvents.set(key,fn),removeEventListener:(key)=>windowEvents.delete(key)};
const autoRefresh={};
new Function("require","exports","window","document",transpile(readFileSync(new URL("../src/app/ops-pulse/station-edd/use-edd-auto-refresh.ts",import.meta.url),"utf8")))(()=>({useRef:value=>({current:value}),useEffect:fn=>hookEffects.push(fn)}),autoRefresh,fakeWindow,fakeDocument);
let reads=0; let resolveRead;
autoRefresh.useEddAutoRefresh(()=>{reads++;return new Promise(resolve=>{resolveRead=resolve;});});
const cleanups=hookEffects.map(fn=>fn());
tick(); windowEvents.get("focus")(); assert.equal(reads,1,"timer and focus do not overlap reads");
resolveRead(); await Promise.resolve(); fakeDocument.visibilityState="hidden"; tick(); assert.equal(reads,1);
fakeDocument.visibilityState="visible"; documentEvents.get("visibilitychange")(); assert.equal(reads,2,"returning to a tab reads latest data");
resolveRead(); await Promise.resolve(); cleanups.forEach(fn=>fn?.()); assert.equal(cleared,true); assert.equal(windowEvents.size,0); assert.equal(documentEvents.size,0);
console.log("PASS GNTF outbound regression, pending evidence expiry, five-minute rechecks, live lookup reconciliation and auto-refresh lifecycle.");
