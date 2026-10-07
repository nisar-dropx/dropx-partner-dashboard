import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const db=new PGlite();
await db.exec(`create role anon;create role authenticated;create role service_role;
create table companies(id uuid primary key,name text);
create table finance_pricing_revisions(id uuid default gen_random_uuid(),company_id uuid,provider text,station_code text,effective_month date,revision int,rates jsonb,slabs jsonb,slab_mode text,reason text,source_file text);
create table cps_shipment_daily(id uuid,company_id uuid,source_batch_id uuid,station_code text,work_date date,provider_employee_id text,client text,total_delivery numeric,amazon_delivery numeric,swa_delivery numeric,c_return numeric,mfn numeric,updated_at timestamptz);
create table report_import_rows(id uuid,company_id uuid,source_type text,batch_id uuid,station_code text,work_date date,external_worker_id text,row_number int,normalized_data jsonb,raw_data jsonb);
create function finance_report_count(jsonb,jsonb,text,text[]) returns numeric language sql as $$select 0::numeric$$;
create table cps_fuel_daily(company_id uuid,station_code text,transaction_date date,created_at timestamptz);
create table cps_cashbook_daily(company_id uuid,station_code text,expense_date date,created_at timestamptz);
insert into companies values('00000000-0000-0000-0000-000000000001','DROPX LOGISTICS'),('00000000-0000-0000-0000-000000000002','Other tenant');
insert into finance_pricing_revisions(company_id,provider,station_code,effective_month,revision,rates,slabs,slab_mode) values
('00000000-0000-0000-0000-000000000001','Amazon','PARENT','2026-08-01',1,'{"variable_slab":"21"}','[]','progressive'),
('00000000-0000-0000-0000-000000000001','Amazon','CHILD','2026-08-01',1,'{"pricing_model":"xpt","parent_station_code":"PARENT"}','[]','progressive'),
('00000000-0000-0000-0000-000000000002','Amazon','OUTSIDE','2026-08-01',1,'{"variable_slab":"30"}','[]','progressive');
insert into cps_shipment_daily values(gen_random_uuid(),'00000000-0000-0000-0000-000000000001',gen_random_uuid(),'PARENT','2026-09-01','ID1','Amazon',15,10,5,0,0,now());`);
const sql=readFileSync('supabase/migrations/20261004195759_finance_live_pnl_sources.sql','utf8');
await db.exec(sql);
await db.exec(readFileSync('supabase/migrations/20261004205530_finance_pnl_scoped_query_plan.sql','utf8'));
const q=(await db.query(`select finance_pnl_revenue_snapshot('00000000-0000-0000-0000-000000000001','2026-09-01','2026-09-02',array['PARENT']) as r`)).rows[0].r;
assert.equal(q.daily_shipments[0].deliveries,'15');assert.equal(q.daily_shipments[0].swa,'5');assert.equal(q.availability.shipments.from,'2026-09-01');
const empty=(await db.query(`select finance_pnl_revenue_snapshot('00000000-0000-0000-0000-000000000001','2026-09-01','2026-09-02',array[]::text[]) as r`)).rows[0].r;
assert.deepEqual(empty.daily_shipments,[]);assert.equal(empty.availability.shipments.from,null);
const seeded=(await db.query(`select station_code,rates->>'swa_delivery_rate' as rate from finance_pricing_revisions where revision=2 order by station_code`)).rows;
assert.deepEqual(seeded,[{station_code:'CHILD',rate:'21'},{station_code:'PARENT',rate:'21'}]);
await db.exec(sql);assert.equal((await db.query('select count(*)::int n from finance_pricing_revisions')).rows[0].n,5);
// Reapply the optimized function last, then exercise current batch selection and duplicates.
await db.exec(readFileSync('supabase/migrations/20261007165321_finance_pnl_active_batch_lookup.sql','utf8'));
await db.exec(`create or replace function finance_report_count(jsonb,jsonb,text,text[]) returns numeric language sql as $$select ($1->>$3)::numeric$$;
update cps_shipment_daily set source_batch_id='00000000-0000-0000-0000-000000000010';
insert into report_import_rows
select gen_random_uuid(),'00000000-0000-0000-0000-000000000001','amazon_shipments',batch::uuid,'PARENT','2026-09-01','ID1',rn,details::jsonb,'{}' from (values
('00000000-0000-0000-0000-000000000010',1,'{"shipment_type":"delivery","smd_delivery":2,"smd2_delivery":3,"ihs":1}'),
('00000000-0000-0000-0000-000000000010',2,'{"shipment_type":"delivery","smd_delivery":999,"smd2_delivery":0,"ihs":999}'),
('00000000-0000-0000-0000-000000000010',3,'{"shipment_type":"return","smd_delivery":1,"smd2_delivery":1,"ihs":2}'),
('00000000-0000-0000-0000-000000000011',1,'{"shipment_type":"delivery","smd_delivery":888,"smd2_delivery":0,"ihs":888}')
) v(batch,rn,details);
insert into report_import_rows select gen_random_uuid(),'00000000-0000-0000-0000-000000000002',source_type,batch_id,station_code,work_date,external_worker_id,0,normalized_data,raw_data from report_import_rows where row_number=2;
`);
const optimized=(await db.query(`select finance_pnl_revenue_snapshot('00000000-0000-0000-0000-000000000001','2026-09-01','2026-09-02',array['PARENT']) r`)).rows[0].r;
assert.equal(optimized.daily_shipments[0].smd,'7');assert.equal(optimized.daily_shipments[0].ihs,'3');assert.equal(optimized.daily_shipments[0].deliveries,'15');
const noAccess=(await db.query(`select finance_pnl_revenue_snapshot('00000000-0000-0000-0000-000000000001','2026-09-01','2026-09-02',array[]::text[]) r`)).rows[0].r;assert.deepEqual(noAccess.daily_shipments,[]);
const security=(await db.query(`select prosecdef,has_function_privilege('anon',oid,'execute') anon,has_function_privilege('authenticated',oid,'execute') authenticated,has_function_privilege('service_role',oid,'execute') service from pg_proc where proname='finance_pnl_revenue_snapshot'`)).rows[0];
assert.deepEqual(security,{prosecdef:false,anon:false,authenticated:false,service:true});
console.log('SQL verified: station scope, shipment grain, parent SWA inheritance, tenant scope, idempotent revisions, invoker/service-only grants');await db.close();
