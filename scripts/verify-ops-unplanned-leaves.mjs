import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8");
const output=ts.transpileModule(read("src/lib/ops-pulse/unplanned-leaves.ts"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {unplannedDate,filterUnplannedRows,unplannedFilters,emptyUnplannedFilters}=await import("data:text/javascript;base64,"+Buffer.from(output).toString("base64"));
assert.equal(unplannedDate(undefined,new Date("2026-09-09T20:00:00Z")),"2026-09-09");
assert.throws(()=>unplannedDate("2026-02-30"));assert.throws(()=>unplannedDate("2099-01-01"));
assert.throws(()=>unplannedFilters(new URLSearchParams("date=2026-09-08&date=2026-09-09")));
const data={viewerPersonId:"head",managers:[{id:"manager-a"},{id:"manager-b"}],rows:[
 {person_id:"one",manager_person_ids:["manager-a","head"],location_id:"a",cluster:"c",region:"south",full_name:"One",worker_code:"1"},
 {person_id:"two",manager_person_ids:["manager-b","head"],location_id:"b",cluster:"d",region:"north",full_name:"Two",worker_code:"2"},
 {person_id:"three",manager_person_ids:["head"],location_id:"a",cluster:"c",region:"south",full_name:"Three",worker_code:"3"}
]};
assert.deepEqual(filterUnplannedRows(data,{...emptyUnplannedFilters,manager:"manager-a"}).map(r=>r.person_id),["one"]);
assert.throws(()=>filterUnplannedRows(data,{...emptyUnplannedFilters,manager:"outside-manager"}));
assert.deepEqual(filterUnplannedRows(data,{...emptyUnplannedFilters,direct:true}).map(r=>r.person_id),["three"]);
assert.equal(filterUnplannedRows(data,{...emptyUnplannedFilters,location:"outside"}).length,0);
assert.equal(filterUnplannedRows(data,{...emptyUnplannedFilters,region:"south"}).length,2);
assert.equal(filterUnplannedRows(data,{...emptyUnplannedFilters,search:"THREE"}).length,1);
const server=read("src/lib/ops-pulse/unplanned-leaves-data.ts");
assert(server.includes('import "server-only"'));assert(server.includes('p_user_id:auth.userId'));
assert(server.includes('p_owner:isCompanyOwner(auth)'));assert(server.includes('hasPermission(auth,"ops_unplanned_leaves"'));
const api=read("src/app/api/ops-pulse/unplanned-leaves/route.ts");
assert(api.includes('private, no-store'));assert(api.includes('status:403'));assert(!/export async function (POST|PUT|PATCH|DELETE)/.test(api));
assert(api.includes('filterUnplannedRows(data,filters)'));assert(api.includes('await import("xlsx")'));
const sql=read("supabase/migrations/20260910130000_ops_unplanned_people_parity.sql");
assert(sql.includes('stable security invoker'));assert(sql.includes('from public,anon,authenticated'));
assert(sql.includes('v_person_id=any(g.manager_person_ids)'));assert(sql.includes('and v_enabled'));
assert(sql.includes('not daily_punch and not raw_punch'));assert(sql.includes('p_location_ids'));
assert(sql.includes('people_location_id'));assert(sql.includes('manager_name'));
assert(sql.includes("coalesce(g.location_id,w.location_id)"));
assert(!sql.includes('coalesce(r.location_id,g.location_id'));
assert(sql.includes("coalesce(nullif(trim(g.display_name),''),w.full_name)"));
assert(sql.includes('g.designation_name role_name'));
assert(sql.includes('join public.hr_roster_entries r'));
assert(!/\b(update|insert|delete)\s+public\./i.test(sql));assert(!sql.includes('hr_note'));
const component=read("src/components/ops-unplanned-leaves.tsx");
assert(!component.includes('formAction='));assert(!component.includes('hr_note'));assert(component.includes('No punch · confirm'));
assert(component.includes('r.manager_name'));
assert(read("src/lib/access-surface.ts").includes('"ops_unplanned_leaves"'));
assert(read("src/components/permission-matrix.tsx").includes('"ops_unplanned_leaves"'));
assert(read("src/app/api/ops-pulse/unplanned-leaves/route.ts").includes('"Reporting manager"'));
console.log("PASS: dates, hierarchy drill-down, People identity parity, scope rejection, filters/export parity, no-store, server-only auth and read-only contract.");
