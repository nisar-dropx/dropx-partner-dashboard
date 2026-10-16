begin;
-- Team Ops → Losses: a recovery is a full debit (one deduction) or a recurring debit (instalments).
--
-- Recurring debit. Each person's share is split into a schedule, either over N months or at a fixed
-- amount per month. Instalment n is the plan line month|case|ref|n; a full debit keeps month|case|ref,
-- so lines payroll already carries are untouched. One instalment per person per payroll: instalment n
-- is due once instalment n-1 is in an earlier salary month's payroll. A missed month shifts the rest.
--
-- Salary cap. By default the loss recoveries of one payroll take at most salary_cap_percent (50%) of
-- take-home; a plan saved with a recorded cap override may use the whole take-home. The cap is checked
-- on the monthly amount when the plan is saved, and again by payroll on the real take-home.
--
-- Exit. When a person's last working day falls in or before the salary month, every remaining
-- instalment is due in that final settlement, uncapped. What the final settlement cannot carry stays
-- outstanding in the ledger until HR recovers it or writes it off with a reason.

alter table public.nl_loss_recoveries add column if not exists recovery_mode text not null default 'full';
alter table public.nl_loss_recoveries add column if not exists installment_basis text;
alter table public.nl_loss_recoveries add column if not exists installment_value numeric(14,2);
alter table public.nl_loss_recoveries add column if not exists cap_override boolean not null default false;
alter table public.nl_loss_recoveries add column if not exists cap_override_reason text;
alter table public.nl_loss_recoveries drop constraint if exists nl_recovery_mode_check;
alter table public.nl_loss_recoveries add constraint nl_recovery_mode_check check (
 recovery_mode in ('full','installments')
 and ((recovery_mode='full' and installment_basis is null and installment_value is null)
  or (recovery_mode='installments' and installment_basis in ('months','amount') and installment_value>0))
 and (not cap_override or length(trim(coalesce(cap_override_reason,'')))>=10)
);
alter table public.nl_recovery_payables add column if not exists gross numeric(14,2);

-- 50% of take-home by default; at most 24 instalments.
update public.nl_loss_sources set recovery_policy=recovery_policy||'{"salary_cap_percent":50}'::jsonb
 where coalesce((recovery_policy->>'salary_cap_percent')::numeric,100)=100 and not (recovery_policy ? 'max_installments');
update public.nl_loss_sources set recovery_policy=recovery_policy||'{"max_installments":24}'::jsonb
 where not (recovery_policy ? 'max_installments');

-- HR writes off what an exited person's final settlement could not recover. One decision per plan line.
create table if not exists public.nl_recovery_waivers (
 company_id uuid not null, month text not null, case_key text not null, employee_ref text not null,
 amount numeric(14,2) not null check (amount>0), reason text not null check (length(trim(reason)) between 10 and 2000),
 decided_by uuid not null, decided_by_name text not null, created_at timestamptz not null default now(),
 primary key(company_id,month,case_key,employee_ref),
 foreign key(company_id,month,case_key) references public.nl_loss_month_cases(company_id,month,case_key)
);
alter table public.nl_recovery_waivers enable row level security;
revoke all on public.nl_recovery_waivers from anon,authenticated;
grant all on public.nl_recovery_waivers to service_role;

-- Every payroll key of one allocation: the full-debit key, or one key per instalment.
create or replace function public.nl_recovery_alloc_keys(p_month text,p_case text,p_alloc jsonb)
returns table(recovery_key text,installment_no int,amount numeric) language sql immutable set search_path=public as $$
 select nl_recovery_key(p_month,p_case,p_alloc->>'ref'),null::int,round((p_alloc->>'amount')::numeric,2)
  where jsonb_array_length(coalesce(p_alloc->'installments','[]'))=0
 union all
 select nl_recovery_key(p_month,p_case,p_alloc->>'ref')||'|'||(i->>'n'),(i->>'n')::int,round((i->>'amount')::numeric,2)
  from jsonb_array_elements(coalesce(p_alloc->'installments','[]')) i
$$;

-- The last working day of a plan person, or null while employed.
create or replace function public.nl_recovery_person_exit(p_company uuid,p_ref text) returns date language sql stable security invoker set search_path=public as $$
 select case split_part(p_ref,':',1)
  when 'employee' then (select e.last_working_date from employees e where e.company_id=p_company and e.id=split_part(p_ref,':',2)::uuid)
  when 'workforce' then (select w.last_working_date from workforce w where w.company_id=p_company and w.id=split_part(p_ref,':',2)::uuid)
 end
$$;

drop function if exists public.nl_loss_recovery_due(uuid,text,text,uuid);
create function public.nl_loss_recovery_due(p_company uuid,p_salary_month text,p_target text,p_run_id uuid default null)
returns table(recovery_key text,month text,case_key text,report text,employee_ref text,worker_id uuid,employee_code text,full_name text,amount numeric,deduction_month text,label text,
 installment_no int,installment_count int,cap_exempt boolean,cap_percent numeric,final_settlement boolean)
language sql stable security invoker set search_path=public as $$
 with policy as (
  select coalesce(s.recovery_policy->>'payroll_start_month','2026-10') start_month,
   case when coalesce((s.recovery_policy->>'salary_cap_enabled')::boolean,false) then least(100,greatest(1,coalesce((s.recovery_policy->>'salary_cap_percent')::numeric,100))) else 100 end cap_percent
  from nl_loss_sources s where s.company_id=p_company limit 1),
 bounds as (select (to_date(p_salary_month,'YYYY-MM')+interval '1 month'-interval '1 day')::date last_day,
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
  where p_salary_month>=policy.start_month
   and r.company_id=p_company and not r.is_deleted and r.deduction_timing<>'none' and r.deduction_month is not null
   and greatest(r.deduction_month,policy.start_month)<=p_salary_month
   and split_part(x->>'ref',':',1)=case p_target when 'hrms' then 'employee' when 'workforce' then 'workforce' end
   and coalesce((x->>'amount')::numeric,0)>0
   -- Only a plan for the source's current, still-recoverable amount. A changed case waits for review in Losses.
   and c.source_present and round(c.amount,2)=round(r.source_amount,2)
   and nl_case_recoverable(p_company,c.report,c.source_status)
   and (c.report<>'slp' or c.final_seen_at is not null)
   and not exists(select 1 from nl_recovery_waivers w where w.company_id=r.company_id and w.month=r.month and w.case_key=r.case_key and w.employee_ref=x->>'ref')),
 lines as (
  select k.recovery_key, a.month, a.case_key, a.report, a.employee_ref, split_part(a.employee_ref,':',2)::uuid worker_id,
   a.alloc->>'employee_code' employee_code, a.alloc->>'full_name' full_name, k.amount, a.deduction_month,
   k.installment_no, nullif(jsonb_array_length(coalesce(a.alloc->'installments','[]')),0) installment_count,
   a.exit_date is not null and a.exit_date<=b.last_day final_settlement, a.cap_override, a.base_label,
   nl_recovery_key(a.month,a.case_key,a.employee_ref) base_key, b.excluded_period
  from allocs a cross join bounds b cross join lateral nl_recovery_alloc_keys(a.month,a.case_key,a.alloc) k
  where k.amount>0)
 select l.recovery_key, l.month, l.case_key, l.report, l.employee_ref, l.worker_id, l.employee_code, l.full_name, l.amount, l.deduction_month,
  l.base_label||case when l.installment_no is not null then ' · instalment '||l.installment_no||' of '||l.installment_count else '' end
   ||case when l.final_settlement then ' · final settlement' else '' end,
  l.installment_no, l.installment_count, l.cap_override or l.final_settlement, p.cap_percent, l.final_settlement
 from lines l cross join policy p
 where nl_recovery_line_applied(p_company,l.recovery_key,p_run_id,l.excluded_period) is null
  -- One instalment per payroll: the previous one must already be in an earlier salary month. An exit recovers all.
  and (l.installment_no is null or l.installment_no=1 or l.final_settlement
   or nl_recovery_line_applied(p_company,l.base_key||'|'||(l.installment_no-1),p_run_id,l.excluded_period)<p_salary_month)
 order by l.deduction_month,l.month,l.case_key,l.employee_ref,l.installment_no nulls first
$$;

-- Plan people whose deduction (any instalment) a reviewed/approved HRMS run or a published payout carries.
create or replace function public.nl_recovery_locked_lines(p_company uuid,p_month text,p_case text)
returns table(employee_ref text,applied_in text) language sql stable security invoker set search_path=public as $$
 select x.ref, min(x.applied_in) from (
  select a->>'ref' ref, nl_recovery_line_applied(p_company,k.recovery_key,null,null,true) applied_in
  from nl_loss_recoveries r cross join jsonb_array_elements(r.allocations) a cross join lateral nl_recovery_alloc_keys(p_month,p_case,a) k
  where r.company_id=p_company and r.month=p_month and r.case_key=p_case) x
 where x.applied_in is not null
 group by x.ref
$$;

-- One trail from loss to deduction: every plan line with what payroll deducted and what is still due.
create or replace function public.nl_recovery_ledger(p_company uuid,p_from_month text default null,p_ref text default null)
returns table(month text,case_key text,report text,station_code text,employee_ref text,employee_code text,full_name text,
 recovery_mode text,installment_count int,monthly_amount numeric,total numeric,deducted numeric,in_payroll numeric,waived numeric,outstanding numeric,
 deducted_count int,first_salary_month text,last_deducted_in text,exit_date date,cap_override boolean,outcome_label text,assigned_at timestamptz,updated_by_name text,
 waiver_reason text,waived_by_name text,status text)
language sql stable security invoker set search_path=public as $$
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
  select l.month,l.case_key,l.ref,k.amount,
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
  s.deducted,s.in_payroll,coalesce(w.amount,0),greatest(0,l.total-s.deducted-coalesce(w.amount,0)),s.deducted_count,l.deduction_month,s.last_in,
  nl_recovery_person_exit(p_company,l.ref),l.cap_override,l.outcome_label,l.assigned_at,l.updated_by_name,w.reason,w.decided_by_name,
  case when w.amount is not null then 'written_off'
   when s.deducted>=l.total then 'recovered'
   when not l.source_ok then 'needs_review'
   when nl_recovery_person_exit(p_company,l.ref) is not null then 'exit_balance'
   when s.deducted>0 or s.in_payroll>0 then 'in_progress'
   else 'scheduled' end
 from lines l join sums s on s.month=l.month and s.case_key=l.case_key and s.ref=l.ref
 left join nl_recovery_waivers w on w.company_id=p_company and w.month=l.month and w.case_key=l.case_key and w.employee_ref=l.ref
 order by l.month desc,l.case_key,l.code
$$;

-- HR writes off the outstanding balance of an exited person's plan line, with a reason. Never what payroll took.
create or replace function public.waive_nl_recovery_balance(p_company uuid,p_month text,p_case text,p_ref text,p_reason text,p_actor uuid,p_name text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare l record; saved nl_recovery_waivers;
begin
 perform pg_advisory_xact_lock(hashtextextended('nl-recovery:'||p_company::text,0));
 if length(trim(coalesce(p_reason,''))) not between 10 and 2000 then raise exception 'Give a clear write-off reason (10–2,000 characters).'; end if;
 select * into l from nl_recovery_ledger(p_company,p_month,p_ref) x where x.month=p_month and x.case_key=p_case;
 if not found then raise exception 'This recovery line was not found. Refresh the ledger.'; end if;
 if l.status='written_off' then raise exception 'This balance is already written off.'; end if;
 if l.exit_date is null then raise exception 'Only the balance of a person who has exited can be written off. Active people recover it through payroll.'; end if;
 if l.in_payroll>0 then raise exception 'An instalment is in a payroll that is not reviewed yet. Finish that payroll first.'; end if;
 if l.outstanding<=0 then raise exception 'Nothing is outstanding on this line.'; end if;
 insert into nl_recovery_waivers(company_id,month,case_key,employee_ref,amount,reason,decided_by,decided_by_name)
 values(p_company,p_month,p_case,p_ref,l.outstanding,trim(p_reason),p_actor,p_name) returning * into saved;
 insert into nl_loss_recovery_events(company_id,month,case_key,before_value,after_value,actor_id,actor_name)
 values(p_company,p_month,p_case,null,jsonb_build_object('write_off',to_jsonb(saved)),p_actor,p_name);
 if p_ref like 'workforce:%' then perform nl_recovery_bump_payout_months(p_company,array[l.first_salary_month]); end if;
 return to_jsonb(saved);
end $$;

drop function if exists public.save_nl_recovery(uuid,text,text,int,text,text,jsonb,text,uuid,text,jsonb);
create or replace function public.save_nl_recovery(p_company uuid,p_month text,p_case text,p_version int,p_outcome text,p_mode text,p_allocations jsonb,p_remarks text,p_actor uuid,p_name text,p_details jsonb default '{}',p_plan jsonb default '{}')
returns jsonb language plpgsql security invoker set search_path=public as $$
declare c nl_loss_month_cases; o nl_recovery_outcomes; old nl_loss_recoveries; saved nl_loss_recoveries; a jsonb; people jsonb:='[]'; person jsonb; station uuid; total bigint:=0; expected bigint; n int; i int:=0; amt bigint; deduction text; policy jsonb; settings_updated timestamptz; pay nl_recovery_payables; pay_month text; reserved numeric; cap numeric; attachment jsonb; assigned timestamptz; same_plan boolean; locked record;
 v_mode text:=coalesce(nullif(p_plan->>'mode',''),'full'); v_basis text:=nullif(p_plan->>'basis',''); v_value numeric; v_override boolean:=coalesce((p_plan->>'cap_override')::boolean,false); v_override_reason text:=nullif(trim(coalesce(p_plan->>'cap_override_reason','')),'');
 max_k int; k int; per bigint; rem bigint; monthly bigint; schedule jsonb; j int;
begin
 -- Serialize plans across cases so two submissions cannot consume the same salary capacity.
 perform pg_advisory_xact_lock(hashtextextended('nl-recovery:'||p_company::text,0));
 select recovery_policy,updated_at into policy,settings_updated from nl_loss_sources where company_id=p_company;
 max_k:=least(60,greatest(2,coalesce((policy->>'max_installments')::int,24)));
 pay_month:=to_char(date_trunc('month',now() at time zone 'Asia/Kolkata')-make_interval(months=>(policy->>'salary_month_offset')::int),'YYYY-MM');
 select * into c from nl_loss_month_cases where company_id=p_company and month=p_month and case_key=p_case for update;
 if not found or not c.source_present or not nl_case_recoverable(p_company,c.report,c.source_status) then raise exception 'This case is no longer recoverable at source. Refresh the list.'; end if;
 select * into o from nl_recovery_outcomes where company_id=p_company and code=p_outcome and is_active;
 if not found then raise exception 'Choose an active outcome from Loss Recovery Master.'; end if;
 if p_remarks is null or length(trim(p_remarks))>2000 or (o.remarks_required and length(trim(p_remarks))<5) then raise exception 'Add a clear recovery remark (5–2,000 characters).'; end if;
 -- Recovery mode: full debit or instalments, validated before any person is checked.
 if not o.allocation_required then v_mode:='full'; v_basis:=null; v_override:=false; v_override_reason:=null; end if;
 if v_mode not in ('full','installments') then raise exception 'Choose Full debit or Recurring debit.'; end if;
 if v_mode='installments' then
  if coalesce(v_basis,'') not in ('months','amount') then raise exception 'Choose instalments by number of months or by amount per month.'; end if;
  if coalesce(p_plan->>'value','') !~ '^\d+(\.\d{1,2})?$' then raise exception 'Enter the number of months or the monthly amount.'; end if;
  v_value:=(p_plan->>'value')::numeric;
  if v_basis='months' and (v_value<>trunc(v_value) or v_value<2 or v_value>max_k) then raise exception 'Instalments must be between 2 and % months.',max_k; end if;
  if v_basis='amount' and v_value<1 then raise exception 'The monthly amount must be at least ₹1.'; end if;
 else
  v_basis:=null; v_value:=null;
 end if;
 if v_override and (v_override_reason is null or length(v_override_reason)<10 or length(v_override_reason)>500) then raise exception 'Give a reason for recovering beyond the salary cap (10–500 characters).'; end if;
 if not v_override then v_override_reason:=null; end if;
 if o.dispute_fields_enabled then
  if o.reason_required and length(trim(coalesce(p_details->>'reason','')))<5 then raise exception 'Reason for re-dispute is required (at least 5 characters).'; end if;
  if o.details_required and length(trim(coalesce(p_details->>'details','')))<5 then raise exception 'Detailing is required (at least 5 characters).'; end if;
  if length(coalesce(p_details->>'reason',''))>2000 or length(coalesce(p_details->>'details',''))>10000 then raise exception 'Re-dispute text is too long.'; end if;
  if nullif(p_details->>'cctv_url','') is not null then
   if not o.cctv_enabled or (p_details->>'cctv_url') !~ '^https://[^[:space:]]+$' then raise exception 'Enter a valid HTTPS CCTV link.'; end if;
   if (policy->>'cctv_public_confirmation')::boolean and coalesce((p_details->>'cctv_public_confirmed')::boolean,false)=false then raise exception 'Confirm CCTV sharing is set to anyone with the link can view.'; end if;
  end if;
  if jsonb_typeof(coalesce(p_details->'attachments','[]'))<>'array' or jsonb_array_length(coalesce(p_details->'attachments','[]'))>(policy->>'attachment_max_count')::int then raise exception 'Too many attachments.'; end if;
  for attachment in select value from jsonb_array_elements(coalesce(p_details->'attachments','[]')) loop
   if not o.attachments_enabled or not exists(select 1 from nl_recovery_attachments f where f.company_id=p_company and f.month=p_month and f.case_key=p_case and f.id::text=attachment->>'id') then raise exception 'Attachment is not linked to this case.'; end if;
  end loop;
 else
  p_details:='{}';
 end if;
 select * into old from nl_loss_recoveries where company_id=p_company and month=p_month and case_key=p_case;
 if coalesce(old.version,0)<>p_version then raise exception 'Another person updated this recovery. Refresh before saving.'; end if;
 if jsonb_typeof(p_allocations)<>'array' or jsonb_array_length(p_allocations)>50 then raise exception 'Select up to 50 employees.'; end if;
 select s.id into station from stations s left join cod_station_settings x on x.location_id=s.id and x.company_id=p_company
  where s.company_id=p_company and upper(coalesce(nullif(x.portal_station_code,''),s.station_code))=upper(c.station_code) order by (s.station_code=c.station_code) desc limit 1;
 if station is null then raise exception 'Map the source station before allocating recovery.'; end if;
 if o.allocation_required then
  -- SLP Initial is a report only; people are charged once the case is in the SLP Final file.
  if c.report='slp' and c.final_seen_at is null then raise exception 'This SLP case is still in SLP Initial. Assign employees once it is in the SLP Final file.'; end if;
  if not exists(select 1 from nl_loss_sources where company_id=p_company and ((p_mode='equal' and allow_equal_split) or (p_mode='custom' and allow_custom_split))) then raise exception 'This split method is disabled in Master.'; end if;
  n:=jsonb_array_length(p_allocations); expected:=round(c.amount*100);
  if n<1 or expected is null or expected<=0 or p_mode not in ('equal','custom') then raise exception 'Select employees and a valid split for the full loss value.'; end if;
  if (select count(distinct x->>'employee_ref') from jsonb_array_elements(p_allocations)x)<>n then raise exception 'An employee can only be selected once.'; end if;
  for a in select value from jsonb_array_elements(p_allocations) loop
   select to_jsonb(d) into person from station_audit_employee_directory(p_company,station)d where d.ref=a->>'employee_ref';
   if not coalesce((person->>'is_active')::boolean,false) and not exists(select 1 from nl_loss_sources where company_id=p_company and include_inactive_people) then raise exception 'Inactive employees are disabled in Master.'; end if;
   if person is null then raise exception 'Selected employee is not linked to this station.'; end if;
   if nullif(trim(person->>'employee_code'),'') is null then raise exception 'Every selected employee must have a valid employee ID.'; end if;
   if p_mode='equal' then amt:=expected/n+case when i<expected%n then 1 else 0 end;
   else
    if coalesce(a->>'amount','') !~ '^\d+(\.\d{1,2})?$' then raise exception 'Enter amounts with at most two decimal places.'; end if;
    amt:=((a->>'amount')::numeric*100)::bigint;
   end if;
   if amt<=0 then raise exception 'Every selected employee must have a positive amount.'; end if;
   -- The schedule in paise: equal months (the first instalments take the remainder) or a fixed monthly amount.
   schedule:='[]';
   if v_mode='installments' then
    if v_basis='months' then
     k:=v_value::int;
     if amt<k*100 then raise exception 'The share of % is too small for % instalments. Use fewer months or Full debit.',person->>'employee_code',k; end if;
     per:=amt/k; rem:=amt%k;
     for j in 1..k loop schedule:=schedule||jsonb_build_array(jsonb_build_object('n',j,'amount',round((per+case when j<=rem then 1 else 0 end)::numeric/100,2))); end loop;
    else
     per:=round(v_value*100)::bigint;
     if per>=amt then raise exception 'The monthly amount covers the whole share of %. Use Full debit instead.',person->>'employee_code'; end if;
     k:=((amt+per-1)/per)::int;
     if k>max_k then raise exception 'At ₹% a month the share of % needs % instalments; the maximum is %. Raise the monthly amount.',v_value,person->>'employee_code',k,max_k; end if;
     for j in 1..k loop schedule:=schedule||jsonb_build_array(jsonb_build_object('n',j,'amount',round(least(per,amt-(j-1)*per)::numeric/100,2))); end loop;
    end if;
    monthly:=((schedule->0->>'amount')::numeric*100)::bigint;
   else
    monthly:=amt;
   end if;
   select * into pay from nl_recovery_payables q where q.company_id=p_company and q.employee_ref=a->>'employee_ref' and q.salary_month=pay_month for update;
   if not found or pay.checked_at<now()-interval '5 minutes' or pay.policy_updated_at is distinct from settings_updated then raise exception 'Refresh employee eligibility and salary payable before saving.'; end if;
   if not pay.eligible then raise exception 'Selected employee does not meet the active-period rules in Master.'; end if;
   if (policy->>'salary_cap_enabled')::boolean then
    if pay.payable is null then raise exception 'Previous-month salary payable is unavailable. Complete payroll or payout mapping first.'; end if;
    reserved:=0;
    if (policy->>'reserve_other_recoveries')::boolean then
     -- Other plans reserve what they take in one month: their instalment, or their whole share.
     select coalesce(sum(coalesce((x->>'monthly_amount')::numeric,(x->>'amount')::numeric)),0) into reserved from nl_loss_recoveries r cross join jsonb_array_elements(r.allocations)x
     where r.company_id=p_company and not r.is_deleted and not(r.month=p_month and r.case_key=p_case)
     and x->>'ref'=a->>'employee_ref' and x->>'salary_month'=pay.salary_month;
    end if;
    cap:=greatest(0,round(pay.payable*(case when v_override then 100 else (policy->>'salary_cap_percent')::numeric end)/100,2)-reserved);
    if round(monthly::numeric/100,2)>cap then
     raise exception 'The monthly recovery of ₹% for % is more than the % salary limit of ₹%. Spread it over more instalments%.',
      round(monthly::numeric/100,2),person->>'employee_code',case when v_override then 'take-home' else (policy->>'salary_cap_percent')||'%' end,cap,
      case when v_override then '' else ', or record a cap override' end;
    end if;
   end if;
   if pay.gross is not null and round(monthly::numeric/100,2)>pay.gross then raise exception 'The monthly recovery for % is more than their gross pay of ₹%.',person->>'employee_code',pay.gross; end if;
   person:=person||jsonb_build_object('salary_month',pay.salary_month,'salary_payable',pay.payable,'salary_gross',pay.gross,'salary_source',pay.source);
   total:=total+amt;i:=i+1;
   person:=person||jsonb_build_object('amount',round(amt::numeric/100,2),'monthly_amount',round(monthly::numeric/100,2));
   if v_mode='installments' then person:=person||jsonb_build_object('installments',schedule); end if;
   people:=people||jsonb_build_array(person);
  end loop;
  if total<>expected then raise exception 'Allocate the full loss value. Partial recovery is not allowed, including next-month exceptions.'; end if;
 else
  if jsonb_array_length(p_allocations)>0 or p_mode<>'none' then raise exception 'This outcome does not allocate employee recovery.'; end if;
 end if;
 -- Same people, amounts, timing and schedule as the live plan: a remark or evidence edit keeps its assignment date and salary month.
 same_plan:=coalesce(old.version is not null and not old.is_deleted and old.deduction_timing=o.deduction_timing
  and old.recovery_mode=v_mode and old.installment_basis is not distinct from v_basis and old.installment_value is not distinct from v_value
  and (select coalesce(jsonb_agg(jsonb_build_array(x->>'ref',(x->>'amount')::numeric) order by x->>'ref'),'[]') from jsonb_array_elements(old.allocations) x)
   =(select coalesce(jsonb_agg(jsonb_build_array(x->>'ref',(x->>'amount')::numeric) order by x->>'ref'),'[]') from jsonb_array_elements(people) x),false);
 -- A line a reviewed payroll or a published payout already deducted cannot be moved, resized, rescheduled or removed.
 if not same_plan and old.version is not null and not old.is_deleted then
  for locked in select * from nl_recovery_locked_lines(p_company,p_month,p_case) l loop
   if not exists(select 1 from jsonb_array_elements(people) x join jsonb_array_elements(old.allocations) y on y->>'ref'=x->>'ref'
     where x->>'ref'=locked.employee_ref and (x->>'amount')::numeric=(y->>'amount')::numeric)
     or old.deduction_timing<>o.deduction_timing
     or old.recovery_mode<>v_mode or old.installment_basis is distinct from v_basis or old.installment_value is distinct from v_value then
    raise exception 'This recovery was already deducted in % payroll for %. Keep that person, amount and schedule, or settle the difference in payroll.',
     to_char(to_date(locked.applied_in,'YYYY-MM'),'FMMonth YYYY'),
     coalesce((select y->>'employee_code' from jsonb_array_elements(old.allocations) y where y->>'ref'=locked.employee_ref),locked.employee_ref);
   end if;
  end loop;
 end if;
 if o.deduction_timing<>'none' then
  assigned:=case when same_plan then coalesce(old.assigned_at,old.updated_at) else now() end;
  deduction:=case when same_plan and old.deduction_month is not null then old.deduction_month
   else nl_recovery_deduction_month(c.report,c.month,assigned,c.final_seen_at,o.deduction_timing,coalesce((policy->>'payroll_cutoff_day')::int,7)) end;
 end if;
 insert into nl_loss_recoveries(company_id,month,case_key,outcome_code,outcome_label,split_mode,allocations,remarks,source_amount,source_status,version,updated_by,updated_by_name,deduction_timing,deduction_month,recovery_details,assigned_at,recovery_mode,installment_basis,installment_value,cap_override,cap_override_reason)
 values(p_company,p_month,p_case,o.code,o.label,p_mode,people,trim(p_remarks),c.amount,c.source_status,p_version+1,p_actor,p_name,o.deduction_timing,deduction,p_details,assigned,v_mode,v_basis,v_value,v_override,v_override_reason)
 on conflict(company_id,month,case_key) do update set outcome_code=excluded.outcome_code,outcome_label=excluded.outcome_label,split_mode=excluded.split_mode,
 allocations=excluded.allocations,remarks=excluded.remarks,source_amount=excluded.source_amount,source_status=excluded.source_status,
 recovery_details=excluded.recovery_details,deduction_timing=excluded.deduction_timing,deduction_month=excluded.deduction_month,assigned_at=excluded.assigned_at,
 recovery_mode=excluded.recovery_mode,installment_basis=excluded.installment_basis,installment_value=excluded.installment_value,
 cap_override=excluded.cap_override,cap_override_reason=excluded.cap_override_reason,
 is_deleted=false,version=excluded.version,updated_by=excluded.updated_by,updated_by_name=excluded.updated_by_name,updated_at=now() returning * into saved;
 insert into nl_loss_recovery_events(company_id,month,case_key,before_value,after_value,actor_id,actor_name)
 values(p_company,p_month,p_case,case when old.version is null then null else to_jsonb(old) end,to_jsonb(saved),p_actor,p_name);
 if exists(select 1 from jsonb_array_elements(coalesce(old.allocations,'[]')||saved.allocations) x where x->>'ref' like 'workforce:%') then
  perform nl_recovery_bump_payout_months(p_company,array[old.deduction_month,saved.deduction_month]);
 end if;
 return to_jsonb(saved);
end $$;

revoke all on function public.nl_recovery_alloc_keys(text,text,jsonb),public.nl_recovery_person_exit(uuid,text),public.nl_loss_recovery_due(uuid,text,text,uuid),
 public.nl_recovery_locked_lines(uuid,text,text),public.nl_recovery_ledger(uuid,text,text),public.waive_nl_recovery_balance(uuid,text,text,text,text,uuid,text),
 public.save_nl_recovery(uuid,text,text,int,text,text,jsonb,text,uuid,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.nl_recovery_alloc_keys(text,text,jsonb),public.nl_recovery_person_exit(uuid,text),public.nl_loss_recovery_due(uuid,text,text,uuid),
 public.nl_recovery_locked_lines(uuid,text,text),public.nl_recovery_ledger(uuid,text,text),public.waive_nl_recovery_balance(uuid,text,text,text,text,uuid,text),
 public.save_nl_recovery(uuid,text,text,int,text,text,jsonb,text,uuid,text,jsonb,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
