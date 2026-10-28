import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();
await db.exec(`create table portal_notification_controls(company_id uuid,portal text,event_key text,state text,paused_until timestamptz,subject_template text,body_template text,config jsonb,unique(company_id,portal,event_key));create table portal_digest_deliveries(id uuid,report_date date,event_key text);
create function portal_finish_digest(uuid,text,text,text) returns text language plpgsql as $$ declare v_delivery portal_digest_deliveries; begin select * into v_delivery from portal_digest_deliveries where id=$1; return to_char(v_delivery.report_date,'YYYY-MM'); end $$;`);
const sql=readFileSync('supabase/migrations/20261028181000_loss_stage_reminders.sql','utf8');await db.exec(sql);await db.exec(sql);
assert.equal((await db.query('select count(*)::int as n from portal_notification_controls')).rows[0].n,6);
for(const [day,event,expected] of [['2026-11-05','loss_reminder_recovery_morning','2026-10'],['2026-11-20','loss_reminder_recovery_afternoon','2026-11'],['2027-01-01','loss_reminder_recovery_morning','2026-12'],['2026-11-05','now_review_digest','2026-11']]){
 await db.exec('delete from portal_digest_deliveries');await db.query('insert into portal_digest_deliveries values($1,$2,$3)',['00000000-0000-0000-0000-000000000001',day,event]);assert.equal((await db.query("select portal_finish_digest('00000000-0000-0000-0000-000000000001','','','') as month")).rows[0].month,expected);
}
await db.close();console.log('PASS thread migration idempotency, six disabled controls and month boundaries');
