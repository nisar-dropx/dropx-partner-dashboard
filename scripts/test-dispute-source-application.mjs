import {readFileSync} from 'node:fs';
export async function testDisputeApplication(db,{C,S,A1,A2,ok}) {
 await db.exec(`
 create table if not exists workforce(id uuid primary key,company_id uuid);
 alter table workforce_payout_payment_items add column settled_amount numeric default 0;
 create table payment_fields(id uuid primary key,company_id uuid,code text,is_active boolean);
 create table nl_loss_sources(company_id uuid,recovery_policy jsonb);
 create table nl_loss_month_cases(company_id uuid,month text,case_key text,report text,station_code text,source_status text,source_present boolean,amount numeric,lifecycle_status text,final_seen_at timestamptz);
 create table nl_loss_recoveries(company_id uuid,month text,case_key text,allocations jsonb,source_amount numeric,approval_status text,is_deleted boolean default false,deduction_timing text,deduction_month text,cap_override boolean default false,recovery_mode text,outcome_label text,assigned_at timestamptz,updated_by_name text);
 create table nl_recovery_waivers(company_id uuid,month text,case_key text,employee_ref text,amount numeric,reason text,decided_by_name text);
 create table nl_case_response_windows(company_id uuid,month text,case_key text,enabled boolean,workflow_status text,recovery_month text);
 create table nl_loss_recovery_events(company_id uuid,month text,case_key text,before_value jsonb,after_value jsonb,actor_id uuid,actor_name text);
 create table applied_keys(recovery_key text,month text,finalized boolean);
 create table input_batches(id uuid default gen_random_uuid(),rows jsonb);
 create table refresh_requests(workforce_id uuid);
 create function nl_recovery_key(text,text,text) returns text language sql immutable as $$select $1||'|'||$2||'|'||$3$$;
 create function nl_recovery_person_exit(uuid,text) returns date language sql as $$select null::date$$;
 create function nl_case_recoverable(uuid,text,text) returns boolean language sql as $$select $2='slp' or $3='Recoverable'$$;
 create function loss_recovery_open_payroll(uuid,text,text) returns boolean language sql as $$select false$$;
 create function nl_recovery_line_applied(uuid,text,uuid default null,date default null,boolean default false) returns text language sql as $$select month from public.applied_keys where recovery_key=$2 and (not $5 or finalized) limit 1$$;
 create function nl_recovery_bump_payout_months(uuid,text[]) returns void language sql as $$select$$;
 create function enqueue_workforce_payout_dependency_refresh(uuid,uuid,uuid,date,date,uuid) returns void language sql as $$insert into public.refresh_requests values($2)$$;
 create function workforce_apply_payout_import(uuid,date,date,text,text,jsonb,uuid,uuid[]) returns uuid language plpgsql as $$declare b uuid;begin insert into public.input_batches(rows) values($6) returning id into b;return b;end$$;
 `);
 const allocs=readFileSync('supabase/migrations/20261030131516_loss_recent_departed_recovery.sql','utf8').split('create or replace function public.nl_recovery_alloc_keys')[1].split('do $migration$')[0];
 await db.exec('create or replace function public.nl_recovery_alloc_keys'+allocs);
 const migration=readFileSync('supabase/migrations/20261107150000_dispute_source_application.sql','utf8');
 await db.exec(migration);await db.exec(migration);ok('Source application migration applies twice',true);
 await db.query('insert into nl_loss_sources values($1,$2)',[C,JSON.stringify({payroll_start_month:'2026-10'})]);
 let seq=5000;
 const uuid=()=>`00000000-0000-0000-0000-${String(++seq).padStart(12,'0')}`;
 const fixture=async(treatment='outstanding',selector='deduction',bank=false)=>{
  const W=uuid(),P=uuid(),D=uuid(),key=`2026-09|TID${seq}|workforce:${W}`,tid=key.split('|')[1];
  const item=selector==='deduction'?{selector,code:'LOSS_RECOVERY',recovery_key:key,current_value:1000,proposed_value:500}:{selector:'attendance',code:'attendance',date:'2026-10-10',current_value:0,proposed_value:1};
  const snapshot={item:{net_amount:10000,dropx_id:'TEST'},worksheet:{deduction_breakdown:[{code:'LOSS_RECOVERY',amount:1000,recoveryKey:key}]},lines:[{work_date:'2026-10-10',calculation_snapshot:{workDayUnits:0}}]};
  await db.query('insert into workforce values($1,$2)',[W,C]);
  await db.query(`insert into workforce_payout_publications(id,company_id,workforce_id,station_id,revision,snapshot,period_start,period_end,publication_kind) values($1,$2,$3,$4,1,$5,'2026-10-01','2026-10-31','worksheet')`,[P,C,W,S,JSON.stringify(snapshot)]);
  if(bank)await db.query(`insert into workforce_payout_payment_items(company_id,workforce_id,period_start,period_end,location_id_snapshot,status) values($1,$2,'2026-10-01','2026-10-31',$3,'processing')`,[C,W,S]);
  const plan={schema:3,items:[item],expected_delta_paise:50000};
  await db.query(`insert into workforce_payout_disputes(id,company_id,publication_id,workforce_id,station_id,category,reason,status,correction_plan,initial_reviewed_by,final_approved_by,final_approved_by_name,details) values($1,$2,$3,$4,$5,'loss','Fixture only','approved_for_processing',$6,$7,$8,'Finance test','{}')`,[D,C,P,W,S,JSON.stringify(plan),A1,A2]);
  await db.query(`insert into nl_loss_month_cases values($1,'2026-09',$2,'nl','TEST','Recoverable',true,1000,'recovery_approved_scheduled',now())`,[C,tid]);
  await db.query(`insert into nl_loss_recoveries(company_id,month,case_key,allocations,source_amount,approval_status,deduction_timing,deduction_month,recovery_mode) values($1,'2026-09',$2,$3,1000,'approved','current_month','2026-10','full')`,[C,tid,JSON.stringify([{ref:`workforce:${W}`,amount:1000,employee_code:'TEST'}])]);
  return {W,P,D,key,tid,item,plan,snapshot,treatment};
 };
 const queue=async f=>(await db.query('select workforce_queue_dispute_application($1,$2,$3)',[C,f.D,JSON.stringify({treatment:f.treatment,reason:'Evidence checked by Finance.'})]));
 const apply=async f=>(await db.query('select workforce_apply_approved_dispute($1,$2) j',[C,f.D])).rows[0].j;
 const ledger=async f=>(await db.query('select * from nl_recovery_ledger($1,null,$2)',[C,`workforce:${f.W}`])).rows[0];
 const verify=async f=>(await db.query('select workforce_verify_dispute_application($1,$2) j',[C,f.D])).rows[0].j;
 const publish=async(f,net,amount=500)=>{
  const snapshot=structuredClone(f.snapshot);snapshot.item.net_amount=net;snapshot.worksheet.deduction_breakdown[0].amount=amount;
  const P=uuid();await db.query(`insert into workforce_payout_publications(id,company_id,workforce_id,station_id,revision,snapshot,period_start,period_end,publication_kind) values($1,$2,$3,$4,2,$5,'2026-10-01','2026-10-31','worksheet')`,[P,C,f.W,S,JSON.stringify(snapshot)]);return P;
 };
 for(const treatment of ['outstanding','write_off']){
  const f=await fixture(treatment);await queue(f);const applied=await apply(f);
  ok(`${treatment}: sources applied`,applied.state==='awaiting_publication');
  if(applied.state!=='awaiting_publication')throw Error(applied.last_error);
  let l=await ledger(f);ok(`${treatment}: original month and original total retained`,l.month==='2026-09'&&Number(l.total)===1000);
  ok(`${treatment}: write-off never counted as recovered`,Number(l.deducted)===0&&Number(l.waived)===(treatment==='write_off'?500:0)&&Number(l.outstanding)===(treatment==='write_off'?500:1000));
  const due=(await db.query(`select amount from nl_loss_recovery_due($1,'2026-10','workforce') where recovery_key=$2`,[C,f.key])).rows[0];ok('Reduced loss cannot be deducted again',Number(due.amount)===500);
  await apply(f);ok('Repeat application adds no duplicate financial adjustment',(await db.query('select count(*)::int n from nl_payout_dispute_adjustments where dispute_id=$1',[f.D])).rows[0].n===1);
  ok('No publication cannot close the dispute',(await verify(f)).state==='awaiting_publication');
  const revised=await publish(f,10500,1000);ok('Matching net with wrong loss item cannot close',(await verify(f)).state==='awaiting_publication');
  await db.query(`update workforce_payout_publications set snapshot=jsonb_set(jsonb_set(snapshot,'{worksheet,deduction_breakdown,0,amount}','500'),'{item,net_amount}','10499') where id=$1`,[revised]);
  ok('Correct loss with wrong net cannot close',(await verify(f)).state==='awaiting_publication');
  await db.query(`update workforce_payout_publications set snapshot=jsonb_set(snapshot,'{item,net_amount}','10500') where id=$1`,[revised]);
  ok('Exact revised item and net close the dispute',(await verify(f)).state==='completed');await verify(f);
  ok('Completion is recorded once',(await db.query(`select count(*)::int n from workforce_payout_dispute_events where dispute_id=$1 and event_type='source_application_verified'`,[f.D])).rows[0].n===1);
  await db.query(`insert into applied_keys values($1,'2026-10',true)`,[f.key]);l=await ledger(f);
  ok(`${treatment}: confirmed recovery and remainder reconcile`,Number(l.deducted)===500&&Number(l.outstanding)===(treatment==='write_off'?0:500));
  const audit=(await db.query('select * from nl_payout_dispute_adjustments where dispute_id=$1',[f.D])).rows[0];ok('Write-off audit retains approver, reason, case and original period',audit.decided_by===A2&&audit.reason==='Evidence checked by Finance.'&&audit.month==='2026-09'&&audit.case_key===f.tid);
 }
 const bad=await fixture('unknown');try{await queue(bad);ok('Invalid balance decision is rejected',false);}catch{ok('Invalid balance decision is rejected',true);}
 const bank=await fixture('outstanding','deduction',true);await queue(bank);ok('Existing bank instruction blocks source mutation',(await apply(bank)).state==='blocked');ok('Blocked application leaves no loss adjustment',(await db.query('select count(*)::int n from nl_payout_dispute_adjustments where dispute_id=$1',[bank.D])).rows[0].n===0);
 const rollback=await fixture('write_off');rollback.plan.items.push({selector:'addition',code:'OTHER',current_value:5,proposed_value:10});rollback.snapshot.worksheet.additional_payment_breakdown=[{code:'OTHER',amount:5}];await db.query('update workforce_payout_publications set snapshot=$1 where id=$2',[JSON.stringify(rollback.snapshot),rollback.P]);await db.query('update workforce_payout_disputes set correction_plan=$1 where id=$2',[JSON.stringify(rollback.plan),rollback.D]);await queue(rollback);ok('Unsupported second item blocks entire application',(await apply(rollback)).state==='blocked');ok('Earlier loss adjustment rolls back with later error',(await db.query('select count(*)::int n from nl_payout_dispute_adjustments where dispute_id=$1',[rollback.D])).rows[0].n===0);
 const attendance=await fixture('outstanding','attendance');await queue(attendance);ok('Attendance source uses audited import',(await apply(attendance)).state==='awaiting_publication');const input=(await db.query('select rows from input_batches order by id')).rows.at(-1).rows[0];ok('Attendance correction targets exact day and preserves biometric records',input.input_type==='ATTENDANCE'&&input.field_code==='WORK_DAYS'&&input.effective_from==='2026-10-10'&&input.effective_to==='2026-10-10'&&input.numeric_value===1);
 const perms=(await db.query(`select has_function_privilege('anon','workforce_apply_approved_dispute(uuid,uuid)','execute') a,has_table_privilege('authenticated','nl_payout_dispute_adjustments','select') b,has_table_privilege('service_role','nl_payout_dispute_adjustments','insert') c`)).rows[0];ok('Financial source mutations and audit rows are not client writable',!perms.a&&!perms.b&&!perms.c);
 const final=await fixture('write_off');await db.query(`update workforce_payout_disputes set status='pending_final_approval',final_approved_by=null,proposed_decision='resolved',proposed_by=$2 where id=$1`,[final.D,A1]);
 const actorRoles=(await db.query('select id from user_roles where is_active')).rows.map(r=>r.id);
 const finish=async balance=>(await db.query(`select * from workforce_dispute_transition_v3($1,$2,$3,'Finance test',$4,'approve_final',1,array[$5]::uuid[],$6)`,[C,final.D,A2,actorRoles,S,JSON.stringify({note:'Checked this complete loss correction.',loss_balance:balance})])).rows[0];
 try{await finish(null);ok('Final approval without a balance choice is atomic',false);}catch{ok('Final approval without a balance choice is atomic',(await db.query('select status from workforce_payout_disputes where id=$1',[final.D])).rows[0].status==='pending_final_approval');}
 const saved=await finish({treatment:'write_off',reason:'Checked the disputed assignment.'});ok('Final approval returns the current audit version and queues application',saved.status==='approved_for_processing'&&saved.version===3&&(await db.query('select state from workforce_dispute_application_jobs where dispute_id=$1',[final.D])).rows[0].state==='queued');
 const retry=readFileSync('supabase/migrations/20261107151000_dispute_application_retry.sql','utf8');await db.exec(retry);await db.exec(retry);
 await db.query('select workforce_note_dispute_application_retry($1,$2,$3)',[C,final.D,'Temporary source fetch error']);
 let job=(await db.query('select * from workforce_dispute_application_jobs where dispute_id=$1',[final.D])).rows[0];ok('Transient source failure consumes one retry, not all attempts',job.state==='blocked'&&job.attempts===1);
 await db.query('select workforce_note_dispute_application_retry($1,$2,$3)',[C,attendance.D,'Temporary publication fetch error']);
 job=(await db.query('select * from workforce_dispute_application_jobs where dispute_id=$1',[attendance.D])).rows[0];ok('Applied source stays in verification after refresh failure',job.state==='awaiting_publication'&&job.applied_at!==null&&job.attempts===1);
 ok('Retry recorder is service-only',!(await db.query(`select has_function_privilege('authenticated','workforce_note_dispute_application_retry(uuid,uuid,text)','execute') allowed`)).rows[0].allowed);
 const concurrency=readFileSync('supabase/migrations/20261107151500_dispute_application_concurrent_retry.sql','utf8');await db.exec(concurrency);await db.exec(concurrency);
 await db.query('select workforce_pause_dispute_application($1,$2,$3)',[C,attendance.D,'Another worker saw the newly applied source']);
 job=(await db.query('select * from workforce_dispute_application_jobs where dispute_id=$1',[attendance.D])).rows[0];ok('A stale worker cannot pause an already-applied correction',job.state==='awaiting_publication'&&job.attempts===1);
 await db.query(`update workforce_payout_disputes set status='processing' where id=$1`,[attendance.D]);await db.query('select workforce_pause_dispute_application($1,$2,$3)',[C,attendance.D,'Manual processor claimed this correction']);
 await db.query('select workforce_note_dispute_application_retry($1,$2,$3)',[C,attendance.D,'Late background failure']);
 job=(await db.query('select * from workforce_dispute_application_jobs where dispute_id=$1',[attendance.D])).rows[0];ok('Explicit manual processing stays paused despite a late worker retry',job.state==='blocked'&&job.attempts===3);
}

