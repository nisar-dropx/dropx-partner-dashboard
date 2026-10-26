import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();
const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
await db.exec(`
create role service_role;create role anon;create role authenticated;
create table location_models(id uuid primary key,code text);
create table stations(id uuid primary key,company_id uuid,station_code text,station_name text,parent_station_id uuid,location_model_id uuid);
create table designations(id uuid primary key,company_id uuid,code text,name text);
create table employees(id uuid primary key,company_id uuid,employee_code text,full_name text,designation_id uuid,location_id uuid,is_active boolean default true,deleted_at timestamptz);
create table workforce(id uuid primary key,company_id uuid,dropx_id text,full_name text,designation text,location_id uuid,is_active boolean default true,deleted_at timestamptz);
create table hr_people(id uuid primary key,company_id uuid,status text default 'active');
create table hr_engagements(id uuid primary key,company_id uuid,person_id uuid,employee_id uuid,status text default 'active',start_date date default '2020-01-01',end_date date);
create table hr_work_assignments(id uuid primary key,company_id uuid,engagement_id uuid,location_id uuid,designation_id uuid,position_title text,is_primary boolean default true,effective_from date default '2020-01-01',effective_to date);
create table hr_reporting_relationships(id uuid primary key,company_id uuid,subject_assignment_id uuid,manager_assignment_id uuid,relationship_type text default 'solid_line',is_primary boolean default true,effective_from date default '2020-01-01',effective_to date);
create table station_responsibility_roles(id uuid primary key,company_id uuid,is_active boolean default true,owning_product_code text default 'operations');
create table station_responsibility_assignments(id uuid primary key,company_id uuid,station_id uuid,assignment_id uuid,assignee_user_id uuid,responsibility_role_id uuid,is_primary boolean default true,effective_from timestamptz default '2020-01-01',effective_to timestamptz);
create table hr_user_person_links(company_id uuid,person_id uuid,user_id uuid,status text default 'active');
create table profiles(id uuid primary key,company_id uuid,employee_id text);
`);
const audit=readFileSync('supabase/migrations/20261005173417_audit_shipment_reconciliation.sql','utf8');
await db.exec(audit.slice(audit.indexOf('create or replace function public.station_audit_employee_directory'),audit.indexOf('-- A complete station response')));
// The migration patches every recovery writer overload; exercise its directory lookup.
await db.exec(`create function save_nl_recovery(p_company uuid,station uuid,person_ref text) returns text language plpgsql as $$ declare person jsonb;begin select to_jsonb(d) into person from station_audit_employee_directory(p_company,station)d where d.ref=person_ref;if person is null then raise exception 'Selected employee is not linked to this station.';end if;return person->>'employee_code';end $$;`);
const migration=readFileSync('supabase/migrations/20261026212000_loss_recovery_linked_station_people.sql','utf8');
await db.exec(migration);await db.exec(migration);
await db.exec(`insert into location_models values('${id(10)}','EDSP'),('${id(11)}','XPT'),('${id(12)}','OTHER');
insert into stations values
('${id(20)}','${id(1)}','PARENT','Parent station',null,'${id(10)}'),
('${id(21)}','${id(1)}','XPT1','First XPT','${id(20)}','${id(11)}'),
('${id(22)}','${id(1)}','XPT2','Second XPT','${id(20)}','${id(11)}'),
('${id(23)}','${id(1)}','OTHER','Unrelated child','${id(20)}','${id(12)}'),
('${id(24)}','${id(2)}','FOREIGN','Foreign XPT','${id(20)}','${id(11)}'),
('${id(25)}','${id(1)}','HO','Head office',null,'${id(12)}');
insert into designations values('${id(30)}','${id(1)}','TL','Team Leader'),('${id(31)}','${id(1)}','CLM','Cluster Manager'),('${id(32)}','${id(1)}','AOM','Area Operations Manager'),('${id(33)}','${id(1)}','NH','National Head');
`);
async function employee(n,station,role=30){
 await db.exec(`insert into employees(id,company_id,employee_code,full_name,designation_id,location_id) values('${id(n)}','${id(1)}','E${n}','Person ${n}','${id(role)}','${id(station)}');
 insert into hr_people(id,company_id) values('${id(n+100)}','${id(1)}');
 insert into hr_engagements(id,company_id,person_id,employee_id) values('${id(n+200)}','${id(1)}','${id(n+100)}','${id(n)}');
 insert into hr_work_assignments(id,company_id,engagement_id,location_id,designation_id) values('${id(n+300)}','${id(1)}','${id(n+200)}','${id(station)}','${id(role)}');`);
}
await employee(1000,20);await employee(1001,21);await employee(1002,22);await employee(1003,23);
await employee(1010,25,31);await employee(1011,25,32);await employee(1012,25,33);await employee(1013,25,31);
await db.exec(`insert into workforce(id,company_id,dropx_id,full_name,designation,location_id) values('${id(2000)}','${id(1)}','W1','Parent DA','DA','${id(20)}'),('${id(2001)}','${id(1)}','W2','XPT DA','DA','${id(21)}');
insert into hr_reporting_relationships(id,company_id,subject_assignment_id,manager_assignment_id) values
('${id(3000)}','${id(1)}','${id(1300)}','${id(1310)}'),('${id(3001)}','${id(1)}','${id(1301)}','${id(1310)}'),('${id(3002)}','${id(1)}','${id(1302)}','${id(1310)}'),('${id(3003)}','${id(1)}','${id(1310)}','${id(1311)}'),('${id(3004)}','${id(1)}','${id(1311)}','${id(1312)}'),('${id(3005)}','${id(1)}','${id(1312)}','${id(1310)}');`);
const directory=async(station,company=1)=>(await db.query('select * from nl_recovery_employee_directory($1,$2)',[id(company),id(station)])).rows;
let parent=await directory(20);
assert.deepEqual(parent.map(p=>p.employee_code).sort(),['E1000','E1001','E1002','E1010','E1011','W1','W2']);
assert.deepEqual(await directory(21),parent,'XPT and parent expose the same team');
assert.deepEqual(await directory(22),parent,'sibling XPT belongs to the same parent team');
assert.match(parent.find(p=>p.employee_code==='E1001').locations,/XPT1 · First XPT/);
assert.equal(parent.filter(p=>p.employee_code==='E1010').length,1,'shared CLM is deduplicated');
assert.match(parent.find(p=>p.employee_code==='E1010').locations,/PARENT/);
assert.equal((await directory(20,2)).length,0,'company mismatch cannot expand a team');
assert.equal((await directory(999)).length,0,'unknown station fails closed');
assert.equal((await directory(23)).some(p=>p.employee_code==='E1000'),false,'non-XPT child does not inherit parent team');
assert.equal((await db.query('select save_nl_recovery($1,$2,$3) code',[id(1),id(20),`employee:${id(1001)}`])).rows[0].code,'E1001','database accepts linked XPT staff');
assert.equal((await db.query('select save_nl_recovery($1,$2,$3) code',[id(1),id(21),`employee:${id(1011)}`])).rows[0].code,'E1011','database accepts mapped AOM');
await assert.rejects(db.query('select save_nl_recovery($1,$2,$3)',[id(1),id(20),`employee:${id(1003)}`]),/not linked/);
// Explicit current operational responsibility supersedes an old local manager chain.
await db.exec(`insert into station_responsibility_roles(id,company_id) values('${id(4000)}','${id(1)}');
insert into station_responsibility_assignments(id,company_id,station_id,assignment_id,responsibility_role_id) select gen_random_uuid(),'${id(1)}',s.id,'${id(1313)}','${id(4000)}' from stations s where s.id in ('${id(20)}','${id(21)}','${id(22)}');`);
parent=await directory(20);
assert(parent.some(p=>p.employee_code==='E1013'));
assert(!parent.some(p=>['E1010','E1011'].includes(p.employee_code)),'former reporting managers removed');
assert.equal((await db.query("select has_function_privilege('authenticated','nl_recovery_employee_directory(uuid,uuid)','execute') allowed")).rows[0].allowed,false);
assert.equal((await db.query('select count(*) n from station_audit_employee_directory($1,$2)',[id(1),id(21)])).rows[0].n,3,'audit directory stays local (one employee, mapped manager, DA)');
console.log('PASS parent/XPT bidirectional directory, sibling team, CLM/AOM chain, cycle guard, explicit responsibility, deduplication, company isolation, database validation, unchanged audit scope and apply-twice migration');
await db.close();
