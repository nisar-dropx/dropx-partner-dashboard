-- Approved corrections are applied to source inputs exactly once, then verified
-- against a new publication. Bank history and original loss allocations stay intact.
create table if not exists public.workforce_dispute_application_jobs (
 dispute_id uuid primary key references public.workforce_payout_disputes(id),
 company_id uuid not null references public.companies(id),
 state text not null default 'queued' check(state in ('queued','awaiting_publication','completed','blocked')),
 attempts integer not null default 0, last_error text, input_batch_id uuid,
 applied_at timestamptz, publication_id uuid, updated_at timestamptz not null default now()
);
create table if not exists public.nl_payout_dispute_adjustments (
 dispute_id uuid not null references public.workforce_payout_disputes(id),
 company_id uuid not null references public.companies(id), recovery_key text not null,
 month text not null, case_key text not null, employee_ref text not null,
 before_amount numeric(14,2) not null, after_amount numeric(14,2) not null,
 amount numeric(14,2) generated always as (before_amount-after_amount) stored,
 treatment text not null check(treatment in ('outstanding','write_off')),
 reason text not null, decided_by uuid not null, decided_by_name text not null,
 created_at timestamptz not null default now(),
 primary key(dispute_id,recovery_key), check(before_amount>after_amount and after_amount>=0)
);
create index if not exists nl_payout_dispute_adjustments_key_idx on public.nl_payout_dispute_adjustments(company_id,recovery_key);
create index if not exists workforce_dispute_application_queue_idx on public.workforce_dispute_application_jobs(state,updated_at) where state<>'completed';
create index if not exists nl_payout_dispute_adjustments_case_idx on public.nl_payout_dispute_adjustments(company_id,month,case_key);
alter table public.workforce_dispute_application_jobs enable row level security;
alter table public.nl_payout_dispute_adjustments enable row level security;
revoke all on public.workforce_dispute_application_jobs,public.nl_payout_dispute_adjustments from public,anon,authenticated,service_role;
grant select on public.workforce_dispute_application_jobs,public.nl_payout_dispute_adjustments to service_role;

create or replace function public.nl_dispute_recovery_amount(p_company uuid,p_key text,p_amount numeric)
returns numeric language sql stable security definer set search_path='' as $$
 select least(p_amount,coalesce(min(a.after_amount),p_amount)) from public.nl_payout_dispute_adjustments a
 where a.company_id=p_company and a.recovery_key=p_key;
$$;
revoke all on function public.nl_dispute_recovery_amount(uuid,text,numeric) from public,anon,authenticated;
grant execute on function public.nl_dispute_recovery_amount(uuid,text,numeric) to service_role;

-- Called inside the existing, scope-checked final-approval transaction.
create or replace function public.workforce_queue_dispute_application(p_company uuid,p_dispute uuid,p_balance jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare d public.workforce_payout_disputes; reduced numeric;
begin
 select * into d from public.workforce_payout_disputes where company_id=p_company and id=p_dispute for update;
 if not found or d.status<>'approved_for_processing' or d.final_approved_by is null or d.final_approved_by=coalesce(d.initial_reviewed_by,d.proposed_by) then raise exception 'Independent final approval is required.'; end if;
 select coalesce(sum(greatest(0,(x->>'current_value')::numeric-(x->>'proposed_value')::numeric)),0) into reduced
 from jsonb_array_elements(d.correction_plan->'items') x where x->>'selector'='deduction' and nullif(x->>'recovery_key','') is not null;
 if reduced>0 then
  if coalesce(p_balance->>'treatment','') not in ('outstanding','write_off') or length(trim(coalesce(p_balance->>'reason',''))) not between 10 and 1000 then raise exception 'Choose outstanding or write-off and record the reason.'; end if;
  update public.workforce_payout_disputes set details=details||jsonb_build_object('loss_balance',p_balance),version=version+1,updated_at=now() where id=d.id returning * into d;
  insert into public.workforce_payout_dispute_events(company_id,dispute_id,actor_id,actor_name,portal,message,event_type,metadata,dispute_version)
  values(p_company,d.id,d.final_approved_by,d.final_approved_by_name,'ops',format('Reduced loss %s: %s. %s',reduced,p_balance->>'treatment',p_balance->>'reason'),'loss_balance_decided',p_balance||jsonb_build_object('amount',reduced),d.version);
 end if;
 insert into public.workforce_dispute_application_jobs(dispute_id,company_id) values(d.id,p_company) on conflict(dispute_id) do update set state='queued',attempts=0,last_error=null,updated_at=now() where public.workforce_dispute_application_jobs.applied_at is null;
end $$;
revoke all on function public.workforce_queue_dispute_application(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.workforce_queue_dispute_application(uuid,uuid,jsonb) to service_role;

create or replace function public.workforce_apply_approved_dispute(p_company uuid,p_dispute uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.workforce_dispute_application_jobs; d public.workforce_payout_disputes; p public.workforce_payout_publications;
 item jsonb; input_rows jsonb:='[]'; a public.nl_payout_dispute_adjustments; loss public.nl_loss_recoveries;
 field_id uuid; input_type text; field_code text; key text; baseline numeric; current_due numeric; target numeric; n integer:=1; batch uuid; allowed boolean;
begin
 select * into j from public.workforce_dispute_application_jobs where company_id=p_company and dispute_id=p_dispute for update;
 if not found then raise exception 'No approved application job.'; end if;
 if j.state in ('completed','awaiting_publication') then return to_jsonb(j); end if;
 if j.attempts>=3 then return to_jsonb(j); end if;
 update public.workforce_dispute_application_jobs set attempts=attempts+1,updated_at=now() where dispute_id=j.dispute_id;
 begin
  select * into d from public.workforce_payout_disputes where company_id=p_company and id=p_dispute for update;
  if d.status<>'approved_for_processing' or d.final_approved_by is null or d.correction_plan->>'schema'<>'3' then raise exception 'Request is no longer approved for automatic application.'; end if;
  select * into p from public.workforce_payout_publications where company_id=p_company and id=d.publication_id;
  if p.publication_kind is distinct from 'worksheet' then raise exception 'Legacy payroll correction requires the payout processor.'; end if;
  perform 1 from public.workforce where company_id=p_company and id=d.workforce_id for update;
  if exists(select 1 from public.workforce_dispute_application_jobs other_job join public.workforce_payout_disputes other_d on other_d.id=other_job.dispute_id join public.workforce_payout_publications other_p on other_p.id=other_d.publication_id
    where other_job.company_id=p_company and other_job.dispute_id<>d.id and other_job.applied_at is not null and other_d.workforce_id=d.workforce_id and other_p.period_start=p.period_start and other_p.period_end=p.period_end and other_job.applied_at>p.published_at)
  then raise exception 'Another correction has changed this payout. Review the revised publication before applying another correction.'; end if;
  if exists(select 1 from public.workforce_payout_payment_items b where b.company_id=p_company and b.workforce_id=d.workforce_id and b.period_start=p.period_start and b.period_end=p.period_end and (coalesce(b.settled_amount,0)>0 or b.status not in ('failed','cancelled','rejected'))) then raise exception 'A bank instruction or payment exists. Finance must settle or cancel it before source correction.'; end if;
  for item in select value from jsonb_array_elements(d.correction_plan->'items') loop
   baseline:=public.workforce_dispute_snapshot_value(p.snapshot,item);
   if baseline is null or abs(baseline-(item->>'current_value')::numeric)>.005 then raise exception 'Approved input does not match the original publication.'; end if;
   target:=(item->>'proposed_value')::numeric;
   if target=baseline then continue; end if;
   key:=nullif(item->>'recovery_key','');
   if item->>'selector'='deduction' and key is not null then
    if target<0 or target>=baseline then raise exception 'Loss increases require a revised loss allocation.'; end if;
    if split_part(key,'|',3)<>'workforce:'||d.workforce_id::text then raise exception 'Loss recovery does not belong to this associate.'; end if;
    perform pg_advisory_xact_lock(hashtextextended('nl-recovery:'||p_company::text,0));
    select * into loss from public.nl_loss_recoveries r where r.company_id=p_company and r.month=split_part(key,'|',1) and r.case_key=split_part(key,'|',2) for update;
    if not found or loss.is_deleted or loss.approval_status<>'approved' then raise exception 'Loss allocation changed. Recheck its approval.'; end if;
    select amount into current_due from public.nl_loss_recovery_due(p_company,to_char(p.period_start,'YYYY-MM'),'workforce',null) x where x.recovery_key=key;
    if current_due is null or abs(current_due-baseline)>.005 then raise exception 'Current loss recovery differs from this approved correction.'; end if;
    insert into public.nl_payout_dispute_adjustments(dispute_id,company_id,recovery_key,month,case_key,employee_ref,before_amount,after_amount,treatment,reason,decided_by,decided_by_name)
    values(d.id,p_company,key,loss.month,loss.case_key,'workforce:'||d.workforce_id::text,baseline,target,d.details#>>'{loss_balance,treatment}',d.details#>>'{loss_balance,reason}',d.final_approved_by,d.final_approved_by_name) returning * into a;
    insert into public.nl_loss_recovery_events(company_id,month,case_key,before_value,after_value,actor_id,actor_name)
    values(p_company,loss.month,loss.case_key,jsonb_build_object('deduction',baseline),jsonb_build_object('payout_dispute_adjustment',to_jsonb(a)),d.final_approved_by,d.final_approved_by_name);
    perform public.nl_recovery_bump_payout_months(p_company,array[to_char(p.period_start,'YYYY-MM')]);
   else
    n:=n+1;field_id:=null;field_code:=item->>'code';
    if item->>'selector'='attendance' then input_type:='ATTENDANCE';field_code:='WORK_DAYS';
    elsif item->>'selector' in ('count','rate') then
     input_type:=case when item->>'selector'='count' then 'PRODUCTION_UNITS' else 'PAYMENT_FIELD_VALUE' end;
     select id into field_id from public.payment_fields f where f.company_id=p_company and f.code=field_code and f.is_active;
     if field_id is null then raise exception 'The dated payment field is unavailable.'; end if;
    else raise exception 'This correction needs the payout processor to update its source item.';
    end if;
    input_rows:=input_rows||jsonb_build_array(jsonb_build_object('row_number',n,'action','UPSERT','dropx_id',p.snapshot#>>'{item,dropx_id}','input_type',input_type,'field_code',field_code,'workforce_id',d.workforce_id,'station_id',d.station_id,'payment_field_id',field_id,'effective_from',item->>'date','effective_to',item->>'date','numeric_value',target,'remark','Approved dispute '||d.id::text));
   end if;
  end loop;
  if jsonb_array_length(input_rows)>0 then
   batch:=public.workforce_apply_payout_import(p_company,p.period_start,p.period_end,'Approved dispute '||d.id::text,md5(d.id::text)||md5(d.correction_plan::text),input_rows,d.final_approved_by,array[d.station_id]);
  end if;
  perform public.enqueue_workforce_payout_dependency_refresh(p_company,d.workforce_id,d.station_id,p.period_start,p.period_end,d.final_approved_by);
  update public.workforce_dispute_application_jobs set state='awaiting_publication',input_batch_id=batch,applied_at=now(),last_error=null,updated_at=now() where dispute_id=d.id returning * into j;
  update public.workforce_payout_disputes set version=version+1,updated_at=now() where id=d.id returning * into d;
  insert into public.workforce_payout_dispute_events(company_id,dispute_id,actor_name,portal,message,event_type,metadata,dispute_version)
  values(p_company,d.id,'System','ops','Approved source correction applied. Revised payout verification pending.','source_correction_applied',jsonb_build_object('input_batch_id',batch),d.version);
 exception when others then
  update public.workforce_dispute_application_jobs set state='blocked',last_error=left(sqlerrm,1500),updated_at=now() where dispute_id=p_dispute returning * into j;
 end;
 return to_jsonb(j);
end $$;
revoke all on function public.workforce_apply_approved_dispute(uuid,uuid) from public,anon,authenticated;
grant execute on function public.workforce_apply_approved_dispute(uuid,uuid) to service_role;

create or replace function public.workforce_verify_dispute_application(p_company uuid,p_dispute uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.workforce_dispute_application_jobs; d public.workforce_payout_disputes; p public.workforce_payout_publications; revised public.workforce_payout_publications;
 item jsonb; actual numeric; delta bigint; before_net bigint; after_net bigint;
begin
 select * into j from public.workforce_dispute_application_jobs where company_id=p_company and dispute_id=p_dispute for update;
 if not found or j.state<>'awaiting_publication' then return coalesce(to_jsonb(j),'{}'); end if;
 select * into d from public.workforce_payout_disputes where company_id=p_company and id=p_dispute for update;
 if d.status<>'approved_for_processing' then raise exception 'Dispute stage changed during application.'; end if;
 select * into p from public.workforce_payout_publications where company_id=p_company and id=d.publication_id;
 select * into revised from public.workforce_payout_publications r where r.company_id=p_company and r.workforce_id=d.workforce_id and r.station_id=d.station_id and r.period_start=p.period_start and r.period_end=p.period_end and r.revision>p.revision and r.published_at>=j.applied_at order by r.revision desc limit 1;
 if not found then update public.workforce_dispute_application_jobs set updated_at=now() where dispute_id=j.dispute_id;return to_jsonb(j); end if;
 for item in select value from jsonb_array_elements(d.correction_plan->'items') loop
  actual:=public.workforce_dispute_snapshot_value(revised.snapshot,item);
  if actual is null and (item->>'proposed_value')::numeric=0 and item->>'selector'='deduction' then actual:=0; end if;
  if actual is null or abs(actual-(item->>'proposed_value')::numeric)>.005 then
   update public.workforce_dispute_application_jobs set last_error='Revised payout does not yet match every approved source item.',updated_at=now() where dispute_id=d.id returning * into j;return to_jsonb(j);
  end if;
 end loop;
 before_net:=round((p.snapshot#>>'{item,net_amount}')::numeric*100);after_net:=round((revised.snapshot#>>'{item,net_amount}')::numeric*100);delta:=after_net-before_net;
 if delta is null or d.correction_plan->>'expected_delta_paise' is null or delta<>(d.correction_plan->>'expected_delta_paise')::bigint then
  update public.workforce_dispute_application_jobs set last_error='Revised net payout differs from the approved impact. Finance review is required.',updated_at=now() where dispute_id=d.id returning * into j;return to_jsonb(j);
 end if;
 update public.workforce_payout_disputes set status='resolved',processed_publication_id=revised.id,processed_at=now(),processor_name='System',resolution='Approved source correction applied and revised payout verified.',resolved_at=now(),
  processing_result=jsonb_build_object('verified_before_net_paise',before_net,'verified_after_net_paise',after_net,'verified_delta_paise',delta,'publication_net_change_verified',true,'automatic_source_application',true),version=version+1,updated_at=now() where id=d.id returning * into d;
 update public.workforce_dispute_application_jobs set state='completed',publication_id=revised.id,last_error=null,updated_at=now() where dispute_id=d.id returning * into j;
 insert into public.workforce_payout_dispute_events(company_id,dispute_id,actor_name,portal,message,event_type,from_status,to_status,metadata,dispute_version)
 values(p_company,d.id,'System','ops',d.resolution,'source_application_verified','approved_for_processing','resolved',d.processing_result,d.version);
 return to_jsonb(j);
end $$;
revoke all on function public.workforce_verify_dispute_application(uuid,uuid) from public,anon,authenticated;
grant execute on function public.workforce_verify_dispute_application(uuid,uuid) to service_role;

CREATE OR REPLACE FUNCTION public.nl_loss_recovery_due(p_company uuid, p_salary_month text, p_target text, p_run_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(recovery_key text, month text, case_key text, report text, employee_ref text, worker_id uuid, employee_code text, full_name text, amount numeric, deduction_month text, label text, installment_no integer, installment_count integer, cap_exempt boolean, cap_percent numeric, final_settlement boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 with policy as (
  select coalesce(s.recovery_policy->>'payroll_start_month','2026-10') start_month,
   100::numeric cap_percent
  from nl_loss_sources s where s.company_id=p_company limit 1),
 bounds as (
  select (to_date(p_salary_month,'YYYY-MM')+interval '1 month'-interval '1 day')::date last_day,
   case when p_target='workforce' then to_date(p_salary_month,'YYYY-MM') end excluded_period
  where p_salary_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
 allocs as (
  select r.month, r.case_key, c.report, r.deduction_month, r.cap_override, x alloc, x->>'ref' employee_ref,
   nl_recovery_person_exit(p_company,x->>'ref') exit_date,
   upper(c.report)||' loss · '||to_char(to_date(r.month,'YYYY-MM'),'Mon YYYY')||' · '||regexp_replace(r.case_key,'^slp:','') base_label
  from nl_loss_recoveries r
  join nl_loss_month_cases c on c.company_id=r.company_id and c.month=r.month and c.case_key=r.case_key
  cross join jsonb_array_elements(r.allocations) x
  cross join policy cross join bounds
  where p_salary_month>=policy.start_month -- Payroll start boundary
   and r.company_id=p_company
   -- Redispute payroll gate
   and not exists(select 1 from nl_case_response_windows rw where rw.company_id=r.company_id and rw.month=r.month and rw.case_key=r.case_key and (rw.enabled or rw.workflow_status='won' or rw.recovery_month>p_salary_month))
   and not r.is_deleted and r.deduction_timing<>'none' and r.deduction_month is not null
   and r.approval_status = 'approved'
   and c.lifecycle_status in ('recovery_approved_scheduled','recovery_in_progress','exit_balance')
   and greatest(r.deduction_month,policy.start_month)<=p_salary_month
   and ((p_target='hrms' and split_part(x->>'ref',':',1) in ('employee','contractor')) or (p_target='workforce' and split_part(x->>'ref',':',1)='workforce'))
   and coalesce((x->>'amount')::numeric,0)>0
   and c.source_present and round(c.amount,2)=round(r.source_amount,2)
   and nl_case_recoverable(p_company,c.report,c.source_status)
   and (c.report<>'slp' or c.final_seen_at is not null)
   and not exists(select 1 from nl_recovery_waivers w
     where w.company_id=r.company_id and w.month=r.month and w.case_key=r.case_key and w.employee_ref=x->>'ref')),
 lines as (
  select k.recovery_key, a.month, a.case_key, a.report, a.employee_ref, split_part(a.employee_ref,':',2)::uuid worker_id,
   a.alloc->>'employee_code' employee_code, a.alloc->>'full_name' full_name, public.nl_dispute_recovery_amount(p_company,k.recovery_key,k.amount) amount, a.deduction_month,
   k.installment_no, nullif(jsonb_array_length(coalesce(a.alloc->'installments','[]')),0) installment_count,
   a.exit_date is not null and a.exit_date<=b.last_day final_settlement, a.cap_override, a.base_label,
   nl_recovery_key(a.month,a.case_key,a.employee_ref) base_key, b.excluded_period,
   greatest(a.deduction_month,policy.start_month) scheduled_month
  from allocs a cross join bounds b cross join policy
  cross join lateral nl_recovery_alloc_keys(a.month,a.case_key,a.alloc) k
  where public.nl_dispute_recovery_amount(p_company,k.recovery_key,k.amount)>0)
 select l.recovery_key, l.month, l.case_key, l.report, l.employee_ref, l.worker_id, l.employee_code, l.full_name, l.amount, l.deduction_month,
  l.base_label||case when l.installment_no is not null then ' · instalment '||l.installment_no||' of '||l.installment_count else '' end
   ||case when l.final_settlement then ' · final settlement' else '' end,
  l.installment_no, l.installment_count, l.cap_override or l.final_settlement, p.cap_percent, l.final_settlement
 from lines l cross join policy p
 where nl_recovery_line_applied(p_company,l.recovery_key,p_run_id,l.excluded_period) is null
  and (l.installment_no is null or l.installment_no=1 or l.final_settlement
   or nl_recovery_line_applied(p_company,l.base_key||'|'||(l.installment_no-1),p_run_id,l.excluded_period)<p_salary_month)
  -- Due-month window: stay on the scheduled month while any earlier open payroll still owns it.
  and (
    l.final_settlement
    or l.scheduled_month=p_salary_month
    or not exists (
      select 1
      from generate_series(
        to_date(l.scheduled_month,'YYYY-MM'),
        to_date(p_salary_month,'YYYY-MM') - interval '1 month',
        interval '1 month'
      ) m
      where loss_recovery_open_payroll(p_company, l.employee_ref, to_char(m::date,'YYYY-MM'))
    )
  )
 order by l.deduction_month,l.month,l.case_key,l.employee_ref,l.installment_no nulls first
$function$;

CREATE OR REPLACE FUNCTION public.nl_recovery_ledger(p_company uuid, p_from_month text DEFAULT NULL::text, p_ref text DEFAULT NULL::text)
 RETURNS TABLE(month text, case_key text, report text, station_code text, employee_ref text, employee_code text, full_name text, recovery_mode text, installment_count integer, monthly_amount numeric, total numeric, deducted numeric, in_payroll numeric, waived numeric, outstanding numeric, deducted_count integer, first_salary_month text, last_deducted_in text, exit_date date, cap_override boolean, outcome_label text, assigned_at timestamp with time zone, updated_by_name text, waiver_reason text, waived_by_name text, status text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 with lines as (
  select r.month, r.case_key, c.report, c.station_code, a->>'ref' ref, a->>'employee_code' code, a->>'full_name' name,
   r.recovery_mode, nullif(jsonb_array_length(coalesce(a->'installments','[]')),0) n_count,
   round(coalesce((a->>'monthly_amount')::numeric,(a->>'amount')::numeric),2) monthly, round((a->>'amount')::numeric,2) total,
   r.deduction_month, r.cap_override, r.outcome_label, r.assigned_at, r.updated_by_name, a alloc,
   c.source_present and round(c.amount,2)=round(r.source_amount,2) and nl_case_recoverable(p_company,c.report,c.source_status) source_ok
  from nl_loss_recoveries r
  join nl_loss_month_cases c on c.company_id=r.company_id and c.month=r.month and c.case_key=r.case_key
  cross join jsonb_array_elements(r.allocations) a
  where r.company_id=p_company and not r.is_deleted and r.deduction_timing<>'none'
   and (p_from_month is null or r.month>=p_from_month) and (p_ref is null or a->>'ref'=p_ref)),
 keyed as (
  select l.month,l.case_key,l.ref,public.nl_dispute_recovery_amount(p_company,k.recovery_key,k.amount) amount,
   nl_recovery_line_applied(p_company,k.recovery_key,null,null,true) final_in,
   nl_recovery_line_applied(p_company,k.recovery_key,null,null,false) any_in
  from lines l cross join lateral nl_recovery_alloc_keys(l.month,l.case_key,l.alloc) k),
 sums as (
  select month,case_key,ref,
   coalesce(sum(amount) filter (where final_in is not null),0) deducted,
   coalesce(sum(amount) filter (where final_in is null and any_in is not null),0) in_payroll,
   count(*) filter (where final_in is not null)::int deducted_count, max(final_in) last_in
  from keyed group by 1,2,3)
 select l.month,l.case_key,l.report,l.station_code,l.ref,l.code,l.name,l.recovery_mode,l.n_count,l.monthly,l.total,
  s.deducted,s.in_payroll,least(l.total,coalesce(w.amount,0)+coalesce(adj.written_off,0)),case when rw.workflow_status='won' then 0 else greatest(0,l.total-s.deducted-least(l.total,coalesce(w.amount,0)+coalesce(adj.written_off,0))) end,s.deducted_count,greatest(l.deduction_month,rw.recovery_month),s.last_in,
  coalesce((l.alloc->>'left_on')::date,nl_recovery_person_exit(p_company,l.ref)),l.cap_override,l.outcome_label,l.assigned_at,l.updated_by_name,coalesce(adj.reasons,w.reason),coalesce(adj.names,w.decided_by_name),
  case when rw.workflow_status='won' then 'redispute_won' when rw.enabled then 'redispute_pending'
   when coalesce(w.amount,0)+coalesce(adj.written_off,0)>0 and l.total-s.deducted-coalesce(w.amount,0)-coalesce(adj.written_off,0)<=0 then 'written_off'
   when s.deducted>=l.total then 'recovered'
   when not l.source_ok then 'needs_review'
   when coalesce((l.alloc->>'left_on')::date,nl_recovery_person_exit(p_company,l.ref)) is not null then 'exit_balance'
   when s.deducted>0 or s.in_payroll>0 then 'in_progress'
   else 'scheduled' end
 from lines l join sums s on s.month=l.month and s.case_key=l.case_key and s.ref=l.ref
 -- Redispute ledger state
 left join nl_case_response_windows rw on rw.company_id=p_company and rw.month=l.month and rw.case_key=l.case_key
 left join nl_recovery_waivers w on w.company_id=p_company and w.month=l.month and w.case_key=l.case_key and w.employee_ref=l.ref
 left join lateral (select sum(x.amount) filter(where x.treatment='write_off') written_off,
 string_agg(x.reason,'; ' order by x.created_at) reasons,string_agg(distinct x.decided_by_name,', ') names
 from public.nl_payout_dispute_adjustments x where x.company_id=p_company and x.month=l.month and x.case_key=l.case_key and x.employee_ref=l.ref) adj on true
 order by l.month desc,l.case_key,l.code
$function$;

create or replace function public.workforce_pause_dispute_application(p_company uuid,p_dispute uuid,p_message text)
returns void language sql security definer set search_path='' as $$
 update public.workforce_dispute_application_jobs set state='blocked',attempts=3,last_error=left(p_message,1500),updated_at=now()
 where company_id=p_company and dispute_id=p_dispute and state<>'completed';
$$;
revoke all on function public.workforce_pause_dispute_application(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.workforce_pause_dispute_application(uuid,uuid,text) to service_role;

CREATE OR REPLACE FUNCTION public.workforce_dispute_transition_v3(p_company uuid, p_dispute uuid, p_actor uuid, p_actor_name text, p_actor_role_ids uuid[], p_action text, p_expected_version integer, p_locations uuid[], p_payload jsonb)
 RETURNS workforce_payout_disputes
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare d public.workforce_payout_disputes; saved public.workforce_payout_disputes; source jsonb; revised jsonb; item jsonb; expected numeric; actual numeric; stage text; role_id uuid; note text:=trim(p_payload->>'note'); plan jsonb;
begin
  select * into d from public.workforce_payout_disputes where id=p_dispute and company_id=p_company for update;
  if not found or (p_locations is not null and not(d.station_id=any(p_locations))) then raise exception 'Dispute is outside your scope.'; end if;
  if p_expected_version is null or d.version<>p_expected_version then raise exception 'This request changed. Refresh before continuing.'; end if;
  if p_action='return_review' and exists(select 1 from public.workforce_dispute_application_jobs j where j.dispute_id=d.id and j.applied_at is not null) then raise exception 'Source correction is already applied. Use processing to verify the revised payout.'; end if;
  if p_action in ('request_clarification','return_review') then
    stage:=case when d.status='open' then 'initial' when d.status in ('in_review','pending_final_approval') then 'final' when d.status in ('approved_for_processing','processing','processing_blocked') then 'processor' end;
    if stage is null or (p_action='request_clarification' and stage<>'initial') then raise exception 'This request is not at the required review stage.'; end if;
    select r.role_id into role_id from public.workforce_payout_dispute_route_roles(p_company,jsonb_build_array(jsonb_build_object('dispute_id',d.id,'stage',stage))) r;
    if p_actor is null or (not coalesce(role_id=any(p_actor_role_ids),false) and not (stage in ('initial','final') and public.workforce_dispute_manager_can_review(p_company,p_actor,p_actor_role_ids,d.station_id))) then raise exception 'Only the configured reviewer can act.'; end if;
    if stage='final' and p_actor=coalesce(d.initial_reviewed_by,d.proposed_by) then raise exception 'A different final reviewer must act.'; end if;
    if stage='processor' and (p_actor in (d.initial_reviewed_by,d.final_approved_by) or (d.status='processing' and d.processor_id is distinct from p_actor)) then raise exception 'Only the independent assigned processor can return this request.'; end if;
    if length(coalesce(note,'')) not between 5 and 1000 then raise exception 'Write a short explanation.'; end if;
    update public.workforce_payout_disputes set status='open',details=details||jsonb_build_object('awaiting_reply',p_action='request_clarification','question',note),
      proposed_decision=null,proposed_note=null,proposed_by=null,proposed_by_name=null,proposed_at=null,correction_plan=null,
      initial_reviewed_by=null,initial_reviewed_by_name=null,initial_reviewed_at=null,final_approved_by=null,final_approved_by_name=null,final_approved_at=null,
      processor_id=null,processor_name=null,processor_claimed_at=null,version=version+1,updated_at=now() where id=d.id returning * into saved;
    insert into public.workforce_payout_dispute_events(company_id,dispute_id,actor_id,actor_name,portal,message,event_type,from_status,to_status,dispute_version)
    values(p_company,d.id,p_actor,p_actor_name,'ops',note,p_action,d.status,'open',saved.version);
    return saved;
  end if;
  if p_action='propose_correction' then
    if d.details->>'awaiting_reply'='true' then raise exception 'Wait for the associate to reply before proposing a correction.'; end if;
    plan:=p_payload->'correction_plan';
    if coalesce(plan->>'schema','')<>'3' or jsonb_array_length(coalesce(plan->'items','[]'))=0 then raise exception 'Open guided review and validate the affected items first.'; end if;
  end if;
  if p_action in ('approve_final','complete_processing') and d.proposed_decision='resolved' and coalesce(d.correction_plan->>'schema','')<>'3' then raise exception 'This older proposal needs guided recalculation. Return it for review; previous approvals remain in history.'; end if;
  if p_action='complete_processing' then
    select snapshot into source from public.workforce_payout_publications where id=d.publication_id and company_id=p_company;
    select snapshot into revised from public.workforce_payout_publications where id=(p_payload->>'processed_publication_id')::uuid and company_id=p_company;
    for item in select value from jsonb_array_elements(d.correction_plan->'items') loop
      expected:=(item->>'proposed_value')::numeric;
      actual:=public.workforce_dispute_snapshot_value(revised,item);
      -- Removing a known deduction/addition is represented by no line in the revised payout.
      if actual is null and expected=0 and item->>'selector' in ('deduction','addition','incentive') then actual:=0; end if;
      if actual is null or abs(actual-expected)>0.005 then raise exception 'The revised payout does not contain the approved correction for %. Correct that source item and republish.',item->>'target_field'; end if;
      actual:=public.workforce_dispute_snapshot_value(source,item);
      if actual is null or abs(actual-(item->>'current_value')::numeric)>0.005 then raise exception 'The approved baseline does not match the disputed source item.'; end if;
    end loop;
  end if;
  saved:=public.workforce_dispute_transition_v2(p_company,p_dispute,p_actor,p_actor_name,p_actor_role_ids,p_action,p_expected_version,p_locations,p_payload);
  if p_action='propose_correction' then
    update public.workforce_payout_disputes set details=details||(p_payload#>'{correction_plan,claim}') where id=d.id returning * into saved;
  end if;
  if p_action='approve_final' and saved.status='approved_for_processing' then
    perform public.workforce_queue_dispute_application(p_company,saved.id,p_payload->'loss_balance');
    select * into saved from public.workforce_payout_disputes where id=saved.id;
  end if;
  if p_action='claim_processing' then perform public.workforce_pause_dispute_application(p_company,d.id,'Claimed by the independent payout processor.'); end if;
  return saved;
end $function$;
