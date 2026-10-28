import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();
await db.exec(`create table nl_loss_sources(company_id uuid primary key,recovery_policy jsonb,updated_at timestamptz);
create table nl_loss_recoveries(company_id uuid,is_deleted boolean default false,recovery_mode text,allocations jsonb,installment_basis text,installment_value numeric,approval_status text);
insert into nl_loss_sources values ('43866344-b550-4e8a-9a2d-9d23f3d8a997','{}',now());`);
const sql=readFileSync('supabase/migrations/20261028180000_loss_installment_amount_rules.sql','utf8');
await db.exec(sql);await db.exec(sql);
async function insert(amount,count){return db.query(`insert into nl_loss_recoveries(company_id,recovery_mode,allocations,installment_basis,installment_value) values ('43866344-b550-4e8a-9a2d-9d23f3d8a997','installments',$1,'months',$2)`,[JSON.stringify([{ref:'employee:1',amount,installments:Array.from({length:count},(_,i)=>({n:i+1,amount:amount/count}))}]),count]);}
for(const [amount,count] of [[7000,2],[10000,3],[15000,4],[20000,5]]){await assert.rejects(insert(amount,count),/requires a recovery share above/);await insert(amount+.01,count);}
await db.exec(`update nl_loss_sources set recovery_policy = recovery_policy || '{"installment_two_month_min":9000}';`);
await db.exec(`update nl_loss_recoveries set approval_status='approved';`); // unchanged existing schedule is preserved
await assert.rejects(insert(8000,2),/requires a recovery share above/);
await db.exec(sql); // customized policy survives reapplication
assert.equal((await db.query(`select recovery_policy->>'installment_two_month_min' as value from nl_loss_sources`)).rows[0].value,'9000');
await db.close();console.log('PASS recurring recovery thresholds, boundaries, preservation and idempotency');
