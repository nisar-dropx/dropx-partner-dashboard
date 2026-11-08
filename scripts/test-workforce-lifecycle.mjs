import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const db=new PGlite();
const co='00000000-0000-0000-0000-000000000001', person='00000000-0000-0000-0000-000000000002',station='00000000-0000-0000-0000-000000000003',actor='00000000-0000-0000-0000-000000000004';
await db.exec(`create role anon; create role authenticated; create role service_role;
create table profiles(id uuid,company_id uuid,is_active boolean);
create table stations(id uuid,company_id uuid,station_code text);
create table designations(id uuid,provider_mapping_required boolean);
create table workforce(id uuid primary key,company_id uuid,dropx_id text,full_name text,mobile text,mobile_country_code text,location_id uuid,designation_id uuid,
 onboarding_status text,lifecycle_status text,is_active boolean,updated_at timestamptz default now(),created_at timestamptz default now(),
 provider_employee_id text,provider_id_status text,biometric_id text,source_profile_id uuid,migration_state text default 'canonical',
 deleted_at timestamptz,profile_returned_at timestamptz,onboarding_submitted_at timestamptz,onboarding_reviewed_at timestamptz,onboarding_approved_at timestamptz,onboarding_activated_at timestamptz,
 email text,deactivated_at timestamptz,deactivated_by uuid,last_working_date date);
create table cps_shipment_daily(company_id uuid,station_code text,work_date date,dropx_emp_code text,total_activity numeric);
create table workforce_payout_shipment_facts(company_id uuid,provider_employee_id text,station_code text,work_date date,total_delivery numeric,total_activity numeric);
create table field_executive_provider_mappings(company_id uuid,workforce_id uuid,provider_member_id text,station_id uuid,status text,effective_from date,effective_to date,updated_at timestamptz);
create table workforce_onboarding_events(company_id uuid,workforce_id uuid,field_executive_id uuid,event_code text);
create table workforce_amazon_email_pilot_candidates(company_id uuid,alias_email text);
create table workforce_payment_allocations(company_id uuid,workforce_id uuid,status text,transition_restore_state jsonb);
create table mob_app_registration_drafts(company_id uuid,account_id uuid,updated_at timestamptz);
create table workforce_amazon_invitation_requests(company_id uuid,workforce_id uuid);
create table hr_leave_requests(company_id uuid,requested_profile_id uuid,contractor_id uuid,status text,end_date date);
create table workforce_lifecycle_cases(company_id uuid,profile_id uuid,field_executive_id uuid,status text);
create table attendance_daily(company_id uuid,workforce_id uuid,field_executive_id uuid,contractor_id uuid,punch_count integer,punch_date date,employee_code text);
insert into stations values('${station}','${co}','TEST'); insert into designations values('${station}',true);
insert into profiles values('${actor}','${co}',true);
insert into workforce(id,company_id,dropx_id,full_name,mobile,location_id,designation_id,onboarding_status,lifecycle_status,is_active,created_at)
 values('${person}','${co}','TEST1','Test associate','9999999999','${station}','${station}','pending','onboarding',true,now()-interval '16 days');`);
const migration=fs.readFileSync('supabase/migrations/20261108113505_workforce_lifecycle_control.sql','utf8');
await db.exec(migration);await db.exec(migration);
async function audit(){return (await db.query(`select x from workforce_lifecycle_audit('${co}') x`)).rows[0].x;}
async function transition(action,automatic=false,override={}){const r=await audit();return db.query(`select workforce_lifecycle_transition($1,$2,$3,$4,$5,$6,$7,$8) x`,[co,person,action,actor,'Lifecycle test reason',override.updated_at||r.updated_at,override.version??r.version,automatic]);}
assert.equal((await audit()).queue,'registration_overdue');
await db.exec(`update workforce set onboarding_submitted_at=now()`);assert.equal((await audit()).queue,'registration_exception');
await assert.rejects(()=>transition('offboard',true),/eligibility changed/);
await db.exec(`update workforce set onboarding_submitted_at=null;insert into mob_app_registration_drafts values('${co}','${person}',now())`);
assert.equal((await audit()).queue,'registration_exception');await db.exec('delete from mob_app_registration_drafts');
await db.exec('update workforce set is_active=false');assert.equal((await audit()).queue,'registration_overdue');
await transition('offboard',true);assert.equal((await audit()).queue,'offboarded');
await db.exec("update workforce set is_active=true,lifecycle_status='active'");assert.equal((await audit()).control_status,'offboarded');assert.equal((await audit()).is_active,false);
await assert.rejects(()=>transition('reactivate'),/Only inactive/);
await assert.rejects(()=>transition('rejoin',false,{version:0}),/Lifecycle changed/);
await transition('rejoin');assert.equal((await audit()).queue,'current');assert.equal((await audit()).onboarding_status,'pending');
assert.equal((await db.query('select count(*)::int n from workforce')).rows[0].n,1);
await db.exec(`update workforce set onboarding_status='active',lifecycle_status='active',onboarding_submitted_at=now();
update workforce_status_controls set status='active',rejoined_at=now()-interval '40 days';
insert into field_executive_provider_mappings values('${co}','${person}','AMZ1','${station}','active',current_date-100,null,now());
insert into workforce_payout_shipment_facts values('${co}','AMZ1','TEST',current_date-40,1,1);`);
assert.equal((await audit()).queue,'delivery_exception');
await db.exec(`insert into cps_shipment_daily select '${co}','TEST',(now() at time zone 'Asia/Kolkata')::date-n,null,1 from generate_series(1,30)n`);
assert.equal((await audit()).queue,'delivery_inactive');
await db.exec(`insert into attendance_daily values('${co}','${person}',null,null,1,current_date-1,null)`);
assert.equal((await audit()).queue,'delivery_exception');await db.exec('delete from attendance_daily');
await transition('inactivate',true);assert.equal((await audit()).queue,'inactive');
await transition('reactivate');assert.equal((await audit()).queue,'current');
await assert.rejects(()=>db.exec('delete from workforce_status_events'),/append-only/);
await db.exec('set role authenticated');await assert.rejects(()=>db.query(`select workforce_lifecycle_audit('${co}')`),/permission denied/);await db.exec('reset role');
assert.equal((await db.query('select count(*)::int n from workforce_status_events')).rows[0].n,4);
console.log('PASS: repeat migration, overdue/response protection, stale feeds, attendance, inactivity, rejoin identity, version conflicts, late sync guard, RLS, immutable history');
await db.close();
