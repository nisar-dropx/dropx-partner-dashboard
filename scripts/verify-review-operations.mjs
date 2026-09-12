import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
const require = createRequire(import.meta.url);
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const moduleFrom = (path, dependencies = {}) => {
  const exports = {};
  new Function("require", "exports", ts.transpileModule(read(path), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)
    (name => dependencies[name] ?? require(name), exports);
  return exports;
};
const logic = moduleFrom("src/lib/ops-pulse/review-operations.ts");
const cohort = moduleFrom("src/lib/ops-pulse/review-edd-cohort.ts", {
  "./edd-verification": { eddDeliveredState: state => ["DELIVERED","CASH_AT_STATION","CASH_IN_ASSOCIATE"].includes(state), eddCurrentState: pkg => pkg.state === "DELIVERED" || pkg.verification?.state === "DELIVERED" ? "DELIVERED" : pkg.state }
});
const day = "2026-09-09", time = clock => `${day}T${clock}:00+05:30`;
const point = (clock, counts = {}, fields = {}) => ({ observedAt: time(clock), sourceAt: time(clock), backlogAt: time(clock), performanceAt: time(clock), counts: {
  todayTotal: 100, todayAtStation: 0, todayOnRoad: 40, todayDelivered: 60, todayHfr: 0, todayAttempted: 0,
  todayUnverified: 0, todayOther: 0, missingDate: 0, hasSnapshot: true,
  routeDispatched: 100, routeAtStation: 10, routeOutOnRoad: 40, routeDelivered: 55, routeReturned: 5, routeHasSnapshot: true, ...counts
}, ...fields });
let timeline = logic.buildReviewEddTimeline(day, [], new Date(time("22:00")));
assert.equal(timeline.summary, "History not recorded");
assert.equal(timeline.dayStart, null);
assert.equal(timeline.rows.length, 37);
assert.equal(timeline.rows[0].label, "06:00");
assert.equal(timeline.rows[36].label, "EOD");
assert.equal(timeline.rows[36].state, "Upcoming");
const morning = point("06:01", { todayAtStation: 100 });
const pending = point("06:31", { todayAtStation: 30, todayTotal: 120 });
timeline = logic.buildReviewEddTimeline(day, [pending, morning], new Date(time("06:35")));
assert.equal(timeline.summary, "Not cleared · 30 pending");
assert.equal(timeline.dayStart, 100);
assert.ok(timeline.rows.every(row => row.dayStart === 100), "day-start denominator stays constant despite later arrivals");
assert.equal(timeline.rows[1].point.counts.todayTotal, 120);
assert.equal(timeline.rows[2].state, "Upcoming");
assert.equal(logic.buildReviewEddTimeline(day, [point("14:00")], new Date(time("14:02"))).dayStart, null);
const run = [point("10:00", { todayAtStation: 1 }), point("10:05"), point("10:10")];
assert.equal(logic.buildReviewEddTimeline(day, run, new Date(time("10:12"))).clearedAt, time("10:05"));
run.push(point("10:15", { todayAtStation: 2 }), point("10:20"));
assert.equal(logic.buildReviewEddTimeline(day, run, new Date(time("10:21"))).clearedAt, time("10:20"), "later pending resets clearance");
assert.equal(logic.buildReviewEddTimeline(day, [point("10:00"), point("11:00")], new Date(time("11:01"))).clearedAt, time("11:00"), "capture gaps reset clear streak");
for (const counts of [{ todayUnverified: 3 }, { missingDate: 1 }, { todayOther: 1 }, { hasSnapshot: false }, { todayTotal: 0 }]) {
  assert.equal(logic.buildReviewEddTimeline(day, [point("10:00", counts)], new Date(time("10:01"))).clearedAt, null);
}
assert.equal(logic.buildReviewEddTimeline(day, [point("10:00", {}, { backlogAt: time("06:00") })], new Date(time("10:01"))).clearedAt, null, "fresh one-TID lookup cannot make stale stock clear");
assert.equal(logic.buildReviewEddTimeline(day, [point("10:00", {}, { backlogAt: time("06:00") })], new Date(time("10:01"))).summary, "Source stale", "stale source numbers are not presented as current EDD");
assert.equal(logic.buildReviewEddTimeline(day, [point("10:00")], new Date(time("11:00"))).clearedAt, null);
assert.equal(logic.buildReviewEddTimeline(day, [point("23:55")], new Date("2026-09-10T12:00:00+05:30")).clearedAt, time("23:55"), "past reviews evaluate against their own EOD, not now");
assert.equal(logic.buildReviewEddTimeline(day, [point("15:00")], new Date("2026-09-10T12:00:00+05:30")).clearedAt, null, "afternoon sample cannot certify EOD");
assert.equal(logic.buildReviewEddTimeline(day, [morning], new Date(time("10:00"))).rows[2].point, null, "do not carry forward across missing checkpoints");
assert.equal(logic.buildReviewEddTimeline(day, [point("12:00")], new Date(time("11:00"))).latest, null, "future observations are excluded");
assert.deepEqual(logic.normalizeReviewRouteCounts({workDate:day,assigned:100,delivered:55,returned:5,held:40,yetToDispatch:10},day), {
  routeDispatched:100,routeAtStation:10,routeOutOnRoad:40,routeDelivered:55,routeReturned:5,routeHasSnapshot:true
});
assert.equal(logic.normalizeReviewRouteCounts({workDate:day,assigned:101,delivered:55,returned:5,held:40,yetToDispatch:10},day).routeHasSnapshot,false,"non-reconciling route totals are rejected");
assert.equal(logic.normalizeReviewRouteCounts({workDate:"2026-09-08",assigned:100,delivered:55,returned:5,held:40,yetToDispatch:10},day).routeHasSnapshot,false,"another day's route total is rejected");
timeline = logic.buildReviewEddTimeline(day,[point("10:00")],new Date(time("10:02")));
assert.equal(timeline.rows[8].routeState,"Recorded");
assert.equal(timeline.routeLatest.routeDispatched,100);
const finalRoute={...logic.normalizeReviewRouteCounts({workDate:day,assigned:120,delivered:110,returned:5,held:5,yetToDispatch:0},day),observedAt:time("23:55"),source:"daily"};
timeline=logic.buildReviewEddTimeline(day,[],new Date("2026-09-10T12:00:00+05:30"),finalRoute);
assert.equal(timeline.routeLatest.routeDelivered,110,"past reviews expose the authoritative final route snapshot without inventing half-hour values");
assert.equal(timeline.routeFinal.source,"daily");

const person = (id, values = {}, fields = {}) => ({ id, workerType: "employee", name: `Person ${id}`, code: id, designation: "Team Lead", availability: "Completed",
  today: { rosterDayType: "working", shiftStartTime: "06:00", shiftEndTime: "15:00", shiftName: "Morning", reported: true,
    inTime: time("06:00"), outTime: time("15:00"), workMinutes: 510, lateMinutes: 0, ...values }, ...fields });
const people = [person("1"), person("2"), person("3", { lateMinutes: 20 }), person("4", { reported: false, inTime: null, outTime: null }),
  person("5", { shiftStartTime: null }), person("6", {}, { availability: "On leave" }), person("7", { rosterDayType: "weekly_off" }), person("1")];
let d = logic.buildUtrDiscipline(people);
assert.deepEqual([d.onTime, d.scheduled, d.late, d.notReported, d.noShift, d.excluded], [2, 4, 1, 1, 1, 2]);
assert.equal(d.rows.length, 7, "staff deduplicated by profile and worker ID");
assert.equal(logic.buildUtrDiscipline([person("1", { outTime: null })]).rows[0].workMinutes, null);
assert.equal(logic.buildUtrDiscipline([person("1", { workMinutesRecorded: false })]).rows[0].workMinutes, null);

// Server reads bind both company and station/date. A failed read stays a gap.
let requests = [], fail = false;
const db = { from(table) { const query = { select() { return query; }, eq(key,value) { requests.push([table,key,value]); return query; }, order() { return query; },
  limit() { return Promise.resolve({data: [], error: fail ? {message:"failure"} : null}); },
  maybeSingle() { return Promise.resolve({data: table === "edd_performance_daily" ? {date:day,assigned:100,delivered:55,returned:5,held:40,yet_to_dispatch:10,updated_at:time("23:55")} : null,error:fail?{message:"failure"}:null}); }
}; return query; } };
const data = moduleFrom("src/lib/ops-pulse/review-operations-data.ts", { "server-only": {}, "@/lib/supabase-admin": {supabaseAdmin: db},
  "./edd-ledger": {}, "./edd-worker": {}, "./edd-movement": {}, "./review-edd-cohort": cohort, "./station-edd": {stationEddToday:()=>"2026-09-12"}, "./station-manpower": {}, "./station-opening-punches": {}, "./review-operations": logic });
const loaded = await data.loadReviewEddHistory("company-one", "station-one", "GNTF", day);
assert.deepEqual(requests, [["ops_review_edd_observations","company_id","company-one"],["ops_review_edd_observations","station_id","station-one"],["ops_review_edd_observations","work_date",day],["edd_performance_daily","station_code","GNTF"],["edd_performance_daily","date",day]]);
assert.equal(loaded.timeline.routeLatest.routeDispatched,100);
fail = true;
assert.ok((await data.loadReviewEddHistory("company-one","station-one","GNTF",day)).error);

const captureEvents = [], capturedRows = [];
const captureDb = { from(table) {
  if (table === "edd_station_snapshots") return { select: async () => ({ data: [{station_code:"GNTF",fetched_at:time("12:51")}], error:null }) };
  if (table === "edd_performance_snapshots") return { select: async () => ({ data: [{station_code:"GNTF",window_from:day,window_to:day,fetched_at:time("21:08"),assigned:100,delivered:55,returned:5,held:40,yet_to_dispatch:10}], error:null }) };
  if (table === "stations") return { select() { return { in: async () => ({data:[{id:"station-one",company_id:"company-one",station_code:"GNTF"}],error:null}) }; } };
  if (table === "ops_review_edd_observations") return { upsert: async rows => { capturedRows.push(...rows); return {error:null}; } };
  throw new Error(`Unexpected capture table ${table}`);
} };
const captureData = moduleFrom("src/lib/ops-pulse/review-operations-data.ts", { "server-only": {}, "@/lib/supabase-admin": {supabaseAdmin:captureDb},
  "./edd-ledger": { loadEddLedger: async codes => { captureEvents.push(`load:${codes.join(",")}`); return new Map([["GNTF",{packages:[],fetchedAt:time("12:51")}]]); } },
  "./review-edd-cohort": cohort,
  "./edd-movement": { captureEddMovement: () => ({ movement: { total:0 }, details: [] }) },
  "./edd-worker": {
    fetchEddStation: async ({stationCode}) => { captureEvents.push(`worker:${stationCode}`); return {status:"ok",payload:{stationCode,fetchedAt:time("21:06"),packages:[]}}; },
    fetchEddPerformanceStation: async ({stationCode}) => ({status:"ok",payload:{stationCode,window:{from:day,to:day},fetchedAt:time("21:07"),assigned:200,delivered:155,returned:5,held:40,yetToDispatch:10,packages:[]}})
  },
  "./station-edd": { stationEddToday: () => day, summarizeStationEdd: (_code,_packages,fetchedAt) => { captureEvents.push(`summary:${fetchedAt}`); return {todayTotal:0,todayAtStation:0,todayOnRoad:0,todayDelivered:0,todayHfr:0,todayAttempted:0,todayUnverified:0,todayOther:0,missingDate:0,hasSnapshot:true}; } },
  "./station-manpower": {}, "./station-opening-punches": {}, "./review-operations": logic });
assert.equal((await captureData.captureReviewEddHistory()).captured,1);
assert.deepEqual(captureEvents,["load:GNTF","worker:GNTF","summary:2026-09-09T21:06:00+05:30"],"review capture reads the live worker snapshot instead of the stale application copy");
assert.equal(capturedRows[0].backlog_at,time("21:06"));
assert.equal(capturedRows[0].source_at,time("21:06"));
assert.equal(capturedRows[0].counts.routeDispatched,200,"live worker outcomes win over the older application copy");
assert.equal(capturedRows[0].performance_at,time("21:07"));
assert.equal(capturedRows[0].counts.captureVersion,5);
assert.equal(capturedRows[0].counts.packageDetailsRecorded,true);
assert.deepEqual(capturedRows[0].package_details,[],"counts and checkpoint membership are saved in the same atomic insert");
assert.equal(capturedRows[0].counts.captureEveryMinutes,15);

const quarter = clock => point(clock,{captureEveryMinutes:15,sourceMaxAgeMinutes:35});
assert.equal(logic.buildReviewEddTimeline(day,[quarter("10:00"),quarter("10:15")],new Date(time("10:29"))).clearedAt,time("10:00"),"15-minute cadence is not a missing-capture gap");
assert.equal(logic.buildReviewEddTimeline(day,[quarter("10:00")],new Date(time("10:25"))).latestFresh,false);
const ageing = quarter("10:15"); ageing.backlogAt=time("09:45");
assert.equal(logic.buildReviewEddTimeline(day,[ageing],new Date(time("10:25"))).latestFresh,false,"source freshness is checked against now, not just capture time");
assert.equal(logic.buildReviewEddTimeline(day,[quarter("10:00"),point("10:15",{hasSnapshot:false})],new Date(time("10:16"))).lastConfirmed.observedAt,time("10:00"),"last usable observation survives a failed read without filling missing checkpoints");

let captures = 0;
const route = moduleFrom("src/app/api/cron/edd-review-history/route.ts", {
  "@/lib/ops-pulse/review-operations-data": { captureReviewEddHistory: async () => { captures++; return {captured:38}; } },
  "@/lib/ops-pulse/edd-cron-scope": moduleFrom("src/lib/ops-pulse/edd-cron-scope.ts")
});
const savedSecret = process.env.CRON_SECRET;
process.env.CRON_SECRET = "test-only-secret";
assert.equal((await route.GET(new Request("https://ops.dropxlogistics.com/api/cron/edd-review-history"))).status, 401);
await route.GET(new Request("https://people.dropxlogistics.com/api/cron/edd-review-history", {headers:{authorization:"Bearer test-only-secret"}}));
assert.equal(captures, 0);
assert.equal((await route.GET(new Request("https://ops.dropxlogistics.com/api/cron/edd-review-history", {headers:{authorization:"Bearer test-only-secret"}}))).status, 200);
assert.equal(captures, 1);

let refreshes = 0;
const stockRoute = moduleFrom("src/app/api/cron/edd-stock-refresh/route.ts", {
  "@/lib/ops-pulse/review-source-refresh": { refreshReviewSources: async () => { refreshes++; return { refreshed:8, attempted:8, failedSources:[] }; } },
  "@/lib/ops-pulse/edd-cron-scope": moduleFrom("src/lib/ops-pulse/edd-cron-scope.ts")
});
assert.equal((await stockRoute.GET(new Request("https://ops.dropxlogistics.com/api/cron/edd-stock-refresh"))).status, 401);
await stockRoute.GET(new Request("https://people.dropxlogistics.com/api/cron/edd-stock-refresh", {headers:{authorization:"Bearer test-only-secret"}}));
assert.equal(refreshes, 0, "other products cannot start the EDD stock sweep");
assert.equal((await stockRoute.GET(new Request("https://ops.dropxlogistics.com/api/cron/edd-stock-refresh", {headers:{authorization:"Bearer test-only-secret"}}))).status, 200);
assert.equal(refreshes, 1, "OpsPulse cron starts or observes the idempotent EDD stock sweep");
if (savedSecret == null) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = savedSecret;
const ui = read("src/components/performance-review-operations.tsx"), css = read("src/app/ops-pulse/performance/review-desk.css");
assert.equal((ui.match(/name="performance-review-fact"/g) ?? []).length, 2);
assert.ok(!ui.includes('role="dialog"') && !ui.includes("window.open"), "inline cards, no new window");
assert.ok(css.includes("max-height: 300px; overflow: auto") && css.includes("position: sticky"));
console.log("PASS Review operations: clearance/reopening, IST EOD, fixed baseline, route reconciliation, gaps, UTR ratios, private station/date reads, EDD cron authorization and compact panels.");
