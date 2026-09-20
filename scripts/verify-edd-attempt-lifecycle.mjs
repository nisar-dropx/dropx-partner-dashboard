import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const exports = {};
const source = readFileSync(new URL("../src/lib/ops-pulse/edd-verification.ts", import.meta.url), "utf8");
class Clock extends Date { static now(){return Date.parse("2026-09-12T14:05:00Z");} }
const compile = value => ts.transpileModule(value,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
new Function("exports", "Date", ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
} }).outputText)(exports,Clock);
const { eddHistoryFacts: facts, eddAttemptLifecycle: lifecycle } = exports;
const event = (state,time) => ({state,time,reasonCode:null,source:null,destination:null,scanBy:null});
const one = [
  event("MANIFESTED","2026-09-10T01:00:00Z"),
  event("IN_TRANSIT","2026-09-10T02:00:00Z"), // inbound, not an attempt
  event("INDUCTED","2026-09-11T01:00:00Z"),
  event("IN_TRANSIT","2026-09-11T02:00:00Z"),
  event("DELIVERY_FAILED","2026-09-11T10:00:00Z"),
  event("DELIVERY_FAILED","2026-09-11T10:00:00Z"), // duplicate scan
  event("DELIVERY_ATTEMPTED","2026-09-11T10:00:00Z"), // same visit, different event label
  event("RECEIVED","2026-09-11T12:00:00Z")
];
const pkg = (state, history, overrides={}) => ({state,verifiedAt:"2026-09-12T14:00:00Z",verification:{state,...facts(history),...overrides}});
assert.equal(lifecycle(pkg("RECEIVED",one)).category,"hfr");
assert.equal(lifecycle(pkg("RECEIVED",one)).observedAttempts,1);
assert.equal(lifecycle(pkg("RECEIVED",one)).atStation,true,"returned physical stock is separate from fresh pending");
assert.equal(facts(one).firstDispatchAt,"2026-09-11T02:00:00.000Z");

const two = [...one,
  event("INDUCTED","2026-09-12T01:00:00Z"),
  event("IN_TRANSIT","2026-09-12T02:00:00Z"),
  event("DELIVERY_ATTEMPTED","2026-09-12T09:00:00Z"),
  event("RECEIVED","2026-09-12T12:00:00Z")
];
const hcr=lifecycle(pkg("RECEIVED",two));
assert.equal(hcr.category,"hcr");
assert.equal(hcr.observedAttempts,2);
assert.equal(hcr.secondAttemptAt,"2026-09-12T09:00:00.000Z");
assert.equal(hcr.returnedAt,"2026-09-12T12:00:00.000Z");
assert.deepEqual(facts([...two].reverse()).attemptTimes,facts(two).attemptTimes,"source history is newest-first");
assert.equal(lifecycle(pkg("RECEIVED",two,{historyComplete:false})).category,"hcr","two positively observed cycles establish a lower bound of two");

// Real source shape: oldest available scan is UNKNOWN, followed by a failed
// visit, station receipt, another day's outbound scans, and a second failure.
const noInduction = [event("UNKNOWN","2026-09-10T03:37:00Z"),
  event("DELIVERY_FAILED","2026-09-10T13:28:00Z"),
  event("RECEIVED","2026-09-10T13:29:00Z"),
  event("RECEIVED","2026-09-11T03:56:00Z"),
  event("IN_TRANSIT","2026-09-11T04:10:00Z"),
  event("IN_TRANSIT","2026-09-11T04:21:00Z"),
  event("DELIVERY_FAILED","2026-09-11T16:54:00Z"),
  event("RECEIVED","2026-09-11T17:05:00Z")];
assert.equal(lifecycle(pkg("RECEIVED",noInduction)).category,"hcr","return then redispatch establishes a second cycle without the original induction");
assert.equal(facts(noInduction).attemptTimes.length,2);
assert.equal(facts(noInduction).returnedAfterAttemptAt,"2026-09-11T17:05:00.000Z");
assert.equal(facts([event("UNKNOWN","2026-09-10T03:37:00Z"),event("IN_TRANSIT","2026-09-10T04:10:00Z")]).firstDispatchAt,null,"unanchored transit still cannot prove customer dispatch");

for(const state of ["REJECTED","DELIVERY_REJECTED"]) {
  assert.equal(lifecycle(pkg(state,[...two,event(state,"2026-09-12T13:00:00Z")])).category,"rejected");
  assert.equal(facts([event(state,"2026-09-12T13:00:00Z")]).firstAttemptAt,null,"rejections do not become HFR attempts");
}
assert.equal(lifecycle(pkg("RECEIVED",[...two,event("REJECTED","2026-09-12T13:00:00Z")])).category,"rejected","re-receiving a rejected parcel does not turn it into HFR");
for(const state of ["DELIVERED","CASH_IN_ASSOCIATE","CASH_AT_STATION"]) {
  assert.equal(lifecycle(pkg(state,[...two,event("DELIVERED","2026-09-12T13:00:00Z"),event(state,"2026-09-12T13:00:00Z")])).category,"none","completed deliveries are no longer active HFR/HCR");
}
assert.equal(lifecycle(pkg("IN_TRANSIT_DS_TO_FC",two)).category,"returningToFc");
assert.equal(lifecycle(pkg("RECEIVED",one,{historyComplete:false})).category,"unknown","partial history cannot prove exactly one attempt");
assert.equal(lifecycle({state:"RECEIVED",verification:{rulesVersion:2,historyComplete:true,firstAttemptAt:"2026-09-11T10:00:00Z"}}).category,"unknown","old first-attempt-only facts cannot establish HFR versus HCR");
const ambiguous=facts([...one,event("DELIVERY_FAILED","2026-09-12T09:00:00Z")]);
assert.equal(ambiguous.attemptTimes.length,1);
assert.equal(ambiguous.attemptCountComplete,false,"no second outbound cycle means an ambiguous additional outcome, not a confirmed second visit");
assert.equal(lifecycle(pkg("DELIVERY_FAILED",[],{historyComplete:false})).category,"unknown");
const reasonRejected = [...one,{...event("DELIVERY_FAILED","2026-09-12T13:00:00Z"),reasonCode:"CUSTOMER_REJECTED"}];
assert.equal(lifecycle(pkg("RECEIVED",reasonRejected)).category,"rejected");
const merged=exports.mergeEddVerification(pkg("RECEIVED",two).verification,pkg("INDUCTED",[],{historyComplete:false}).verification);
assert.equal(merged.attemptTimes.length,2,"partial read must retain two positively established attempts");
assert.equal(merged.historyComplete,false,"partial read cannot certify fresh pending");
const station={};
new Function("require","exports","Date",compile(readFileSync(new URL("../src/lib/ops-pulse/station-edd.ts",import.meta.url),"utf8")))(()=>exports,station,Clock);
for(const state of ["CASH_AT_STATION","CASH_IN_ASSOCIATE","DELIVERED"]){
  assert.equal(station.stationEddPosition(pkg(state,two),"2026-09-12"),"delivered","cash status is a delivery outcome, even with older attempts");
}
assert.equal(station.stationEddPosition(pkg("RECEIVED",two),"2026-09-12"),"hcr");
assert.equal(station.stationEddPosition(pkg("RECEIVED",reasonRejected),"2026-09-12"),"rejected");
assert.equal(station.stationEddPosition({...pkg("INDUCTED",[]),observedStationCode:"A",verification:{...pkg("INDUCTED",[]).verification,routeStationCode:"B"}},"2026-09-12"),"unverified","route mismatch never silently moves a parcel or certifies station pending");
const noAttempts={state:"INDUCTED",ead:"2026-09-12",verifiedAt:"2026-09-12T14:00:00Z",sourceAt:"2026-09-12T14:04:30Z",summaryCheckedAt:"2026-09-12T14:04:00Z",stateUpdatedAt:"2026-09-12T13:59:00Z",verification:{state:"INDUCTED",rulesVersion:3,historyComplete:true,latestEventAt:"2026-09-12T13:59:00Z",firstDispatchAt:null,firstAttemptAt:null}};
assert.equal(station.stationEddPosition(noAttempts,"2026-09-12"),"atStation","unchanged per-package event can reuse complete history across a batch refresh");
assert.equal(station.stationEddPosition({...noAttempts,stateUpdatedAt:"2026-09-12T14:03:00Z"},"2026-09-12"),"unverified","new event must invalidate negative history");
assert.equal(station.stationEddPosition({...noAttempts,stateUpdatedAt:null},"2026-09-12"),"unverified","same label alone cannot prove no intervening attempt");
assert.equal(exports.eddPendingEvidenceFresh(noAttempts,Date.parse("2026-09-12T14:20:00Z")),false,"unchanged evidence still expires");
assert.equal(exports.eddCanReuseHistory(noAttempts),true);
for(const change of [{stateUpdatedAt:""},{state:"RECEIVED"},{summaryCheckedAt:"2026-09-12T14:06:00Z"},{verification:{...noAttempts.verification,rulesVersion:2}},{verification:{...noAttempts.verification,historyComplete:false}}])
  assert.equal(exports.eddCanReuseHistory({...noAttempts,...change}),false,"missing, changed, future or incomplete evidence never skips history");
const summary=station.summarizeStationEdd("A",[{...noAttempts,trackingId:"1"},{...noAttempts,trackingId:"2",verification:null}],noAttempts.sourceAt,"2026-09-12");
assert.equal(summary.todayObservedAtStation,2);
assert.equal(summary.todayAtStation,1);
assert.equal(summary.todayUnverified,1);
const cohort={};
new Function("require","exports",compile(readFileSync(new URL("../src/lib/ops-pulse/review-edd-cohort.ts",import.meta.url),"utf8")))(()=>exports,cohort);
const cash={...noAttempts,trackingId:"cash",state:"CASH_AT_STATION",verification:null};
const afterMissing=cohort.mergeReviewEddCohort([cash],{stationCode:"A",fetchedAt:"2026-09-12T14:05:00Z",packages:[]},null);
assert.equal(station.stationEddPosition(afterMissing[0],"2026-09-12"),"delivered","absence from active stock must not withdraw cash-delivery outcome");
const controls={};
new Function("require","exports",compile(readFileSync(new URL("../src/lib/ops-pulse/edd-table-controls.ts",import.meta.url),"utf8")))(name=>name==="./station-edd"?station:exports,controls);
const holds=[{...pkg("RECEIVED",one),trackingId:"1"},{...pkg("RECEIVED",two),trackingId:"2"},{...cash}];
assert.deepEqual(controls.selectEddHolds(holds,"hcr").map(r=>r.pkg.trackingId),["2"],"shared hold selector powers UI and workbook with the same filters");
assert.equal(controls.selectEddHolds(holds,"all","cash").length,0,"delivered parcels are excluded from active holds");
const movement={};
new Function("require","exports","Date",compile(readFileSync(new URL("../src/lib/ops-pulse/edd-movement.ts",import.meta.url),"utf8")))(name=>name==="./station-edd"?station:exports,movement,Clock);
const snapshot = movement.captureEddMovement([
  {...noAttempts,trackingId:"pending"},{...noAttempts,trackingId:"not-checked",verification:null},
  {...pkg("RECEIVED",two),ead:"2026-09-12",trackingId:"hcr"},
  {...cash,trackingId:"cash"},{...cash,trackingId:"cash"},
  {...noAttempts,trackingId:"held",state:"HELD",verification:null},
  {...noAttempts,trackingId:"road",state:"IN_TRANSIT_TO_CUSTOMER",verification:null},
  {...noAttempts,trackingId:"inbound",state:"MANIFESTED",verification:null},
  {...noAttempts,trackingId:"unknown",state:"NEW_SOURCE_STATE",verification:null}
],"2026-09-12");
assert.equal(snapshot.movement.total,8);
assert.equal(snapshot.movement.atStation,3,"physical source stock includes unchecked and HCR returns");
assert.equal(snapshot.movement.pending,1,"only fresh pending excludes HCR and history gaps");
assert.equal(snapshot.movement.delivered,1,"cash delivered, deduplicated");
assert.equal(snapshot.movement.unmapped,1,"new source label remains auditable, never silently reassigned");
assert.equal(snapshot.movement.total,snapshot.movement.atStation+snapshot.movement.onRoad+snapshot.movement.delivered+snapshot.movement.exceptions+snapshot.movement.transit+snapshot.movement.unmapped);
for(const [group] of movement.EDD_MOVEMENT_GROUPS) assert.equal(movement.selectEddCheckpointPackages(snapshot.details,group).length,snapshot.movement[group],"click membership equals exact checkpoint count");
assert.equal(movement.selectEddCheckpointPackages(snapshot.details,"pending").length,1);
assert.equal(movement.eddCheckpointExportRows(movement.selectEddCheckpointPackages(snapshot.details,"atStation"),"A","2026-09-12","2026-09-12T14:05:00Z").length,3);
console.log("PASS attempt lifecycle and classification: duplicate scans, one/two attempts, rejection reasons, delivery/cash, partial-history preservation, FC transit, source clocks, station mismatch, coverage and hold filters.");
