import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const module = {exports:{}};
new Function("module","exports",ts.transpileModule(readFileSync(new URL("./roster-setup-hints.ts",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(module,module.exports);
const {rosterSetupHint,rosterHintApplies,loadRosterSetupHints} = module.exports;
const plan = {id:"plan",status:"pending_approval",roster_kind:"dated",effective_from:"2026-10-05",superseded_at:null,updated_at:"2026-10-05",hr_roster_approval_steps:[
  {stage_no:1,stage_type:"level_1",status:"approved"},
  {stage_no:2,stage_type:"level_2",status:"approved"},
  {stage_no:3,stage_type:"hr",status:"pending"}]};
test("pending final HR approval is not a missing roster",()=>{
  assert.deepEqual(rosterSetupHint(plan),{status:"pending_approval",label:"Awaiting HR approval"});
  assert.equal(rosterSetupHint({...plan,status:"draft"}).label,"Roster draft · not submitted");
  assert.equal(rosterSetupHint({...plan,status:"returned"}).label,"Roster returned · revise");
});
test("hints respect exact dated days and recurring effective windows",()=>{
  assert(rosterHintApplies(plan,"2026-10-06","2026-10-06"));
  assert(!rosterHintApplies(plan,"2026-10-06","2026-10-13"));
  const recurring={...plan,roster_kind:"recurring_weekly"};
  assert(rosterHintApplies(recurring,"2026-10-06","2026-10-13"));
  assert(!rosterHintApplies(recurring,"2026-10-07","2026-10-13"));
  assert(!rosterHintApplies({...recurring,superseded_at:"2026-10-12"},"2026-10-06","2026-10-13"));
  assert(!rosterHintApplies(recurring,"2026-10-06","2026-09-29"));
});
test("loader pages entries and keeps company/worker scopes; never writes",async()=>{
  const calls=[];
  const entries=Array.from({length:501},(_,i)=>({plan_id:"plan",worker_type:"contractor",worker_id:"worker",roster_date:i===500?"2026-10-06":"2026-10-05"}));
  const admin={from(table) {
    const q={select(){return q},eq(field,value){calls.push(["eq",table,field,value]);return q},
      in(field,value){calls.push(["in",table,field,value]);return q},lte(){return q},order(){return q},
      async range(from,to){calls.push(["range",table,from,to]);return {data:(table==="hr_roster_plans"?[plan]:entries).slice(from,to+1),error:null}}};
    return q;
  }};
  const result=await loadRosterSetupHints(admin,"company",["worker"],"2026-10-06");
  assert.equal(result.get("contractor:worker").label,"Awaiting HR approval");
  assert(calls.some(c=>c[0]==="range"&&c[1]==="hr_roster_entries"&&c[2]===500));
  assert(calls.some(c=>c[0]==="in"&&c[2]==="worker_id"&&c[3][0]==="worker"));
  assert(calls.filter(c=>c[0]==="eq"&&c[2]==="company_id").every(c=>c[3]==="company"));
  assert.equal((await loadRosterSetupHints(admin,"company",[],"2026-10-06")).size,0);
});
test("Ops recurring roster lookup stays worker-scoped after station transfers",()=>{
  const source=readFileSync(new URL("./ops-pulse/station-manpower.ts",import.meta.url),"utf8");
  assert(!source.includes("selectedLocationIds.has(plan.location_id)"));
  assert(source.includes('.in("worker_id", workerIds).order("id")'));
  assert(source.includes("activeWeeklyPlans = weeklyPlansResult.data.filter(plan => isRosterPlanActiveOn(plan, asOf))"));
  assert(source.includes("await allRosterRows(() => admin.from"));
});
test("actual Ops loader resolves transferred employee beyond first entry page",async()=>{
  const approved={...plan,status:"approved",roster_kind:"recurring_weekly",location_id:"old",revision_no:1};
  const shift={id:"shift",name:"Day",code:"DAY",start_time:"09:00:00",end_time:"18:00:00",grace_in_minutes:0,grace_out_minutes:0};
  const tables={
    employees:[{id:"worker",employee_code:"E1",full_name:"Transferred Person",biometric_id:null,location_id:"old",designation_id:"designation"}],
    contractors:[],hr_engagements:[{id:"engagement",worker_type:"employee",employee_id:"worker"}],
    designations:[{id:"designation",name:"Team Lead",code:"TL"}],
    hr_work_assignments:[{engagement_id:"engagement",location_id:"new",designation_id:"designation",effective_from:"2026-10-01"}],
    hr_roster_plans:[approved],
    hr_roster_entries:Array.from({length:501},(_,i)=>({id:String(i),plan_id:"plan",worker_type:"employee",worker_id:"worker",roster_date:i===500?"2026-10-06":"2026-10-05",day_type:"working",hr_shifts:shift,hr_roster_plans:approved}))
  };
  const ranged=[];
  const admin={from(table){
    let rows=[...(tables[table]??[])];
    const q={select(){return q},eq(field,value){if(field==="hr_roster_plans.roster_kind") rows=rows.filter(r=>r.hr_roster_plans?.roster_kind===value); if(field==="roster_date")rows=rows.filter(r=>r.roster_date===value);return q},
      is(){return q},not(){return q},neq(){return q},lte(){return q},gte(){return q},or(){return q},order(){return q},
      in(field,values){rows=rows.filter(r=>values.includes(r[field]));return q},
      limit(){return q},range(from,to){ranged.push([table,from]);rows=rows.slice(from,to+1);return q},
      then(resolve){return Promise.resolve({data:rows,error:null}).then(resolve)}};
    return q;
  }};
  const cache=new Map();
  function load(path){
    if(cache.has(path))return cache.get(path);
    const m={exports:{}};
    const source=readFileSync(new URL(path+".ts",import.meta.url),"utf8");
    const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    new Function("require","module","exports",code)(name=>name==="server-only"?{}:name==="@/lib/supabase-admin"?{supabaseAdmin:admin}:name.startsWith("@/lib/")?load("./"+name.slice(6)):require(name),m,m.exports);
    cache.set(path,m.exports);return m.exports;
  }
  const result=await load("./ops-pulse/station-manpower").loadOpsStationManpower("company",[{id:"new",station_code:"NEW",station_name:"New station"}],"2026-10-06");
  assert.equal(result.people.length,1);
  assert.equal(result.people[0].today.shiftName,"Day · 09:00-18:00");
  assert.equal(result.people[0].today.rosterDayType,"working");
  assert.equal(result.people[0].today.rosterSetupStatus,null);
  assert(ranged.some(([table,offset])=>table==="hr_roster_entries"&&offset===500));
});
