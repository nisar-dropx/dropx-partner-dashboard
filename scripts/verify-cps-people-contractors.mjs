import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';
const modules=new Map();
function load(path){
 path=resolve(path);if(modules.has(path))return modules.get(path).exports;
 const m={exports:{}};modules.set(path,m);
 const js=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('exports','module','require',js)(m.exports,m,id=>load(resolve(dirname(path),id.endsWith('.ts')?id:`${id}.ts`)));
 return m.exports;
}
const {rebuildCps}=load('src/lib/ops-pulse/cps-engine.ts');
const db=new PGlite();
const company='00000000-0000-0000-0000-000000000001',outside='00000000-0000-0000-0000-000000000002';
const id=n=>`10000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
await db.exec(`
create role anon;create role authenticated;create role service_role;
create table employees(id uuid,company_id uuid,employee_code text,full_name text,email text,location_id uuid,date_of_join date,last_working_date date,is_active bool,deleted_at timestamptz,designation_id uuid);
create table contractors(id uuid,company_id uuid,dropx_id text,full_name text,email text,location_id uuid,date_of_join date,last_working_date date,is_active bool,deleted_at timestamptz,designation text);
create table designations(id uuid,company_id uuid,code text,name text);
create table ops_cps_people_policies(company_id uuid,designation_code text,designation_name text,mode text,head text,label text,allocation text,effective_from date,updated_at timestamptz);
create table hr_engagements(id uuid,company_id uuid,employee_id uuid,contractor_id uuid,person_id uuid,start_date date,end_date date,status text);
create table hr_work_assignments(id uuid,company_id uuid,engagement_id uuid,location_id uuid,effective_from date,effective_to date);
create table station_responsibility_assignments(company_id uuid,station_id uuid,assignment_id uuid,assignee_user_id uuid,effective_from timestamptz,effective_to timestamptz,is_primary bool);
create table hr_user_person_links(company_id uuid,person_id uuid,user_id uuid,status text);
create table stations(id uuid,company_id uuid,station_code text,is_active bool,hide_from_location_list bool,is_ho bool);
create table hr_employee_salary_assignments(id uuid,company_id uuid,employee_id uuid,effective_from date,effective_to date);
create table hr_employee_salary_values(assignment_id uuid,company_id uuid,payroll_head_id uuid,amount numeric);
create table hr_payroll_heads(id uuid,company_id uuid,head_type text);
create table hr_contractor_pay_profiles(id uuid,company_id uuid,contractor_id uuid,effective_from date,effective_to date,payment_basis text,base_amount numeric);
create table cps_shipment_daily(company_id uuid,station_code text,work_date date,total_delivery numeric);
insert into stations values('${id(1)}','${company}','A',true,false,false),('${id(2)}','${company}','B',true,false,false);
insert into designations values('${id(3)}','${company}','SSA','Station Support Associate'),('${id(4)}','${company}','TL','Team Lead');
insert into ops_cps_people_policies values('${company}','SSA','Station Support Associate','home','UTR','Station team','equal','2026-01-01',null),('${company}','TL','Team Lead','home','UTR','Station team','equal','2026-01-01',null);
insert into employees values('${id(5)}','${company}','E1','Private employee','', '${id(1)}','2026-01-01',null,true,null,'${id(3)}');
insert into hr_employee_salary_assignments values('${id(6)}','${company}','${id(5)}','2026-01-01',null);
insert into hr_payroll_heads values('${id(7)}','${company}','ctc');
insert into hr_employee_salary_values values('${id(6)}','${company}','${id(7)}',30000);
insert into contractors values
('${id(10)}','${company}','C1','Private contractor','', '${id(1)}','2026-01-01',null,true,null,'Station Support Associate'),
('${id(11)}','${company}','C2','Former contractor','', '${id(1)}','2026-01-01','2026-09-01',false,null,'Team Lead'),
('${id(12)}','${company}','C3','No compensation','', '${id(1)}','2026-01-01',null,true,null,'SSA'),
('${id(13)}','${company}','C4','Inactive contractor','', '${id(1)}','2026-01-01',null,false,null,'SSA'),
('${id(14)}','${outside}','X1','Outside tenant','', '${id(1)}','2026-01-01',null,true,null,'SSA');
insert into hr_contractor_pay_profiles values
('${id(20)}','${company}','${id(10)}','2026-01-01',null,'monthly',15000),
('${id(21)}','${company}','${id(11)}','2026-01-01',null,'monthly',24000),
('${id(23)}','${company}','${id(13)}','2026-01-01',null,'monthly',99000),
('${id(24)}','${outside}','${id(14)}','2026-01-01',null,'monthly',99000);
insert into hr_engagements values('${id(30)}','${company}',null,'${id(10)}','${id(31)}','2026-01-01',null,'active');
insert into hr_work_assignments values('${id(40)}','${company}','${id(30)}','${id(1)}','2026-01-01','2026-09-01'),('${id(41)}','${company}','${id(30)}','${id(2)}','2026-09-02',null);
`);
await db.exec(readFileSync('supabase/migrations/20261004211241_cps_people_contractor_costs.sql','utf8'));
const rpc=async()=> (await db.query(`select ops_cps_people_assignments('${company}','2026-09-01','2026-09-02') r`)).rows[0].r;
const data=await rpc();
await db.exec(readFileSync('supabase/migrations/20261005001500_cps_station_team_assignments.sql','utf8'));
assert.deepEqual(await rpc(),data,'Later migration replay must retain contractor costs');
assert.equal(data.employees.length,5);assert.equal(data.salaries.length,4);
assert.equal(data.assignments.filter(x=>x.employee_id===id(10)).length,2);
const dates=['2026-09-01','2026-09-02'];
const daily=['A','B'].flatMap(station_code=>dates.map(work_date=>({station_code,work_date,deliveries:100,activity:100,shipment_present:true})));
const policies=(await db.query('select jsonb_agg(p) rows from ops_cps_people_policies p')).rows[0].rows;
const stationRows=(await db.query('select * from stations')).rows;
const facts={...data,shipments:[],mappings:[],workforce:[],components:[],providers:[],people_rules:[],stations:stationRows,people_policies:policies,people_assignments:data.assignments,attendance:[]};
let evidence;
const result=rebuildCps({daily,breakup:[],generated_at:'now'},facts,value=>{evidence=value;});
assert.equal(evidence.staff.reduce((sum,d)=>sum+d.amount,0),3800);
assert.ok(evidence.staff.some(d=>d.name==='Private contractor'));
assert.ok(evidence.staff.every(d=>d.station_code==='A'||d.station_code==='B'));
assert.ok(!('evidence' in result));
// Employee 1000/day, contractor 500/day with transfer, ex-TL 800 on final day.
assert.deepEqual(result.daily.map(d=>d.utr),[2300,1000,0,500]);
assert.equal(result.staff.reduce((sum,s)=>sum+s.amount,0),3800);
assert.ok(result.gaps.some(g=>g.kind==='People CTC missing'&&g.station_code==='A'));
assert.ok(result.gaps.every(g=>g.name===''&&g.dropx_id===''));
const publicResult=JSON.stringify(result);for(const name of ['Private employee','Private contractor','Former contractor','C1','C2','C3'])assert.ok(!publicResult.includes(name),name);
// Roster/engagement progress cannot remove an otherwise active People profile.
await db.exec(`update hr_engagements set status='roster_pending'`);
assert.deepEqual(await rpc(),data);
// Non-monthly pay is not silently treated as a monthly CTC.
await db.exec(`update hr_contractor_pay_profiles set payment_basis='daily' where contractor_id='${id(10)}'`);
assert.equal((await rpc()).salaries.find(s=>s.employee_id===id(10)).monthly_ctc,null);
const security=(await db.query(`select prosecdef,has_function_privilege('anon',oid,'execute') anon,has_function_privilege('authenticated',oid,'execute') authenticated,has_function_privilege('service_role',oid,'execute') service from pg_proc where proname='ops_cps_people_assignments'`)).rows[0];
assert.deepEqual(security,{prosecdef:false,anon:false,authenticated:false,service:true});
console.log('People CPS verified: employee + contractor costs, historical exits, base-location transfers, no roster/attendance dependency, missing pay, tenant isolation, salary privacy and service-only access.');
await db.close();
