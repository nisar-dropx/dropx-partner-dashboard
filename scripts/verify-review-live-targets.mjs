import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import ts from "typescript";
const require=createRequire(import.meta.url);
function load(path,deps={}) {
  const exports={};
  new Function("require","exports",ts.transpileModule(readFileSync(new URL("../"+path,import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(key=>deps[key]??require(key),exports);
  return exports;
}
const hawkeye=load("src/lib/ops-pulse/hawkeye.ts");
assert.equal(hawkeye.hawkeyeTargetKey(hawkeye.hawkeyeMetricDefinitions.find(row=>row.short==="AFN Std DSR")),"dsr","review uses the same existing DSR mapping as Daily Performance");
const targets=load("src/lib/ops-pulse/performance-targets.ts",{"@/lib/supabase-admin":{},"./hawkeye":hawkeye});
assert.ok(targets.performanceTargetSeeds.every(row=>row.target===null),"no assumed numeric target defaults");
assert.ok(targets.performanceTargetSeeds.every(row=>["higher","lower"].includes(row.direction)),"metadata column mappings remain valid");
const sls={metricKey:"c_ret_fdps",reportType:"sls",target:.85,direction:"higher",unit:"percent",sourceIndex:7,isActive:true,displayOrder:7};
const resolved=rows=>targets.resolvePerformanceTargets(rows,"daily").find(row=>row.metricKey==="c_ret_fdps");
assert.equal(resolved([sls]).target,.85);
assert.equal(resolved([sls]).sourceIndex,null,"SLS import index cannot enter Daily");
assert.equal(resolved([{...sls,target:.82}]).target,.82,"master edit flows through");
const daily={...sls,reportType:"daily",sourceIndex:null,target:null};
assert.equal(resolved([sls,daily]).target,.85);
assert.equal(resolved([sls,{...daily,explicitReviewTarget:true}]).target,null);
assert.equal(resolved([sls,{...daily,isActive:false}]),undefined);
assert.equal(resolved([{...sls,unit:"dpmo"}]),undefined,"reject incompatible units");
assert.equal(resolved([]),undefined);
const verification=load("src/lib/ops-pulse/edd-verification.ts");
const cohort=load("src/lib/ops-pulse/review-edd-cohort.ts",{"./edd-verification":verification});
const day="2026-09-11",at=clock=>day+"T"+clock+":00+05:30";
const pkg={trackingId:"T1",ead:day,state:"INDUCTED",sourceAt:at("08:00"),verification:{state:"INDUCTED",firstAttemptAt:null,firstDispatchAt:null,historyComplete:true},verifiedAt:at("08:00")};
const stock={fetchedAt:at("10:00"),packages:[]};
const out={fetchedAt:at("10:01"),packages:[{trackingId:"T1",state:"DELIVERED"}]};
let result=cohort.mergeReviewEddCohort([pkg],stock,out);
assert.equal(verification.eddCurrentState(result[0]),"DELIVERED");
assert.equal(result[0].ead,day,"retain delivered EDD");
result=cohort.mergeReviewEddCohort([{...pkg,state:"DELIVERED"}],{...stock,packages:[pkg]},{...out,packages:[{trackingId:"T1",state:"IN_TRANSIT"}]});
assert.equal(verification.eddCurrentState(result[0]),"DELIVERED","terminal delivery cannot be resurrected");
result=cohort.mergeReviewEddCohort([pkg],stock,null);
assert.equal(verification.eddCurrentState(result[0]),"UNKNOWN","absent TID is not pending by assumption");
assert.equal(cohort.mergeReviewEddCohort([],stock,out)[0].ead,null,"no invented EDD");
assert.equal(pkg.state,"INDUCTED","input immutable");
// Durable retry/concurrency tests live in verify-review-source-queue.mjs.
const endpoint=load("src/app/api/ops-pulse/performance/edd-history/route.ts",{
  "@/lib/authorization":{getAuthorization:async()=>({}),hasPermission:()=>true},
  "@/lib/company-scope":{requireCompanyId:()=>"company"},
  "@/lib/ops-pulse/cod":{loadCodLocations:async()=>({locations:[{id:"station",station_code:"GNTF"}]})},
  "@/lib/ops-pulse/review-operations-data":{loadReviewEddHistory:async(...args)=>{assert.deepEqual(args,["company","station","GNTF",day]);return {timeline:{day},error:null};}}
});
const request=(station,date)=>new Request("https://ops.dropxlogistics.com/api/ops-pulse/performance/edd-history?"+new URLSearchParams({station,date}));
assert.equal((await endpoint.GET(request("GNTF",day))).status,200);
assert.equal((await endpoint.GET(request("OTHER",day))).status,403);
assert.equal((await endpoint.GET(request("GNTF","2026-02-31"))).status,400);
console.log("PASS live review: master-only thresholds, unit/mapping/override safeguards, delivered cohort, absent-TID uncertainty, fair bounded refresh and scoped polling.");
