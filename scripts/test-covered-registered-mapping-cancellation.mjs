import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const db = new PGlite();
const co='00000000-0000-0000-0000-000000000001';
const worker='00000000-0000-0000-0000-000000000002';
const station='00000000-0000-0000-0000-000000000003';
const otherStation='00000000-0000-0000-0000-000000000004';
const provider='00000000-0000-0000-0000-000000000005';
const old='00000000-0000-0000-0000-000000000010';
await db.exec(`
create role anon; create role authenticated; create role service_role;
create table workforce(id uuid,company_id uuid,location_id uuid,deleted_at timestamptz,migration_state text);
create table field_executive_provider_mappings(id uuid primary key,company_id uuid,workforce_id uuid,
 station_id uuid,provider_id uuid,provider_member_id text,field_executive_id uuid,employee_id uuid,
 contractor_id uuid,status text,effective_from date,effective_to date,updated_at timestamptz,reason text);
create function workforce_provider_mapping_person(uuid,uuid,uuid,uuid,uuid) returns uuid
 language sql immutable as $$select coalesce($2,$3,$4,$5)$$;
create function workforce_provider_mapping_period_covered(p_company uuid,p_workforce uuid,p_station uuid,
 p_provider uuid,p_member text,p_from date,p_to date) returns boolean language sql stable as $$
 select case when p_from is null or (p_to is not null and p_to<p_from) then false else coalesce((
 select range_agg(daterange(m.effective_from,m.effective_to,'[]')) @> daterange(p_from,p_to,'[]')
 from public.field_executive_provider_mappings m where m.company_id=p_company and m.station_id=p_station
 and m.provider_id=p_provider and upper(btrim(m.provider_member_id))=upper(btrim(p_member))
 and ((m.status='active' and m.effective_to is null) or (m.status='closed' and m.effective_to is not null))
 and public.workforce_provider_mapping_person(m.company_id,m.workforce_id,m.field_executive_id,m.employee_id,m.contractor_id)=p_workforce
 ),false) end $$;
create function workforce_assert_provider_mapping_registered_location(uuid,uuid) returns void
 language plpgsql as $$begin raise exception 'full coverage validation invoked'; end$$;
insert into workforce values('${worker}','${co}','${station}',null,'canonical');
`);
const migration=fs.readFileSync('supabase/migrations/20261106160343_allow_covered_registered_mapping_cancellation.sql','utf8');
await db.exec(migration); await db.exec(migration);
await db.exec(`create constraint trigger registered_guard after update on field_executive_provider_mappings
 deferrable initially deferred for each row execute function workforce_provider_mapping_registered_location_guard()`);
let seq=20;
async function add({id,location=station,from='2026-10-01',to='2026-10-31',member='P1',providerId=provider,
 owner=worker,status='closed'}={}) {
 id??=`00000000-0000-0000-0000-${String(seq++).padStart(12,'0')}`;
 await db.query(`insert into field_executive_provider_mappings
 (id,company_id,workforce_id,station_id,provider_id,provider_member_id,status,effective_from,effective_to)
 values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,co,owner,location,providerId,member,status,from,to]);
}
async function setup() {
 await db.exec('truncate field_executive_provider_mappings');
 await add({id:old,to:'2026-10-01'});
 await add({location:otherStation});
}
async function cancel(allowed) {
 try {
  await db.exec(`begin; update field_executive_provider_mappings set status='cancelled',updated_at=now()
   where id='${old}'; set constraints all immediate; commit;`);
  assert.ok(allowed,'An uncovered cancellation must be rejected');
 } catch(error) {
  await db.exec('rollback');
  if(allowed) throw error;
  assert.match(error.message,/registered-location mapping cannot be removed/);
 }
 const status=(await db.query('select status from field_executive_provider_mappings where id=$1',[old])).rows[0].status;
 assert.equal(status,allowed?'cancelled':'closed');
}
await setup(); await add(); await cancel(true);
await setup(); await cancel(false);
await setup(); await add({from:'2026-10-02'}); await cancel(false);
await setup(); await add({member:'P2'}); await cancel(false);
await setup(); await add({providerId:'00000000-0000-0000-0000-000000000099'}); await cancel(false);
await setup(); await add({owner:'00000000-0000-0000-0000-000000000099'}); await cancel(false);
await setup(); await add({status:'cancelled'}); await cancel(false);
await setup(); await add({status:'active'}); await cancel(true);
await setup(); await add({status:'active',from:'2026-10-02',to:'2026-10-01'}); await cancel(false);
await setup(); await add({status:'active',to:null}); await cancel(true);
// Adjacent surviving periods may collectively cover a longer removed interval.
await db.exec('truncate field_executive_provider_mappings');
await add({id:old}); await add({location:otherStation}); await add({to:'2026-10-15'});
await add({from:'2026-10-16'}); await cancel(true);
// A one-day gap is not complete coverage.
await db.exec('truncate field_executive_provider_mappings');
await add({id:old}); await add({location:otherStation}); await add({to:'2026-10-14'});
await add({from:'2026-10-16'}); await cancel(false);
// Additional-location cancellation remains allowed; other edits still use the full invariant.
await db.exec('truncate field_executive_provider_mappings');
await add({id:old,location:otherStation}); await cancel(true);
await setup();
await assert.rejects(db.exec(`begin; update field_executive_provider_mappings set reason='changed' where id='${old}';
 set constraints all immediate; commit;`),/full coverage validation invoked/);
await db.exec('rollback');
await db.close();
console.log('Covered registered mapping cancellation: 14 coverage/identity/gap/lifecycle/invariant cases passed; migration applied twice.');
