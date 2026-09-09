import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
const require=createRequire(import.meta.url);
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
function compile(path,dependencies={}) {
  const exports={};
  new Function("require","exports",ts.transpileModule(read(path),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText)(name=>dependencies[name]??require(name),exports);
  return exports;
}
const logic=compile("src/lib/ops-pulse/review-attendance-history.ts");
const date="2026-09-08", time=clock=>`${date}T${clock}:00+05:30`;
const input={date,inScope:true,dayType:"working",shift:"Morning",start:"06:00:00",end:"15:00:00",grace:5,inTime:time("06:05"),outTime:time("15:00"),workMinutes:535,punchCount:2,attendanceStatus:"P",approvedLeave:false,requestedLeave:false};
const classify=(fields={},now=time("23:59"))=>logic.classifyAttendanceDay({...input,...fields},new Date(now));
assert.equal(classify().status,"on_time");
assert.equal(classify({inTime:time("06:06")}).lateMinutes,1);
assert.equal(classify({outTime:null}).workMinutes,null);
assert.equal(classify({workMinutes:-10}).workMinutes,null);
assert.equal(classify({dayType:"weekly_off"}).status,"week_off_worked");
assert.equal(classify({approvedLeave:true}).status,"leave");
assert.equal(classify({dayType:null}).status,"no_shift");
const absent={inTime:null,outTime:null,punchCount:0,attendanceStatus:"A"};
assert.equal(classify(absent).status,"unplanned_absence");
assert.equal(classify({...absent,attendanceStatus:null}).status,"absence_unconfirmed");
assert.equal(classify({...absent,requestedLeave:true}).status,"leave_pending");
assert.equal(classify({...absent,approvedLeave:true}).status,"leave");
assert.equal(classify({...absent,dayType:"weekly_off"}).status,"week_off");
assert.equal(classify({...absent,punchCount:1}).status,"attendance_conflict");
assert.equal(classify({...absent,punchCount:1,rawActivityOnly:true,dayType:"weekly_off"}).status,"attendance_conflict");
assert.equal(classify({...absent,punchCount:1,ambiguousPunch:true}).status,"attendance_conflict");
assert.equal(classify(absent,time("05:00")).status,"upcoming");
assert.equal(classify(absent,time("08:00")).status,"not_reported");
assert.equal(classify({...absent,start:"22:00:00",end:"06:00:00"},"2026-09-09T04:00:00+05:30").status,"not_reported","night shift is not absent at midnight");
assert.equal(classify({...absent,start:"22:00:00",end:"06:00:00"},"2026-09-09T07:00:00+05:30").status,"unplanned_absence");
assert.equal(classify({start:"23:00:00",end:"08:00:00",inTime:time("03:00")}).status,"attendance_conflict","early-morning punch must not be marked on time for that evening's night shift");
assert.equal(classify({dayType:"weekly_off",overnightCarryoverOnly:true}).status,"attendance_conflict","previous night's carryover is not new week-off work");
const outside=classify({inScope:false});
assert.equal(outside.inTime,null); assert.equal(outside.shift,null); assert.equal(outside.workMinutes,null);
assert.throws(()=>logic.attendanceHistoryDates("2026-02-30"));
assert.equal(logic.attendanceHistoryDates("2026-09-01")[0],"2026-08-26");
assert.equal(logic.attendanceHistoryDates("2026-09-30").length,30);
const person={id:"employee:a",name:"Arjun",role:"TL",code:"D1",days:[...logic.attendanceHistoryDates(date).map(d=>({...classify(),date:d}))]};
person.days[0].status="late";person.days[1].status="late";
assert.deepEqual(logic.summarizeAttendance(logic.historyPeriodDays(person,date,"mtd")),{late:2,reported:8,onTime:6,repeated:true,allReportedLate:false,unplanned:0,unchecked:0,weekOffWorked:0});
assert.equal(logic.summarizeAttendance(logic.historyPeriodDays(person,date,"7d")).late,1);
assert.ok(logic.summarizeAttendance([{status:"late"},{status:"late"},{status:"week_off"}]).allReportedLate);

// Request authorization and location scoping, with no live mutations.
let authorized=true,scope=true,fail=false,loads=0;
const route=compile("src/app/api/ops-pulse/performance/attendance-history/route.ts",{
  "@/lib/authorization":{getAuthorization:async()=>authorized?{locationScopeIds:["station1"],hasAllLocationAccess:false}:null,hasPermission:()=>authorized},
  "@/lib/company-scope":{requireCompanyId:()=>"company1"},
  "@/lib/ops-pulse/cod":{loadCodLocations:async(company,ids,all)=>{assert.equal(company,"company1");assert.deepEqual(ids,["station1"]);assert.equal(all,false);return {locations:scope?[{id:"station1",station_code:"GDRD"}]:[],error:null};}},
  "@/lib/ops-pulse/review-attendance-history":logic,
  "@/lib/ops-pulse/review-attendance-history-data":{loadReviewAttendanceHistory:async(company,station,date)=>{loads++;assert.equal(company,"company1");assert.equal(station.id,"station1");if(fail)throw Error("SECRET_INTERNAL_DETAIL");return {station:station.station_code,date,people:[person]};}}
});
const request=(query=`station=GDRD&date=${date}`)=>new Request(`https://ops.dropxlogistics.com/api/ops-pulse/performance/attendance-history?${query}`);
authorized=false;assert.equal((await route.GET(request())).status,403);assert.equal(loads,0);
authorized=true;scope=false;assert.equal((await route.GET(request())).status,403);assert.equal(loads,0);
scope=true;
for(const query of ["station=GDRD&date=2026-02-30",`station=GDRD&date=${date}&station=QLDA`,"station=GDRD&date=2999-01-01","station=bad%3Bselect&date=2026-09-08"]) assert.equal((await route.GET(request(query))).status,400);
let response=await route.GET(request());assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"private, no-store");
fail=true;response=await route.GET(request());assert.equal(response.status,503);assert.ok(!(await response.text()).includes("SECRET_INTERNAL_DETAIL"));

// Batched loader: date-specific roster wins; raw activity prevents false absence.
const queries=[];
const profile={id:"a",biometric_id:"000123",location_id:"station1",date_of_join:"2026-09-01",last_working_date:null};
const plan={id:"plan",roster_kind:"dated",effective_from:"2026-09-01",superseded_at:null,revision_no:1};
const tables={employees:[profile],contractors:[],hr_engagements:[],hr_work_assignments:[],hr_roster_plans:[],
  hr_roster_entries:[{plan_id:"plan",worker_type:"employee",worker_id:"a",roster_date:date,day_type:"working",hr_shifts:{name:"Morning",start_time:"06:00:00",end_time:"15:00:00",grace_in_minutes:5},hr_roster_plans:plan}],hr_leave_requests:[],
  attendance_daily:[{id:"daily",punch_date:date,employee_id:"a",worker_type:"employee",enrolment_id:"123",in_time:null,out_time:null,work_minutes:null,punch_count:0,status:"A"}],attendance_punches:[{enrolment_id:"000123",punch_date:date}]};
const db={from(table){const filters=[];queries.push({table,filters});const q={then:resolve=>Promise.resolve({data:tables[table]??[],error:null}).then(resolve)};for(const method of ["select","eq","in","or","lte","gte","neq","order","range"])q[method]=(...args)=>{filters.push([method,...args]);return q;};return q;}};
const loader=compile("src/lib/ops-pulse/review-attendance-history-data.ts",{"server-only":{},"@/lib/supabase-admin":{supabaseAdmin:db},"./review-attendance-history":logic,"./review-operations-data":{loadReviewUtrDiscipline:async()=>({discipline:{rows:[{id:"employee:a",name:"Arjun",code:"D1",role:"TL"}]},error:null})}});
const loaded=await loader.loadReviewAttendanceHistory("company1",{id:"station1",station_code:"GDRD"},date);
assert.equal(loaded.people[0].days.find(d=>d.date===date).status,"attendance_conflict");
assert.ok(queries.every(q=>q.filters.some(f=>f[0]==="eq"&&f[1]==="company_id"&&f[2]==="company1")),"every database read is company scoped");
assert.equal(queries.filter(q=>q.table==="attendance_daily").length,1,"one monthly batch, not one query per day");
tables.attendance_daily[0].in_time=time("06:10");tables.attendance_daily[0].out_time=time("15:00");tables.attendance_daily[0].punch_count=2;tables.attendance_daily[0].work_minutes=530;
assert.equal((await loader.loadReviewAttendanceHistory("company1",{id:"station1",station_code:"GDRD"},date)).people[0].days.at(-1).lateMinutes,5);
tables.hr_engagements=[{id:"engagement",worker_type:"employee",employee_id:"a",start_date:"2026-09-05",end_date:null}];
tables.hr_work_assignments=[{engagement_id:"engagement",location_id:"station1",effective_from:"2026-09-05",effective_to:null}];
const serviceHistory=await loader.loadReviewAttendanceHistory("company1",{id:"station1",station_code:"GDRD"},date);
assert.equal(serviceHistory.people[0].days[0].status,"outside_station","profile location cannot invent service before a known engagement/assignment");
assert.equal(serviceHistory.people[0].days.at(-1).status,"late");
tables.attendance_daily[0]={...tables.attendance_daily[0],worker_type:null,employee_id:null,in_time:null,out_time:null,punch_count:0,status:"A"};
tables.attendance_punches=[];
tables.biometric_enrolments=[{enrolment_id:"123",profile_type:"employee",account_id:"a",effective_from:"2026-09-01",effective_to:null}];
assert.equal((await loader.loadReviewAttendanceHistory("company1",{id:"station1",station_code:"GDRD"},date)).people[0].days.at(-1).status,"unplanned_absence","unlinked no-punch absent aggregates use the dated registration");
tables.biometric_enrolments.push({enrolment_id:"123",profile_type:"workforce",account_id:"other",effective_from:"2026-09-01",effective_to:null});
assert.equal((await loader.loadReviewAttendanceHistory("company1",{id:"station1",station_code:"GDRD"},date)).people[0].days.at(-1).status,"absence_unconfirmed","conflicting Workforce mapping cannot become a People absence");
tables.biometric_enrolments=[{enrolment_id:"123",profile_type:"employee",account_id:"a",effective_from:"2026-09-09",effective_to:null}];
assert.equal((await loader.loadReviewAttendanceHistory("company1",{id:"station1",station_code:"GDRD"},date)).people[0].days.at(-1).status,"absence_unconfirmed","a future registration cannot attribute earlier absence");
tables.biometric_enrolments[0].effective_from="2026-09-01";
tables.hr_roster_entries[0].hr_shifts={name:"Night",start_time:"23:00:00",end_time:"08:00:00",grace_in_minutes:0};
tables.attendance_punches=[{enrolment_id:"123",punch_date:"2026-09-09",punch_time:"2026-09-09T03:00:00+05:30"}];
assert.equal((await loader.loadReviewAttendanceHistory("company1",{id:"station1",station_code:"GDRD"},date)).people[0].days.at(-1).status,"attendance_conflict","next-calendar-day punches protect an overnight shift from false absence");

const ui=read("src/components/review-attendance-history.tsx");
assert.ok(ui.includes("AbortController")&&ui.includes('cache: "no-store"'),"cancel stale navigation requests and do not cache private attendance");
assert.ok(ui.includes("Last 7 days")&&ui.includes("MTD")&&ui.includes("Repeated lateness")&&ui.includes("Sort UTR staff"));
assert.ok(!ui.includes("window.open")&&!ui.includes('role="dialog"'),"person history stays inline");
assert.ok(read("src/components/performance-opening-card.tsx").includes("ReviewPersonHistoryLink"));
assert.ok(read("src/components/performance-rca-actions.tsx").includes("ReviewPersonHistoryLink"));
const React=require("react"), {renderToStaticMarkup}=require("react-dom/server");
const operations=compile("src/lib/ops-pulse/review-operations.ts");
const historyUi=compile("src/components/review-attendance-history.tsx",{
  react:{...React,useContext:()=>({date,data:{station:"GDRD",date,people:[person]},error:null,retry(){}})},
  "@/lib/date-format":{formatDashboardDate:d=>d},"@/lib/ops-pulse/review-operations":operations,"@/lib/ops-pulse/review-attendance-history":logic
});
const historyHtml=renderToStaticMarkup(React.createElement(historyUi.ReviewPersonHistory,{personId:person.id}));
assert.ok(historyHtml.includes("Arjun attendance history")&&historyHtml.includes("Repeated lateness · 2 days")&&historyHtml.includes("Last 7 days")&&historyHtml.includes("535")===false);
assert.equal((historyHtml.match(/scope="row"/g)??[]).length,8);
assert.ok(historyHtml.includes("8h 55m")&&historyHtml.includes("2026-09-01"));
const utrHtml=renderToStaticMarkup(React.createElement(historyUi.UtrAttendanceDrilldown,{discipline:{rows:[{...person,inTime:input.inTime,outTime:input.outTime,workMinutes:535,status:"On time",lateMinutes:0}],scheduled:1,onTime:1}}));
assert.ok(utrHtml.includes("Late 2/8 reported")&&utrHtml.includes("Search UTR staff")&&utrHtml.includes("Sort UTR staff"));
assert.ok(utrHtml.includes('aria-label="Arjun: 2 of 8 reported shifts late — view history"')&&utrHtml.includes("Refresh history"));
assert.ok(renderToStaticMarkup(React.createElement(historyUi.UtrRepeatSummary)).includes("1 repeated-late staff"));
console.log("PASS Review attendance: 7D/MTD, grace/night shifts, repeat patterns, leave and week-off safeguards, raw punch gaps, batched scoped reads, private API guards and reusable inline person history.");
