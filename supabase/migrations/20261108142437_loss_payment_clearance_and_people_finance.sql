-- A release approves an exact loss/payroll snapshot, for one station and salary month.
create table if not exists public.loss_payment_release_events (
 id uuid primary key default gen_random_uuid(), company_id uuid not null,
 station_id uuid not null, salary_month text not null,
 scope_key text not null, fingerprint text not null,
 action text not null check(action in ('approve','exception','revoke')),
 reason text not null, actor_id uuid not null, actor_name text not null,
 created_at timestamptz not null default clock_timestamp(), review jsonb not null
);
create index if not exists loss_payment_release_lookup on public.loss_payment_release_events
 (company_id,station_id,salary_month,scope_key,created_at desc,id);
alter table public.loss_payment_release_events enable row level security;
revoke all on public.loss_payment_release_events from public,anon,authenticated,service_role;
grant select on public.loss_payment_release_events to service_role;

create or replace function public.payment_release_actor(p_company uuid,p_actor uuid,p_station uuid,p_manager boolean default false)
returns void language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.profiles where id=p_actor and company_id=p_company and is_active)
 then raise exception 'An active company user is required.'; end if;
 if not exists(select 1 from public.stations where id=p_station and company_id=p_company)
 then raise exception 'The payroll station does not belong to this company.'; end if;
 if not exists(
   select 1 from public.company_product_memberships m join public.user_roles r on r.id=m.role_id and r.is_active
   where m.company_id=p_company and m.user_id=p_actor and m.is_active
     and m.product_code in ('operations','ops','finance','people','dashboard','workforce')
     and (m.has_all_location_access or r.location_access_mode='all_locations' or p_station=any(m.location_scope_ids))
     and (not p_manager or regexp_replace(upper(r.code),'^(OPERATIONS|FINANCE|PEOPLE|WORKFORCE)_','')
       in ('SLPM','SLP_MANAGER','NH','NATIONAL_HEAD','FINMGR','FINANCE_MANAGER','MP','MANAGING_PARTNER','SALES_MANAGER'))
 ) then raise exception 'This action requires an authorised role with access to this station.'; end if;
end $$;

create or replace function public.payment_release_payroll_snapshot(p_company uuid,p_run uuid,p_station uuid)
returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object(
  'worker',p.worker_type||':'||p.worker_id,'name',p.worker_name,'status',p.calculation_status,
  'net',p.net_pay,'adjusted',p.adjusted_net_pay,
  'run', (select jsonb_build_object('status',r.status,'from',r.period_start,'through',r.period_end,'stationPaymentsExplicit',r.station_payments_explicit) from public.hr_payroll_runs r where r.id=p_run and r.company_id=p_company),
  'released',exists(select 1 from public.hr_payroll_station_releases where company_id=p_company and run_id=p_run and location_id=p_station),
  'items',coalesce((select jsonb_agg(jsonb_build_object('code',i.code,'amount',i.amount,'type',i.item_type,'source',i.source,'metadata',i.metadata)
    order by i.code,i.amount,i.metadata::text) from public.hr_payroll_run_items i where i.company_id=p_company and i.run_person_id=p.id),'[]'::jsonb),
  'account',case when p.worker_type='employee' then (select e.bank_account_no from public.employees e where e.company_id=p_company and e.id=p.worker_id)
    else (select c.bank_account_no from public.contractors c where c.company_id=p_company and c.id=p.worker_id) end,
  'ifsc',case when p.worker_type='employee' then (select e.ifsc from public.employees e where e.company_id=p_company and e.id=p.worker_id)
    else (select c.ifsc_code from public.contractors c where c.company_id=p_company and c.id=p.worker_id) end
 ) order by p.worker_type,p.worker_id),'[]'::jsonb)
 from public.hr_payroll_run_people p where p.company_id=p_company and p.run_id=p_run and p.location_id=p_station
$$;

create or replace function public.loss_payment_release_review(p_company uuid,p_station uuid,p_month text,p_scope text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_code text; v_codes text[]; v_cases jsonb; v_due jsonb:='[]'; v_payroll jsonb:='[]';
 v_missing jsonb:='[]'; v_pending jsonb; v_hash text; v_approval jsonb; v_run uuid;
begin
 if p_month is null or p_month !~ '^20[0-9]{2}-(0[1-9]|1[0-2])$' then raise exception 'Choose a valid salary month.'; end if;
 if p_scope not in ('workforce','helpers') and p_scope !~ '^people:[0-9a-f-]{36}$' then raise exception 'Choose a valid payroll source.'; end if;
 select s.station_code,array_remove(array[s.station_code,cs.portal_station_code],null) into v_code,v_codes
 from public.stations s left join public.cod_station_settings cs on cs.company_id=s.company_id and cs.location_id=s.id
 where s.company_id=p_company and s.id=p_station;
 if v_code is null then raise exception 'Payroll station is missing or outside the company.'; end if;
 -- Include older unresolved cases and salary allocations regardless of the case's source period.
 select coalesce(jsonb_agg(jsonb_build_object('report',c.report,'month',c.month,'reference',c.case_key,
  'amount',c.amount,'status',case when not c.source_present then 'source_missing' else c.lifecycle_status end,'present',c.source_present,'sourceStatus',c.source_status,
  'final',c.final_seen_at is not null,'period',c.details->>'period',
  'plan',case when r.case_key is null then null else to_jsonb(r)-array['updated_at','assigned_at'] end,
  'response',case when rw.case_key is null then null else to_jsonb(rw)-array['updated_at'] end,
  'pending',c.lifecycle_status not in ('recovered','written_off','rejected','not_recoverable')
    and (not c.source_present or not coalesce(public.nl_case_recoverable(p_company,c.report,c.source_status),false) or r.case_key is null or r.is_deleted or r.approval_status is distinct from 'approved'
      or round(r.source_amount,2)<>round(c.amount,2)
      or public.nl_recovery_source_status_key(r.source_status) is distinct from public.nl_recovery_source_status_key(c.source_status)
      or c.lifecycle_status not in ('recovery_approved_scheduled','recovery_in_progress','exit_balance')
      or (c.report='slp' and c.final_seen_at is null))
 ) order by c.month,c.case_key),'[]'::jsonb) into v_cases
 from public.nl_loss_month_cases c
 left join public.nl_loss_recoveries r on r.company_id=c.company_id and r.month=c.month and r.case_key=c.case_key
 left join public.nl_case_response_windows rw on rw.company_id=c.company_id and rw.month=c.month and rw.case_key=c.case_key
 where c.company_id=p_company and upper(c.station_code)=any(select upper(unnest(v_codes))) and c.month<=p_month;
 select coalesce(jsonb_agg(c),'[]'::jsonb) into v_pending from jsonb_array_elements(v_cases) c where (c->>'pending')::boolean;
 if p_scope='workforce' then
   select coalesce(jsonb_agg(jsonb_build_object('worker',x.workforce_id,'station',x.station_id,
     'item',x.snapshot->'item','deductions',x.snapshot#>'{worksheet,deduction_breakdown}') order by x.workforce_id,x.station_id),'[]'::jsonb)
   into v_payroll from (
     select distinct on (w.workforce_id,w.station_id) w.* from public.workforce_payout_publications w
     where w.company_id=p_company and w.period_start=to_date(p_month,'YYYY-MM')
       and w.period_end=(to_date(p_month,'YYYY-MM')+interval '1 month - 1 day')::date
       and w.workforce_id in (select workforce_id from public.workforce_payout_publications where company_id=p_company and station_id=p_station and period_start=to_date(p_month,'YYYY-MM'))
     order by w.workforce_id,w.station_id,w.revision desc
   ) x;
   select coalesce(jsonb_agg(to_jsonb(d) order by d.recovery_key),'[]'::jsonb) into v_due
   from public.nl_loss_recovery_due(p_company,p_month,'workforce') d
   where d.worker_id::text in (select v->>'worker' from jsonb_array_elements(v_payroll) v);
   select coalesce(jsonb_agg(jsonb_build_object('reference',d->>'recovery_key','worker',d->>'full_name','amount',(d->>'amount')::numeric)),'[]'::jsonb)
   into v_missing from jsonb_array_elements(v_due) d
   where (select coalesce(sum((line->>'amount')::numeric),0) from jsonb_array_elements(v_payroll) pay
     cross join lateral jsonb_array_elements(coalesce(pay->'deductions','[]')) line
     where pay->>'worker'=d->>'worker_id' and line->>'recoveryKey'=d->>'recovery_key')<>(d->>'amount')::numeric;
 elsif p_scope='helpers' then
   select coalesce(jsonb_agg(jsonb_build_object('worker',x.helper_id,'item',x.snapshot->'item','worksheet',x.snapshot->'worksheet') order by x.helper_id),'[]'::jsonb)
   into v_payroll from (select distinct on (helper_id) * from public.helper_payout_publications
     where company_id=p_company and station_id=p_station and period_start=to_date(p_month,'YYYY-MM')
       and period_end=(to_date(p_month,'YYYY-MM')+interval '1 month - 1 day')::date
     order by helper_id,revision desc) x;
 elsif p_scope like 'people:%' then
   v_run:=substring(p_scope from 8)::uuid;
   if not exists(select 1 from public.hr_payroll_runs where company_id=p_company and id=v_run and to_char(period_start,'YYYY-MM')=p_month)
   then raise exception 'Payroll run and salary month do not match.'; end if;
   v_payroll:=public.payment_release_payroll_snapshot(p_company,v_run,p_station);
   select coalesce(jsonb_agg(to_jsonb(d) order by d.recovery_key),'[]'::jsonb) into v_due
   from public.nl_loss_recovery_due(p_company,p_month,'hrms',v_run) d
   where d.employee_ref in (select v->>'worker' from jsonb_array_elements(v_payroll) v);
   select coalesce(jsonb_agg(jsonb_build_object('reference',d->>'recovery_key','worker',d->>'full_name','amount',(d->>'amount')::numeric)),'[]'::jsonb)
   into v_missing from jsonb_array_elements(v_due) d
   where (select coalesce(sum((item->>'amount')::numeric),0) from jsonb_array_elements(v_payroll) pay
     cross join lateral jsonb_array_elements(pay->'items') item where pay->>'worker'=d->>'employee_ref'
       and item->>'code'='OPS_LOSS_RECOVERY' and item#>>'{metadata,recovery_key}'=d->>'recovery_key')<>(d->>'amount')::numeric;
 end if;
 v_hash:=md5(jsonb_build_object('company',p_company,'station',p_station,'month',p_month,'scope',p_scope,
    'cases',v_cases,'due',v_due,'payroll',v_payroll)::text);
 select case when e.action<>'revoke' and e.fingerprint=v_hash then jsonb_build_object('id',e.id,'actor',e.actor_name,'at',e.created_at,'mode',e.action,'reason',e.reason) end
 into v_approval from public.loss_payment_release_events e
 where e.company_id=p_company and e.station_id=p_station and e.salary_month=p_month and e.scope_key=p_scope
 order by e.created_at desc,e.id desc limit 1;
 return jsonb_build_object('fingerprint',v_hash,'station',v_code,'month',p_month,'sourceCount',jsonb_array_length(v_cases),
  'pendingCount',jsonb_array_length(v_pending),'pendingAmount',(select coalesce(sum((v->>'amount')::numeric),0) from jsonb_array_elements(v_pending) v),
  'missingDeductionCount',jsonb_array_length(v_missing),'missingDeductionAmount',(select coalesce(sum((v->>'amount')::numeric),0) from jsonb_array_elements(v_missing) v),
  'pending',coalesce((select jsonb_agg(jsonb_build_object('report',v->>'report','month',v->>'month','reference',v->>'reference','amount',v->'amount','status',v->>'status')) from jsonb_array_elements(v_pending) v),'[]'::jsonb),
  'missingDeductions',v_missing,'approval',v_approval);
end $$;

create or replace function public.loss_payment_release_decide(p_company uuid,p_station uuid,p_month text,p_scope text,p_actor uuid,p_action text,p_fingerprint text,p_reason text,p_owner text default null,p_follow_up date default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_review jsonb; v_name text;
begin
 perform public.payment_release_actor(p_company,p_actor,p_station,true);
 perform pg_advisory_xact_lock(hashtextextended('nl-recovery:'||p_company::text,0));
 v_review:=public.loss_payment_release_review(p_company,p_station,p_month,p_scope);
 if p_fingerprint is distinct from v_review->>'fingerprint' then raise exception 'Loss or payroll data changed. Review the current details before approving.'; end if;
 if p_action is null or p_action not in ('approve','exception','revoke') then raise exception 'Choose a release decision.'; end if;
 if length(trim(coalesce(p_reason,'')))<10 or length(p_reason)>2000 then raise exception 'Record a review note of 10 to 2000 characters.'; end if;
 if p_action='exception' and (length(trim(coalesce(p_owner,'')))<3 or p_follow_up is null or p_follow_up<current_date or p_follow_up>current_date+90)
 then raise exception 'Assign a recovery owner and a follow-up date within the next 90 days.'; end if;
 if p_action='approve' and ((v_review->>'pendingCount')::int>0 or (v_review->>'missingDeductionCount')::int>0)
 then raise exception 'Pending loss updates or missing deductions require an explicit exception with an owner and follow-up.'; end if;
 select coalesce(nullif(full_name,''),email) into v_name from public.profiles where id=p_actor;
 insert into public.loss_payment_release_events(company_id,station_id,salary_month,scope_key,fingerprint,action,reason,actor_id,actor_name,review)
 values(p_company,p_station,p_month,p_scope,p_fingerprint,p_action,
   trim(p_reason)||case when p_action='exception' then E'\nRecovery owner: '||trim(p_owner)||E'\nFollow-up date: '||p_follow_up else '' end,
   p_actor,v_name,(v_review-'approval')||jsonb_build_object('recovery_owner',p_owner,'follow_up',p_follow_up));
 return public.loss_payment_release_review(p_company,p_station,p_month,p_scope);
end $$;

create or replace function public.assert_loss_payment_release(p_company uuid,p_station uuid,p_month text,p_scope text)
returns void language plpgsql security definer set search_path='' as $$
declare v_review jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('nl-recovery:'||p_company::text,0));
 v_review:=public.loss_payment_release_review(p_company,p_station,p_month,p_scope);
 if v_review->'approval'='null'::jsonb or v_review->'approval' is null then
   raise exception '% · %: payment release approval is required or has expired after loss/payroll changes. Review loss clearance.',v_review->>'station',p_month;
 end if;
end $$;

-- All generation entry points take the loss lock before payment locks. This includes legacy callers.
do $$
declare fn record; definition text;
begin
 for fn in select p.oid,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('workforce_create_payout_payment_batch','workforce_create_payout_payment_row_batch','workforce_create_payout_payment_row_batch_with_disputes','helper_create_payout_payment_row_batch') loop
  definition:=pg_get_functiondef(fn.oid);
  if position('-- loss release serialization' in definition)=0 then
   definition:=regexp_replace(definition,'\mbegin\M',E'begin\n -- loss release serialization\n perform pg_advisory_xact_lock(hashtextextended(''nl-recovery:''||p_company_id::text,0));','i');
   execute definition;
  end if;
 end loop;
end $$;
create or replace function public.guard_payout_loss_release()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform public.assert_loss_payment_release(new.company_id,new.location_id_snapshot,to_char(new.period_start,'YYYY-MM'),
   case when tg_table_name='helper_payout_payment_items' then 'helpers' else 'workforce' end);
 return new;
end $$;
drop trigger if exists payout_loss_release on public.workforce_payout_payment_items;
create trigger payout_loss_release before insert on public.workforce_payout_payment_items for each row execute function public.guard_payout_loss_release();
drop trigger if exists payout_loss_release on public.helper_payout_payment_items;
create trigger payout_loss_release before insert on public.helper_payout_payment_items for each row execute function public.guard_payout_loss_release();

-- Imports, manual saves and release decisions serialize on the same company lock.
create or replace function public.lock_loss_payment_source()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('nl-recovery:'||coalesce(new.company_id,old.company_id)::text,0));
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
do $$ declare tab text; begin
 foreach tab in array array['nl_loss_month_cases','nl_loss_recoveries','nl_case_response_windows','workforce_payout_publications','helper_payout_publications','hr_payroll_run_people','hr_payroll_run_items','employees','contractors'] loop
  execute format('drop trigger if exists loss_payment_source_lock on public.%I',tab);
  execute format('create trigger loss_payment_source_lock before insert or update or delete on public.%I for each row execute function public.lock_loss_payment_source()',tab);
 end loop;
end $$;

create table if not exists public.people_finance_requests (
 id uuid primary key default gen_random_uuid(),company_id uuid not null,run_id uuid not null,
 station_id uuid not null,status text not null check(status in ('submitted','approved','returned')),
 payroll_hash text not null,submitted_by uuid not null,submitted_at timestamptz not null default now(),
 reviewed_by uuid,reviewed_at timestamptz,review_note text not null default '',version integer not null default 1,
 unique(company_id,run_id,station_id)
);
create table if not exists public.people_finance_events (
 id uuid primary key default gen_random_uuid(),request_id uuid not null,company_id uuid not null,
 actor_id uuid not null,action text not null,reason text not null,created_at timestamptz not null default clock_timestamp(),snapshot jsonb not null
);
create table if not exists public.people_finance_bank_batches (
 id uuid primary key,company_id uuid not null,request_id uuid not null,actor_id uuid not null,
 bank_id uuid not null,value_date date not null,payroll_hash text not null,created_at timestamptz not null default clock_timestamp(),instructions jsonb not null
);
do $$ declare tab text; begin
 foreach tab in array array['people_finance_requests','people_finance_events','people_finance_bank_batches'] loop
  execute format('alter table public.%I enable row level security',tab);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',tab);
  execute format('grant select on public.%I to service_role',tab);
 end loop;
end $$;

create or replace function public.people_finance_submission_review(p_company uuid,p_run uuid,p_station uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_payload jsonb; v_hash text; r public.people_finance_requests;
begin
 v_payload:=public.payment_release_payroll_snapshot(p_company,p_run,p_station); v_hash:=md5(v_payload::text);
 select * into r from public.people_finance_requests where company_id=p_company and run_id=p_run and station_id=p_station;
 return jsonb_build_object('hash',v_hash,'peopleCount',jsonb_array_length(v_payload),'changed',r.id is not null and r.payroll_hash<>v_hash,
 'request',case when r.id is null then null else jsonb_build_object('status',r.status,'review_note',r.review_note) end,
 'people',(select coalesce(jsonb_agg(jsonb_build_object('name',p->>'name','status',p->>'status','net',coalesce((p->>'adjusted')::numeric,(p->>'net')::numeric),
 'bankLast4',right(p->>'account',4),'items',p->'items','paid',b.paid,'processing',b.processing,
 'remaining',greatest(0,coalesce((p->>'adjusted')::numeric,(p->>'net')::numeric)-case when h.inside then 0 else h.hold end-b.paid))), '[]'::jsonb)
 from jsonb_array_elements(v_payload) p
 cross join lateral (select coalesce(sum((i->>'amount')::numeric),0) hold,coalesce(bool_or(i->>'type'='deduction' and (i->>'amount')::numeric>0),false) inside from jsonb_array_elements(p->'items') i where upper(i->>'code')='SALARY_HOLD') h
 cross join lateral (select coalesce(sum(amount) filter(where status='paid'),0) paid,count(*) filter(where status in ('issued','processing')) processing from public.hr_payroll_bank_lines where company_id=p_company and run_id=p_run and worker_type=split_part(p->>'worker',':',1) and worker_id=split_part(p->>'worker',':',2)::uuid) b));
end $$;

create or replace function public.people_finance_submit(p_company uuid,p_run uuid,p_station uuid,p_actor uuid,p_hash text)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_run public.hr_payroll_runs; v_payload jsonb; v_hash text; v_id uuid; v_existing public.people_finance_requests;
begin
 perform public.payment_release_actor(p_company,p_actor,p_station);
 perform pg_advisory_xact_lock(hashtextextended('nl-recovery:'||p_company::text,0));
 select * into v_run from public.hr_payroll_runs where company_id=p_company and id=p_run for update;
 if v_run.id is null or (not (v_run.status in ('approved','locked') and not coalesce(v_run.station_payments_explicit,false) and not exists(select 1 from public.hr_payroll_station_releases where company_id=p_company and run_id=p_run)) and not exists(
   select 1 from public.hr_payroll_station_releases where company_id=p_company and run_id=p_run and location_id=p_station))
 then raise exception 'Review and approve this station payroll in People before sending it to Finance.'; end if;
 if v_run.period_start<>date_trunc('month',v_run.period_start)::date or v_run.period_end<>(v_run.period_start+interval '1 month - 1 day')::date
 then raise exception 'Only a complete salary month can be sent to Finance.'; end if;
 v_payload:=public.payment_release_payroll_snapshot(p_company,p_run,p_station);v_hash:=md5(v_payload::text);
 if v_payload='[]'::jsonb then raise exception 'This station has no payroll rows.'; end if;
 if v_hash is distinct from p_hash then raise exception 'Payroll changed. Refresh before sending to Finance.'; end if;
 if exists(select 1 from jsonb_array_elements(v_payload) p where p->>'status'='blocked') then raise exception 'Resolve blocked payroll rows before sending this station.'; end if;
 select * into v_existing from public.people_finance_requests where company_id=p_company and run_id=p_run and station_id=p_station for update;
 if v_existing.id is not null and v_existing.payroll_hash=v_hash and v_existing.status in ('submitted','approved') then return v_existing.id; end if;
 insert into public.people_finance_requests(company_id,run_id,station_id,status,payroll_hash,submitted_by)
 values(p_company,p_run,p_station,'submitted',v_hash,p_actor)
 on conflict(company_id,run_id,station_id) do update set status='submitted',payroll_hash=excluded.payroll_hash,
 submitted_by=excluded.submitted_by,submitted_at=clock_timestamp(),reviewed_by=null,reviewed_at=null,review_note='',version=people_finance_requests.version+1
 returning id into v_id;
 insert into public.people_finance_events(request_id,company_id,actor_id,action,reason,snapshot)
 values(v_id,p_company,p_actor,'submitted','Payroll sent to Finance',jsonb_build_object('hash',v_hash,'people',jsonb_array_length(v_payload),'payroll',v_payload));
 return v_id;
end $$;

create or replace function public.people_finance_decide(p_company uuid,p_request uuid,p_actor uuid,p_version integer,p_action text,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare r public.people_finance_requests; v_month text;
begin
 perform pg_advisory_xact_lock(hashtextextended('nl-recovery:'||p_company::text,0));
 select * into r from public.people_finance_requests where company_id=p_company and id=p_request for update;
 if r.id is null then raise exception 'Payroll submission was not found.'; end if;
 perform public.payment_release_actor(p_company,p_actor,r.station_id);
 if r.version<>p_version or r.status<>'submitted' then raise exception 'The submission changed. Refresh Finance payroll.'; end if;
 if p_action not in ('approve','return') or length(trim(coalesce(p_reason,'')))<10 then raise exception 'Record the Finance review decision and reason.'; end if;
 if p_action='approve' then
  if r.submitted_by=p_actor then raise exception 'Finance approval must be completed by someone other than the payroll submitter.'; end if;
  if r.payroll_hash<>md5(public.payment_release_payroll_snapshot(p_company,r.run_id,r.station_id)::text)
  then raise exception 'Payroll changed after submission. Send the revised payroll from People.'; end if;
  select to_char(period_start,'YYYY-MM') into v_month from public.hr_payroll_runs where company_id=p_company and id=r.run_id;
  perform public.assert_loss_payment_release(p_company,r.station_id,v_month,'people:'||r.run_id);
 end if;
 update public.people_finance_requests set status=case when p_action='approve' then 'approved' else 'returned' end,
  reviewed_by=p_actor,reviewed_at=clock_timestamp(),review_note=trim(p_reason),version=version+1 where id=r.id;
 insert into public.people_finance_events(request_id,company_id,actor_id,action,reason,snapshot)
 values(r.id,p_company,p_actor,p_action,trim(p_reason),jsonb_build_object('payroll_hash',r.payroll_hash,'version',r.version));
end $$;

create or replace function public.people_finance_issue(p_company uuid,p_request uuid,p_actor uuid,p_operation uuid,p_bank uuid,p_value_date date)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.people_finance_requests; v_month text; v_bank public.payment_banks; v_old public.people_finance_bank_batches;
 v_person record; v_paid numeric; v_amount numeric; v_hold numeric; v_inside boolean; v_attempt integer; v_ref text;
 v_account text; v_ifsc text; v_items jsonb:='[]'; v_payload jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('nl-recovery:'||p_company::text,0));
 select * into r from public.people_finance_requests where company_id=p_company and id=p_request for update;
 if r.id is null then raise exception 'Payroll submission was not found.'; end if;
 perform public.payment_release_actor(p_company,p_actor,r.station_id);
 if p_operation is null or p_value_date is null then raise exception 'Bank operation and value date are required.'; end if;
 -- Serialize all stations in this payroll, including workers assigned to two locations.
 perform 1 from public.hr_payroll_runs where company_id=p_company and id=r.run_id for update;
 select to_char(period_start,'YYYY-MM') into v_month from public.hr_payroll_runs where company_id=p_company and id=r.run_id;
 perform public.assert_loss_payment_release(p_company,r.station_id,v_month,'people:'||r.run_id);
 if r.status<>'approved' then raise exception 'Finance must approve the submitted payroll before generating its bank file.'; end if;
 if r.payroll_hash<>md5(public.payment_release_payroll_snapshot(p_company,r.run_id,r.station_id)::text)
 then raise exception 'Payroll or bank details changed. Resubmit payroll for Finance review.'; end if;
 select * into v_old from public.people_finance_bank_batches where id=p_operation;
 if v_old.id is not null then
  if v_old.company_id<>p_company or v_old.request_id<>p_request or v_old.bank_id<>p_bank or v_old.value_date<>p_value_date
  then raise exception 'The bank operation was already used for a different request.'; end if;
  if v_old.payroll_hash<>r.payroll_hash then raise exception 'This file belongs to an earlier payroll revision. Reconcile its instructions before issuing a new file.'; end if;
  if exists(select 1 from jsonb_array_elements(v_old.instructions) i where not exists(
     select 1 from public.hr_payroll_bank_lines b where b.company_id=p_company and b.run_id=r.run_id and b.reference=i->>'referenceNo' and b.status='processing'))
  then raise exception 'This file has settled or cancelled instructions. Refresh the payment status.'; end if;
  insert into public.people_finance_events(request_id,company_id,actor_id,action,reason,snapshot)
  values(r.id,p_company,p_actor,'bank_file_replay','Finance downloaded existing instructions',jsonb_build_object('operation',p_operation));
  return jsonb_build_object('instructions',v_old.instructions,'replayed',true);
 end if;
 select * into v_bank from public.payment_banks where company_id=p_company and id=p_bank and is_active and bank_code='FEDERAL_BANK';
 if v_bank.id is null or nullif(trim(v_bank.account_no),'') is null then raise exception 'Choose an active Federal Bank debit account.'; end if;
 perform set_config('app.people_finance_issue','allowed',true);
 for v_person in select * from public.hr_payroll_run_people where company_id=p_company and run_id=r.run_id and location_id=r.station_id order by worker_id loop
  if v_person.calculation_status='blocked' then raise exception 'Payroll contains blocked people. Return it to People for correction.'; end if;
  if exists(select 1 from public.hr_payroll_bank_lines b join public.hr_payroll_runs other_run on other_run.company_id=b.company_id and other_run.id=b.run_id
    join public.hr_payroll_runs this_run on this_run.company_id=p_company and this_run.id=r.run_id
    where b.company_id=p_company and b.run_id<>r.run_id and b.worker_id=v_person.worker_id and b.worker_type=v_person.worker_type
      and b.status in ('issued','processing','paid') and other_run.period_start<=this_run.period_end and other_run.period_end>=this_run.period_start)
  then raise exception 'This person has payment history in another overlapping payroll run. Reconcile and revise the original payroll instead of paying a second run.'; end if;
  if exists(select 1 from public.hr_payroll_bank_lines where company_id=p_company and run_id=r.run_id and worker_id=v_person.worker_id and status in ('processing','issued'))
  then raise exception 'A selected person already has an issued or processing payment. Reconcile or cancel that instruction first.'; end if;
  select coalesce(sum(amount),0) into v_paid from public.hr_payroll_bank_lines where company_id=p_company and run_id=r.run_id and worker_id=v_person.worker_id and status='paid';
  select coalesce(sum(amount),0),coalesce(bool_or(item_type='deduction' and amount>0),false) into v_hold,v_inside
    from public.hr_payroll_run_items where company_id=p_company and run_person_id=v_person.id and upper(code)='SALARY_HOLD';
  if exists(select 1 from public.hr_payroll_run_items where company_id=p_company and run_person_id=v_person.id and upper(code)='SALARY_HOLD' and metadata->>'full_month'='true') then continue; end if;
  v_amount:=round(greatest(0,coalesce(v_person.adjusted_net_pay,v_person.net_pay)-case when v_inside then 0 else v_hold end)-v_paid,2);
  if v_amount<=0 then continue; end if;
  if v_person.worker_type='employee' then
   select bank_account_no,ifsc into v_account,v_ifsc from public.employees where company_id=p_company and id=v_person.worker_id;
  else
   select bank_account_no,ifsc_code into v_account,v_ifsc from public.contractors where company_id=p_company and id=v_person.worker_id;
  end if;
  v_account:=regexp_replace(coalesce(v_account,''),'\s','','g'); v_ifsc:=upper(trim(coalesce(v_ifsc,'')));
  if v_account !~ '^[0-9]{6,30}$' or v_ifsc !~ '^[A-Z]{4}0[A-Z0-9]{6}$' then raise exception 'Correct bank details for % in People and resubmit.',v_person.worker_name; end if;
  select coalesce(max(attempt),0)+1 into v_attempt from public.hr_payroll_bank_lines where company_id=p_company and run_id=r.run_id and worker_id=v_person.worker_id;
  v_ref:='HR'||upper(substr(md5(p_operation::text||':'||v_person.worker_type||':'||v_person.worker_id::text),1,24));
  insert into public.hr_payroll_bank_lines(company_id,run_id,worker_type,worker_id,worker_code,worker_name,reference,amount,instruction_amount,attempt,credit_account,ifsc,debit_account_number,value_date,status,created_by)
  values(p_company,r.run_id,v_person.worker_type,v_person.worker_id,v_person.worker_code,v_person.worker_name,v_ref,v_amount,v_amount,v_attempt,v_account,v_ifsc,v_bank.account_no,p_value_date,'processing',p_actor);
  v_items:=v_items||jsonb_build_array(jsonb_build_object('referenceNo',v_ref,'amountPaise',round(v_amount*100)::bigint,
    'beneficiaryAccountNumber',v_account,'beneficiaryIfsc',v_ifsc,'beneficiaryName',v_person.worker_name,
    'creditRemarks','SALARY '||v_month,'debitAccountNumber',v_bank.account_no,'valueDate',p_value_date));
 end loop;
 if v_items='[]'::jsonb then raise exception 'There is no unpaid balance available for this station.'; end if;
 insert into public.people_finance_bank_batches(id,company_id,request_id,actor_id,bank_id,value_date,payroll_hash,instructions)
 values(p_operation,p_company,p_request,p_actor,p_bank,p_value_date,r.payroll_hash,v_items);
 insert into public.people_finance_events(request_id,company_id,actor_id,action,reason,snapshot)
 values(r.id,p_company,p_actor,'bank_file','Finance generated bank instructions',jsonb_build_object('operation',p_operation,'lines',jsonb_array_length(v_items),'payroll_hash',r.payroll_hash));
 return jsonb_build_object('instructions',v_items,'replayed',false);
end $$;

create or replace function public.guard_people_finance_bank_issue()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.status in ('issued','processing') and (tg_op='INSERT' or new.status is distinct from old.status or
   (to_jsonb(new)-array['updated_at','bank_remarks']) is distinct from (to_jsonb(old)-array['updated_at','bank_remarks'])) then
  if current_setting('app.people_finance_issue',true) is distinct from 'allowed' then
   raise exception 'Send payroll to Finance. Bank instructions require Finance approval and loss clearance.';
  end if;
 end if;
 return new;
end $$;
drop trigger if exists people_finance_bank_issue on public.hr_payroll_bank_lines;
create trigger people_finance_bank_issue before insert or update on public.hr_payroll_bank_lines for each row execute function public.guard_people_finance_bank_issue();

-- The server authorizes product permissions. All financial decisions also verify company,
-- station and actor membership in the database. Client roles cannot invoke these functions.
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in ('payment_release_actor','payment_release_payroll_snapshot','loss_payment_release_review','loss_payment_release_decide','assert_loss_payment_release','guard_payout_loss_release','lock_loss_payment_source','people_finance_submission_review','people_finance_submit','people_finance_decide','people_finance_issue','guard_people_finance_bank_issue') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
