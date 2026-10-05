import assert from 'node:assert/strict';import fs from 'node:fs';import ts from 'typescript';import {PGlite} from '@electric-sql/pglite';
function load(path){const exports={};new Function('exports',ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(exports);return exports;}
const {planAuditMonth}=load('src/lib/fleet/audit-month-planner.ts'),{defaultFleetAuditProgrammeConfig:config}=load('src/lib/fleet/audit-programme-config.ts');
const vehicles=Array.from({length:32},(_,i)=>({id:`v${i}`,vehicle_no:`KL${i}`,station_code:`ST${Math.floor(i/3)}`,status:'active'}));
let input={month:'2026-10',today:'2026-10-05',config,vehicles,audits:[],stations:[]};
let p=planAuditMonth(input);assert.equal(p.changes.length,64);assert.ok(p.days.filter(d=>d.physical+d.virtual>0).length>=20);assert.ok(p.changes.some(a=>a.scheduled_for>='2026-10-28'));
for(const day of p.days){assert.ok(day.physical<=4&&day.virtual<=6);assert.ok(day.stations.length<=1);assert.notEqual(new Date(day.date).getUTCDay(),0);}
for(const v of vehicles){const both=p.changes.filter(a=>a.vehicle_id===v.id);assert.equal(both.length,2);assert.ok(Math.abs(Date.parse(both[0].scheduled_for)-Date.parse(both[1].scheduled_for))>=7*86400000);}
const existing=p.changes.map((a,i)=>({...a,id:`a${i}`,status:'scheduled',updated_at:'2026-10-05T00:00:00Z'}));
assert.equal(planAuditMonth({...input,audits:existing}).changes.length,0,'Cron is idempotent and does not push dates forward');
const leave=existing.find(a=>a.mode==='physical').scheduled_for;
const replanned=planAuditMonth({...input,audits:existing,leaveDates:[leave]});assert.ok(replanned.changes.length);assert.ok(replanned.changes.every(a=>a.scheduled_for!==leave));
const started={...existing[0],status:'in_progress'};const manual={...existing[1],scheduled_reason:'[mode:physical] Manually arranged'};
assert.ok(planAuditMonth({...input,audits:[started,manual,...existing.slice(2)],rebalance:true}).changes.every(a=>a.id!==started.id&&a.id!==manual.id));
assert.throws(()=>planAuditMonth({...input,today:'2026-10-31'}),/No dates were changed/);
assert.throws(()=>planAuditMonth({...input,audits:[existing[0],{...existing[0],id:'dup'}]}),/Duplicate/);
const db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role;
create table fleet_vehicles(id uuid primary key,company_id uuid,vehicle_no text,station_code text,status text);
create table fleet_audit_templates(id uuid primary key,company_id uuid);
create table fleet_audits(id uuid primary key default gen_random_uuid(),company_id uuid,vehicle_id uuid,template_id uuid,scheduled_for date,scheduled_reason text,status text,assigned_to uuid,created_by uuid,created_at timestamptz default now(),updated_at timestamptz default now(),draft jsonb default '{}');
create table fleet_audit_responses(audit_id uuid);create table fleet_audit_evidence(audit_id uuid);`);
const company='00000000-0000-0000-0000-000000000001',vid='00000000-0000-0000-0000-000000000002';
await db.query(`insert into fleet_vehicles values($1,$2,'KL1','KOZA','active')`,[vid,company]);
await db.query(`insert into fleet_audits(company_id,vehicle_id,scheduled_for,scheduled_reason,status) values($1,$2,'2026-10-05','[mode:physical] Auto programme','scheduled'),($1,$2,'2026-10-05','[mode:physical] Auto programme','in_progress'),($1,$2,'2026-10-05','[mode:video] Auto programme','scheduled')`,[company,vid]);
await db.exec(fs.readFileSync('supabase/migrations/20261005111647_fleet_audit_monthly_integrity.sql','utf8'));
let audits=(await db.query("select * from fleet_audits where status<>'cancelled'")).rows;assert.equal(audits.length,2);assert.equal((await db.query('select count(*)::int as n from fleet_audit_schedule_revisions')).rows[0].n,1);assert.ok(audits.some(a=>a.status==='in_progress'));
await assert.rejects(db.query(`insert into fleet_audits(company_id,vehicle_id,scheduled_for,scheduled_reason,status) values($1,$2,'2026-10-20','[mode:physical] Another','scheduled')`,[company,vid]),/unique/);
const expected=audits.map(a=>({id:a.id,status:a.status,updated_at:a.updated_at}));const virtual=audits.find(a=>a.status==='scheduled');const changes=[{id:virtual.id,vehicle_id:vid,mode:'video',scheduled_for:'2026-10-22'}];
const call=(expect,list)=>db.query('select fleet_apply_audit_month_plan($1,$2,$3,$4,null,null) as result',[company,'2026-10-01',JSON.stringify(expect),JSON.stringify(list)]);
assert.equal((await call(expected,changes)).rows[0].result.moved,1);await assert.rejects(call(expected,changes),/changed while planning/);
audits=(await db.query("select * from fleet_audits where status<>'cancelled'")).rows;const current=audits.map(a=>({id:a.id,status:a.status,updated_at:a.updated_at}));const progress=audits.find(a=>a.status==='in_progress');await assert.rejects(call(current,[{id:progress.id,vehicle_id:vid,mode:'physical',scheduled_for:'2026-10-22'}]),/unstarted/);
assert.equal((await db.query("select has_function_privilege('authenticated','fleet_apply_audit_month_plan(uuid,date,jsonb,jsonb,uuid,uuid)','EXECUTE') as allowed")).rows[0].allowed,false);
await db.close();
console.log('Monthly planner: 64 slots spread through month, capacity/station limits, audit gaps, leave, idempotency, fixed work, duplicate guard, revision history, stale-plan rollback and RPC permissions passed.');
// Optional local live-data rehearsal, using exactly the same pure planner.
if(fs.existsSync('output/audit-month-live.json')){
const live=JSON.parse(fs.readFileSync('output/audit-month-live.json','utf8'));const rank=a=>a.status==='in_progress'?0:1;
const unique=new Map();for(const a of live.audits.sort((a,b)=>rank(a)-rank(b)||a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id))){const k=a.vehicle_id+':'+(/\[mode:video\]/.test(a.scheduled_reason)?'video':'physical');if(!unique.has(k))unique.set(k,a);}
const plan=planAuditMonth({...input,vehicles:live.vehicles,stations:live.stations,audits:[...unique.values()],rebalance:true});fs.writeFileSync('output/audit-month-preview.json',JSON.stringify(plan,null,2));console.log('Live rehearsal:',JSON.stringify({active:[...unique.values()].length,moved:plan.changes.length,days:plan.days.filter(d=>d.physical+d.virtual>0)}));}
