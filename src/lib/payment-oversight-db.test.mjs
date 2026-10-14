import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

test('oversight migration grants read-only role access and atomically tracks handovers/stage age',async()=>{
  const db=new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table companies(id uuid primary key);
      create table app_pages(id uuid primary key default gen_random_uuid(),company_id uuid,code text,name text,sort_order int,is_active bool,unique(company_id,code));
      create table user_roles(id uuid primary key,company_id uuid,code text,is_active bool);
      create table role_page_permissions(company_id uuid,role_id uuid,page_id uuid,can_view bool,can_add bool,can_edit bool,unique(company_id,role_id,page_id));
      create table payment_requests(id uuid primary key,company_id uuid,created_at timestamptz default now(),updated_at timestamptz default now(),updated_by uuid,status text,approval_status text,current_approver_user_id uuid,current_approver_role_id uuid,current_step_order int);
      create table payment_request_approvals(id uuid primary key default gen_random_uuid(),company_id uuid,payment_request_id uuid,action text,created_at timestamptz default now());
      insert into companies values('00000000-0000-0000-0000-000000000001');
      insert into user_roles values
        ('00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000001','OPERATIONS_HLM',true),
        ('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000001','LOCATION',true);
      insert into payment_requests(id,company_id,created_at,status,approval_status,current_step_order) values('00000000-0000-0000-0000-000000000100','00000000-0000-0000-0000-000000000001','2026-10-12T08:00:00Z','pending','PENDING',1);
    `);
    await db.exec(readFileSync(new URL('../../supabase/migrations/20261014230000_payment_oversight_and_assignment_history.sql',import.meta.url),'utf8'));
    const grants=(await db.query('select r.code,g.can_view,g.can_add,g.can_edit from role_page_permissions g join user_roles r on r.id=g.role_id')).rows;
    assert.deepEqual(grants,[{code:'OPERATIONS_HLM',can_view:true,can_add:false,can_edit:false}]);
    assert.equal((await db.query('select approval_pending_since::text as since from payment_requests')).rows[0].since,'2026-10-12 08:00:00+00');
    await db.exec(`update payment_requests set current_approver_user_id='00000000-0000-0000-0000-000000000200',approval_routing_reason='Leave / acting cover: Cluster → AOM';`);
    assert.equal((await db.query('select approval_pending_since::text as since from payment_requests')).rows[0].since,'2026-10-12 08:00:00+00');
    let events=(await db.query('select reason,from_step,to_step,actor_user_id from payment_approval_routing_events')).rows;
    assert.equal(events.length,1);assert.equal(events[0].reason,'Leave / acting cover: Cluster → AOM');assert.equal(events[0].actor_user_id,null);
    await db.exec('update payment_requests set updated_at=now();');
    assert.equal((await db.query('select count(*)::int as n from payment_approval_routing_events')).rows[0].n,1);
    await db.exec(`insert into payment_request_approvals(company_id,payment_request_id,action) values('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000100','approved');`);
    assert.equal((await db.query('select approval_step_order from payment_request_approvals')).rows[0].approval_step_order,1);
    await db.exec('update payment_requests set current_step_order=3;');
    assert.notEqual((await db.query('select approval_pending_since::text as since from payment_requests')).rows[0].since,'2026-10-12 08:00:00+00');
    await db.exec(`update payment_requests set approval_status='FINAL_APPROVED',current_approver_user_id=null;`);
    assert.equal((await db.query('select approval_pending_since from payment_requests')).rows[0].approval_pending_since,null);
    assert.equal((await db.query('select relrowsecurity from pg_class where relname=\'payment_approval_routing_events\'')).rows[0].relrowsecurity,true);
    assert.equal((await db.query("select has_table_privilege('authenticated','payment_approval_routing_events','SELECT') as allowed")).rows[0].allowed,false);
    // Retiring the separate page must preserve permissions and routing history.
    await db.exec(`insert into app_pages(company_id,code,name,is_active) values('00000000-0000-0000-0000-000000000001','payment_approvals','Payment Approvals',true);`);
    const beforeGrants=(await db.query('select * from role_page_permissions')).rows;
    const beforeEvents=(await db.query('select * from payment_approval_routing_events')).rows;
    const retirement=readFileSync(new URL('../../supabase/migrations/20261014233000_inline_payment_request_tracking.sql',import.meta.url),'utf8');
    await db.exec(retirement);
    await db.exec(retirement); // Safe to reapply after a disconnected SQL editor.
    assert.deepEqual((await db.query('select code,is_active from app_pages order by code')).rows,[{code:'payment_approvals',is_active:true},{code:'payment_oversight',is_active:false}]);
    assert.deepEqual((await db.query('select * from role_page_permissions')).rows,beforeGrants);
    assert.deepEqual((await db.query('select * from payment_approval_routing_events')).rows,beforeEvents);
  } finally { await db.close(); }
});
