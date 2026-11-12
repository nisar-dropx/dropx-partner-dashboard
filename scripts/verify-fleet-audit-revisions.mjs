import {PGlite} from '@electric-sql/pglite';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const db=new PGlite();
await db.exec(`create role anon;create role authenticated;create role service_role;
create table companies(id uuid primary key);
create table profiles(id uuid primary key);
create table fleet_vehicles(id uuid primary key);`);

const original=fs.readFileSync('supabase/migrations/20260926183000_fleet_control_system.sql','utf8');
await db.exec(original.slice(original.indexOf('create table if not exists public.fleet_audit_templates'),original.indexOf('create table if not exists public.fleet_control_settings')));
await db.exec("alter table fleet_audit_checklist_items add column if not exists audit_mode text default 'both'");
await db.exec(fs.readFileSync('supabase/migrations/20261004225138_fleet_practical_audits_pwa.sql','utf8'));
await db.exec(`
alter table public.fleet_audit_findings add column if not exists responsible_name text;
alter table public.fleet_audit_findings add column if not exists last_update_id uuid;
create table if not exists public.fleet_audit_finding_updates (
 id uuid primary key,
 company_id uuid not null,
 finding_id uuid not null,
 actor_id uuid not null,
 actor_name text not null,
 status text not null,
 note text not null,
 action_required text not null,
 responsible_name text not null,
 due_date date not null,
 severity text not null,
 before_state jsonb not null,
 proofs jsonb not null default '[]'::jsonb,
 created_at timestamptz not null default now()
);
create or replace function public.fleet_finding_update_guard() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if current_setting('fleet.audit_revision', true) = '1' then return new; end if;
 if row(new.status,new.resolution_note,new.action_required,new.expected_completion_date,new.severity,new.responsible_name,new.resolved_at,new.owner_user_id)
    is distinct from row(old.status,old.resolution_note,old.action_required,old.expected_completion_date,old.severity,old.responsible_name,old.resolved_at,old.owner_user_id) then
  if new.last_update_id is null or new.last_update_id is not distinct from old.last_update_id then
    raise exception 'Use the audit action tracker. Closure requires uploaded proof and a recorded update.';
  end if;
 end if;
 return new;
end $$;
create trigger fleet_finding_update_guard before update on public.fleet_audit_findings for each row execute function public.fleet_finding_update_guard();
`);
await db.exec(fs.readFileSync('supabase/migrations/20261112120000_fleet_audit_revisions.sql','utf8'));

const c='00000000-0000-4000-8000-000000000001',u='00000000-0000-4000-8000-000000000002',v='00000000-0000-4000-8000-000000000003',a='00000000-0000-4000-8000-000000000004',t='00000000-0000-4000-8000-000000000005',i='00000000-0000-4000-8000-000000000006',i2='00000000-0000-4000-8000-000000000007';
await db.exec(`insert into companies values('${c}');insert into profiles values('${u}');insert into fleet_vehicles values('${v}');
insert into fleet_audit_templates(id,company_id,name) values('${t}','${c}','Test');
insert into fleet_audit_checklist_items(id,company_id,template_id,category,label) values('${i}','${c}','${t}','Tyres','Front tyre');
insert into fleet_audit_checklist_items(id,company_id,template_id,category,label) values('${i2}','${c}','${t}','Lights','Headlight');
insert into fleet_audits(id,company_id,vehicle_id,template_id,scheduled_for,scheduled_reason,status,completed_at,completed_by,score,summary)
 values('${a}','${c}','${v}','${t}','2026-11-12','[mode:physical] Test','failed',now(),'${u}',40,'Initial fail');`);

const completePayload={
  responses:[
    {itemId:i,passed:false,comments:'Worn',snapshot:{value:'poor',label:'Front tyre'}},
    {itemId:i2,passed:true,comments:'',snapshot:{value:'good',label:'Headlight'}}
  ],
  evidence:[{itemId:i,type:'photo',url:'https://example.com/tyre.jpg',caption:'Tyre'}],
  findings:[{itemId:i,category:'Tyres',finding:'Worn tyre',severity:'high',actionRequired:'Replace',expectedCompletionDate:'2026-11-19'}],
  status:'failed',score:40,summary:'Initial fail',odometerKm:100
};
// Seed completed state via direct inserts matching complete RPC outcome (audit already marked completed).
await db.exec(`
insert into fleet_audit_responses(company_id,audit_id,checklist_item_id,response_value,passed,comments,responded_by)
values ('${c}','${a}','${i}','{"value":"poor"}',false,'Worn','${u}'),
       ('${c}','${a}','${i2}','{"value":"good"}',true,'','${u}');
insert into fleet_audit_evidence(company_id,audit_id,checklist_item_id,media_type,media_url,caption,uploaded_by)
values ('${c}','${a}','${i}','photo','https://example.com/tyre.jpg','Tyre','${u}');
insert into fleet_audit_findings(company_id,audit_id,checklist_item_id,category,finding,severity,action_required,expected_completion_date,owner_user_id,status)
values ('${c}','${a}','${i}','Tyres','Worn tyre','high','Replace','2026-11-19','${u}','open');
`);

const revise=(data)=>db.query('select fleet_revise_audit_v1($1,$2,$3,$4::jsonb)',[c,a,u,JSON.stringify(data)]);

// Pass former fail (supersede open finding) and fail former pass (new finding).
const amendment={
  responses:[
    {itemId:i,passed:true,comments:'Replaced',snapshot:{value:'good',label:'Front tyre'}},
    {itemId:i2,passed:false,comments:'Dim',snapshot:{value:'poor',label:'Headlight'}}
  ],
  evidence:[{itemId:i2,type:'photo',url:'https://example.com/light.jpg',caption:'Light'}],
  findings:[{itemId:i2,category:'Lights',finding:'Dim headlight',severity:'medium',actionRequired:'Replace bulb',expectedCompletionDate:'2026-11-15'}],
  status:'failed',score:55,summary:'Amended',odometerKm:110,sendEmail:false
};
await revise(amendment);

const snap=await db.query('select revision_no,snapshot from fleet_audit_revisions order by revision_no');
assert.equal(snap.rows.length,1);
assert.equal(snap.rows[0].revision_no,1);
assert.equal(snap.rows[0].snapshot.status,'failed');
assert.equal(snap.rows[0].snapshot.revision_count,0);

const audit=await db.query('select status,score,summary,revision_count,revised_by,revision_draft from fleet_audits where id=$1',[a]);
assert.equal(audit.rows[0].status,'failed');
assert.equal(Number(audit.rows[0].score),55);
assert.equal(audit.rows[0].summary,'Amended');
assert.equal(audit.rows[0].revision_count,1);
assert.equal(audit.rows[0].revised_by,u);
assert.deepEqual(audit.rows[0].revision_draft,{});

const findings=await db.query('select checklist_item_id,status,finding,resolution_note from fleet_audit_findings order by created_at,id');
const byItem=Object.fromEntries(findings.rows.map(r=>[r.checklist_item_id,r]));
assert.equal(byItem[i].status,'superseded');
assert.match(byItem[i].resolution_note||'',/Cleared by audit amendment/);
assert.equal(byItem[i2].status,'open');
assert.match(byItem[i2].finding,/Dim headlight/);

// Resolved finding with proof history stays resolved when item still fails.
await db.exec(`select set_config('fleet.audit_revision','1',true); update fleet_audit_findings set status='resolved', resolution_note='Closed with proof', resolved_at=now() where checklist_item_id='${i2}'; select set_config('fleet.audit_revision','0',true);`);
const keepResolved={
  responses:[
    {itemId:i,passed:true,comments:'',snapshot:{value:'good',label:'Front tyre'}},
    {itemId:i2,passed:false,comments:'Still dim',snapshot:{value:'poor',label:'Headlight'}}
  ],
  evidence:[{itemId:i2,type:'photo',url:'https://example.com/light2.jpg',caption:'Light'}],
  findings:[{itemId:i2,category:'Lights',finding:'Still dim',severity:'medium',actionRequired:'Replace bulb',expectedCompletionDate:'2026-11-16'}],
  status:'failed',score:50,summary:'Second amendment',odometerKm:111,sendEmail:false
};
await revise(keepResolved);
const second=await db.query('select revision_no from fleet_audit_revisions order by revision_no');
assert.equal(second.rows.length,2);
assert.equal(second.rows[1].revision_no,2);
const resolved=await db.query(`select status,resolution_note from fleet_audit_findings where checklist_item_id='${i2}' and status='resolved'`);
assert.equal(resolved.rows.length,1);
assert.match(resolved.rows[0].resolution_note,/Checklist amended while this finding stayed resolved/);
const audit2=await db.query('select revision_count from fleet_audits where id=$1',[a]);
assert.equal(audit2.rows[0].revision_count,2);

const grants=await db.query("select has_function_privilege('anon','fleet_revise_audit_v1(uuid,uuid,uuid,jsonb)','execute') as anon,has_function_privilege('authenticated','fleet_revise_audit_v1(uuid,uuid,uuid,jsonb)','execute') as authenticated");
assert.equal(grants.rows[0].anon,false);
assert.equal(grants.rows[0].authenticated,false);

await db.close();
console.log('Audit revisions: snapshot numbering, supersede open findings, preserve resolved+note, RPC grants passed.');
