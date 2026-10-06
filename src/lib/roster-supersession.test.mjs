import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
function load(path) {
  const m = { exports: {} };
  new Function("module", "exports", ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText)(m, m.exports);
  return m.exports;
}
const { retireFullyReplacedRosterPlans } = load("./roster-supersession.ts");
const { compareRosterPlanPreference } = load("./roster-plan-preference.ts");
const plan = (id, patch = {}) => ({ id, company_id: "company", status: "approved", roster_kind: "recurring_weekly",
  location_id: "station", effective_from: id === "new" ? "2026-10-05" : "2026-09-28", superseded_at: null, ...patch });
const pattern = (plan_id, worker_id, days = 7) => Array.from({length:days},(_,i)=>({
  id: plan_id+worker_id+i, company_id:"company", plan_id, worker_type:"contractor", worker_id,
  roster_date:"2026-09-"+String(21+i), day_type:i===6?"weekly_off":"working", shift_id:i===6?null:"shift"
}));
function database(plans, entries) {
  const writes = [];
  const admin = { from(table) {
    let filters = [], range = null, update = null;
    const q = {
      select(){return q}, order(){return q},
      eq(k,v){filters.push(r=>r[k]===v);return q},
      neq(k,v){filters.push(r=>r[k]!==v);return q},
      is(k,v){filters.push(r=>r[k]===v);return q},
      in(k,v){filters.push(r=>v.includes(r[k]));return q},
      lte(k,v){filters.push(r=>r[k]<=v);return q},
      range(a,b){range=[a,b];return q},
      update(v){update=v;return q},
      maybeSingle(){return Promise.resolve(run(true))},
      then(resolve,reject){return Promise.resolve(run(false)).then(resolve,reject)}
    };
    function run(single) {
      let rows = (table==="hr_roster_plans"?plans:entries).filter(r=>filters.every(f=>f(r)));
      if(range) rows=rows.slice(range[0],range[1]+1);
      if(update) { for(const row of rows) { writes.push({id:row.id,...update}); Object.assign(row,update); } }
      return {data:single?rows[0]??null:rows,error:null};
    }
    return q;
  }};
  return {admin,writes};
}
test("pending, returned and draft replacements never retire an approved roster",async()=>{
  for(const status of ["pending_approval","draft","returned","rejected"]){
    const d=database([plan("old"),plan("new",{status})],[...pattern("old","a"),...pattern("new","a")]);
    assert.equal(await retireFullyReplacedRosterPlans(d.admin,"company","new"),0);
    assert.deepEqual(d.writes,[]);
  }
});
test("only a fully covered old roster retires after approval",async()=>{
  const d=database([plan("old"),plan("new")],[...pattern("old","a"),...pattern("new","a")]);
  assert.equal(await retireFullyReplacedRosterPlans(d.admin,"company","new"),1);
  assert.deepEqual(d.writes,[{id:"old",superseded_at:"2026-10-05"}]);
});
test("omitted and transferred people keep their last approved pattern",async()=>{
  const d=database([plan("old"),plan("new")],[...pattern("old","a"),...pattern("old","omitted"),...pattern("new","a")]);
  assert.equal(await retireFullyReplacedRosterPlans(d.admin,"company","new"),0);
  assert.deepEqual(d.writes,[]);
});
test("partial new weeks and empty replacements never retire the baseline",async()=>{
  for(const days of [0,3,6]){
    const d=database([plan("old"),plan("new")],[...pattern("old","a"),...pattern("new","a",days)]);
    assert.equal(await retireFullyReplacedRosterPlans(d.admin,"company","new"),0);
  }
});
test("company, location and future-effective boundaries are preserved",async()=>{
  const d=database([plan("old"),plan("new"),plan("future",{effective_from:"2026-11-01"}),plan("foreign",{company_id:"other"}),plan("elsewhere",{location_id:"other"})],
    ["old","new","future","foreign","elsewhere"].flatMap(id=>pattern(id,"a")));
  await retireFullyReplacedRosterPlans(d.admin,"company","new");
  assert.deepEqual(d.writes.map(r=>r.id),["old"]);
});
test("pagination cannot hide an omitted worker from the retirement check",async()=>{
  const old=Array.from({length:501},(_,i)=>({...pattern("old",i===500?"omitted":"a",1)[0],id:String(i)}));
  const d=database([plan("old"),plan("new")],[...old,...pattern("new","a")]);
  assert.equal(await retireFullyReplacedRosterPlans(d.admin,"company","new"),0);
});
test("newer approved effective date beats an old plan's higher revision number",()=>{
  const old=plan("old",{revision_no:50}), newer=plan("new",{revision_no:1});
  assert(compareRosterPlanPreference(newer,old)<0);
});
