import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const writes = [];
const db = {from(table) {
  let write = null;
  const query = {
    insert(payload) {write = {table, kind:"insert", payload}; writes.push(write); return query;},
    update(payload) {write = {table, kind:"update", payload}; writes.push(write); return query;},
    select() {return query;}, eq() {return query;},
    single: async () => ({data:{id:"station-a"},error:null}),
    maybeSingle: async () => ({data:{station_email:null},error:null}),
    then(resolve) {return Promise.resolve({data:null,error:null}).then(resolve);},
  };
  return query;
}};
const mocks = {
  "next/cache": {revalidatePath() {}},
  "next/navigation": {redirect(path) {throw new Error(`redirect:${path}`);}},
  "@/lib/authorization": {requirePagePermission: async () => ({companyId:"company-a"})},
  "@/lib/company-scope": {requireCompanyId: a => a.companyId, withCompany: (p,id) => ({...p,company_id:id})},
  "@/lib/india-states": {indiaStateCode: v => v},
  "@/lib/supabase-admin": {supabaseAdmin:db},
};
const source = fs.readFileSync("src/app/settings/actions.ts","utf8");
const js = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const mod = {exports:{}};
new Function("require","module","exports",js)(id => {
  assert.ok(id in mocks, `Unexpected dependency ${id}`); return mocks[id];
},mod,mod.exports);
function form(forged = false) {
  const data = new FormData();
  for (const [key,value] of Object.entries({id:"station-a",station_code:"TEST",station_name:"Test",address_line1:"Address",state:"KL"})) data.set(key,value);
  if (forged) for (const key of ["station_manager_email","cluster","cluster_manager","aom"]) data.set(key,"former-manager@example.test");
  return data;
}
await mod.exports.createLocation(form());
await assert.rejects(mod.exports.updateLocation(form(true)),/redirect:\/master\/location/);
assert.equal(writes.length,2);
for (const write of writes) {
  assert.equal(write.table,"stations");
  for (const key of ["station_manager_email","cluster","cluster_manager","aom","reports_to_user_id"]) assert.equal(key in write.payload,false,key);
  assert.equal(write.payload.station_code,"TEST");
}
const page = fs.readFileSync("src/app/master/location/page.tsx","utf8");
assert.doesNotMatch(page,/name="(?:station_manager_email|cluster|cluster_manager|aom)"/);
assert.doesNotMatch(source,/locationAccessProfiles|addLocationAccess|reports_to_user_id:/);
assert.match(page,/loadPeopleOperationalHierarchy/);
assert.match(page,/PeopleOwnershipRefresh paused=/);
console.log("PASS Location create needs no manager; forged manager fields cannot alter People ownership, reporting or manager access.");
