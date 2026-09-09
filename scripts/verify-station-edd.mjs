import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import * as XLSX from "xlsx";

const source = readFileSync(new URL("../src/lib/ops-pulse/station-edd.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const edd = await import("data:text/javascript;base64," + Buffer.from(compiled).toString("base64"));
const today = "2026-09-09";
const pkg = (trackingId, state, values = {}) => ({ trackingId, state, ead: today, bucket: "future", packageType: "Delivery", driverId: "", ...values });
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
assert.equal(summary.todayOther, 3, "failed/delivered/manifested must not masquerade as station stock");
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
assert.deepEqual(parsed.SheetNames, ["Summary", "Source Statuses", "At Station EDD Today", "Overdue At Station", "All Snapshot TIDs"]);
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
const mockDb = { from: table => {
  assert.equal(table, "edd_station_snapshots");
  return { select: () => ({ in: async (field, codes) => {
    assert.equal(field, "station_code"); requests.push(codes);
    return { data: snapshots.filter(s => codes.includes(s.station_code)), error: null };
  } }) };
} };
const loader = {};
new Function("require", "exports", loaderJs)(name => name === "server-only" ? {} : name.includes("supabase-admin") ? { supabaseAdmin: mockDb } : edd, loader);
const seen = [];
const scoped = await loader.loadStationEddNetwork(["AWEZ", "MISSING", "AWEZ"], code => seen.push(code));
assert.deepEqual(requests, [["AWEZ", "MISSING"]]);
assert.deepEqual(scoped.map(s => s.stationCode), ["AWEZ", "MISSING"]);
assert.deepEqual(seen, ["AWEZ"], "export callback must not see ERSE outside requested scope");
assert.equal(scoped[1].hasSnapshot, false);
console.log(`PASS All-location pending export: 30000 TIDs across 38 stations, ${networkBytes.length} bytes; scope and missing snapshots verified.`);
console.log("PASS Station EDD behavioral tests: statuses, dates, retained IDs, reverse shipments, duplicates, missing/stale data, and XLSX round-trip.");
