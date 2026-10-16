begin;
-- Team Ops → Losses recovery plans become real salary deductions.
-- People employees are deducted in HRMS payroll; Workforce members in the monthly Workforce payout.
--
-- SLP Initial is a report only: employees are assigned (and charged) once a case is in SLP Final.
--
-- Salary month. A plan is settled on the later of the day it was assigned and, for SLP, the day the
-- case first appeared in an SLP Final file (plans saved on Initial before this release wait for Final). Settled before the payroll cutoff day (default the 7th) →
-- the previous month's salary, which is still being processed; otherwise that month's salary.
-- An NL loss of month M is final only after Amazon's decision (~4th of M+2), so it is never deducted
-- before the M+1 salary. "Deduct next month" adds one month.
--
-- Exactly once. A plan line is identified by month|case|employee. It is due in its salary month or any
-- later one until a payroll carries it: an HRMS run item, or a published Workforce payout line, with
-- that key. A missed month carries forward; a deducted line never repeats.

alter table public.nl_loss_month_cases add column if not exists final_seen_at timestamptz;
alter table public.nl_loss_recoveries add column if not exists assigned_at timestamptz;

-- SLP: when the settled (Final) amount first became known.
update public.nl_loss_month_cases c set final_seen_at=coalesce((select r.started_at from public.loss_report_runs r where r.id=c.source_run_id),c.source_updated_at)
 where c.report='slp' and c.final_seen_at is null and coalesce((c.details->>'in_final')::boolean,false);

create or replace function public.nl_case_final_seen() returns trigger language plpgsql security invoker set search_path=public as $$
begin
 if new.report='slp' and new.final_seen_at is null and coalesce((new.details->>'in_final')::boolean,false) then new.final_seen_at:=now(); end if;
 if tg_op='UPDATE' then new.final_seen_at:=coalesce(old.final_seen_at,new.final_seen_at); end if;
 return new;
end $$;
drop trigger if exists nl_case_final_seen on public.nl_loss_month_cases;
create trigger nl_case_final_seen before insert or update on public.nl_loss_month_cases for each row execute function public.nl_case_final_seen();

-- The plan line key payroll carries, so a line is never deducted twice.
create or replace function public.nl_recovery_key(p_month text,p_case text,p_ref text) returns text language sql immutable set search_path=public as $$
 select p_month||'|'||p_case||'|'||p_ref
$$;

create or replace function public.nl_recovery_deduction_month(p_report text,p_case_month text,p_assigned_at timestamptz,p_final_seen_at timestamptz,p_timing text,p_cutoff_day int default 7)
returns text language plpgsql stable set search_path=public as $$
declare settled date; m date;
begin
 if p_timing is null or p_timing='none' or p_assigned_at is null then return null; end if;
 settled:=(greatest(p_assigned_at,coalesce(p_final_seen_at,p_assigned_at)) at time zone 'Asia/Kolkata')::date;
 m:=date_trunc('month',settled)::date;
 if extract(day from settled)<greatest(1,least(coalesce(p_cutoff_day,7),28)) then m:=(m-interval '1 month')::date; end if;
 if p_report='nl' and p_case_month ~ '^\d{4}-(0[1-9]|1[0-2])$' then m:=greatest(m,(to_date(p_case_month,'YYYY-MM')+interval '1 month')::date); end if;
 if p_timing='next_month' then m:=(m+interval '1 month')::date; end if;
 return to_char(m,'YYYY-MM');
end $$;

-- First month payroll carries Ops loss recoveries. Earlier payroll months are already paid and never reopened.
update public.nl_loss_sources set recovery_policy=recovery_policy||'{"payroll_cutoff_day":7,"payroll_start_month":"2026-10"}'::jsonb
 where not (recovery_policy ? 'payroll_start_month');

-- Existing plans: assigned when their current allocation was first saved (after any later change to it).
update public.nl_loss_recoveries r set assigned_at=coalesce((
  select min(e.created_at) from public.nl_loss_recovery_events e
  where e.company_id=r.company_id and e.month=r.month and e.case_key=r.case_key
   and e.after_value->'allocations'=r.allocations and not coalesce((e.after_value->>'is_deleted')::boolean,false)
   and e.created_at>coalesce((select max(x.created_at) from public.nl_loss_recovery_events x
    where x.company_id=r.company_id and x.month=r.month and x.case_key=r.case_key
     and (x.after_value->'allocations' is distinct from r.allocations or coalesce((x.after_value->>'is_deleted')::boolean,false))),'-infinity')),r.updated_at)
 where r.assigned_at is null and jsonb_array_length(r.allocations)>0;
update public.nl_loss_recoveries r set deduction_month=public.nl_recovery_deduction_month(c.report,c.month,r.assigned_at,c.final_seen_at,r.deduction_timing,coalesce((s.recovery_policy->>'payroll_cutoff_day')::int,7))
 from public.nl_loss_month_cases c, public.nl_loss_sources s
 where c.company_id=r.company_id and c.month=r.month and c.case_key=r.case_key and s.company_id=r.company_id
  and r.deduction_timing<>'none' and r.assigned_at is not null;

-- The salary month (YYYY-MM) of another payroll that already carries a plan line, or null.
-- HRMS: a run item of any run except the one being calculated (p_finalized_only: reviewed or later).
-- Workforce: the latest publication of any other period for that member. Looks only at that one person.
create or replace function public.nl_recovery_line_applied(p_company uuid,p_key text,p_exclude_run uuid default null,p_exclude_period_start date default null,p_finalized_only boolean default false)
returns text language sql stable security invoker set search_path=public as $$
 select case split_part(split_part(p_key,'|',3),':',1)
  when 'employee' then (
   select to_char(r.period_start,'YYYY-MM')
   from hr_payroll_run_items i join hr_payroll_run_people p on p.company_id=i.company_id and p.id=i.run_person_id
   join hr_payroll_runs r on r.company_id=p.company_id and r.id=p.run_id
   where i.company_id=p_company and i.code='OPS_LOSS_RECOVERY' and i.metadata->>'recovery_key'=p_key
    and r.id is distinct from p_exclude_run and (not p_finalized_only or r.status not in ('draft','calculated'))
   order by r.period_start limit 1)
  when 'workforce' then (
   select to_char(x.period_start,'YYYY-MM')
   from (select distinct on (w.station_id,w.period_start,w.period_end) w.period_start,w.snapshot
     from workforce_payout_publications w
     where w.company_id=p_company and w.workforce_id=split_part(split_part(p_key,'|',3),':',2)::uuid and w.period_start is not null
     order by w.station_id,w.period_start,w.period_end,w.revision desc) x
   where x.period_start is distinct from p_exclude_period_start
    and coalesce(x.snapshot->'worksheet'->'deduction_breakdown','[]') @> jsonb_build_array(jsonb_build_object('recoveryKey',p_key))
   order by x.period_start limit 1)
 end
$$;

-- Plan lines due in a salary month and not yet carried by another payroll.
create or replace function public.nl_loss_recovery_due(p_company uuid,p_salary_month text,p_target text,p_run_id uuid default null)
returns table(recovery_key text,month text,case_key text,report text,employee_ref text,worker_id uuid,employee_code text,full_name text,amount numeric,deduction_month text,label text)
language sql stable security invoker set search_path=public as $$
 with policy as (select coalesce(s.recovery_policy->>'payroll_start_month','2026-10') start_month from nl_loss_sources s where s.company_id=p_company limit 1),
 lines as (
  select nl_recovery_key(r.month,r.case_key,x->>'ref') recovery_key, r.month, r.case_key, c.report, x->>'ref' employee_ref,
   split_part(x->>'ref',':',2)::uuid worker_id, x->>'employee_code' employee_code, x->>'full_name' full_name, round((x->>'amount')::numeric,2) amount, r.deduction_month,
   upper(c.report)||' loss · '||to_char(to_date(r.month,'YYYY-MM'),'Mon YYYY')||' · '||regexp_replace(r.case_key,'^slp:','') label
  from nl_loss_recoveries r
  join nl_loss_month_cases c on c.company_id=r.company_id and c.month=r.month and c.case_key=r.case_key
  cross join jsonb_array_elements(r.allocations) x
  cross join policy
  where p_salary_month ~ '^\d{4}-(0[1-9]|1[0-2])$' and p_salary_month>=policy.start_month
   and r.company_id=p_company and not r.is_deleted and r.deduction_timing<>'none' and r.deduction_month is not null
   and greatest(r.deduction_month,policy.start_month)<=p_salary_month
   and split_part(x->>'ref',':',1)=case p_target when 'hrms' then 'employee' when 'workforce' then 'workforce' end
   and coalesce((x->>'amount')::numeric,0)>0
   -- Only a plan for the source's current, still-recoverable amount. A changed case waits for review in Losses.
   and c.source_present and round(c.amount,2)=round(r.source_amount,2)
   and nl_case_recoverable(p_company,c.report,c.source_status)
   and (c.report<>'slp' or c.final_seen_at is not null))
 select l.* from lines l
 where nl_recovery_line_applied(p_company,l.recovery_key,p_run_id,case when p_target='workforce' then to_date(p_salary_month,'YYYY-MM') end) is null
 order by l.deduction_month,l.month,l.case_key,l.employee_ref
$$;

-- Lines of a plan a reviewed/approved HRMS run or a published payout carries; these can no longer change.
create or replace function public.nl_recovery_locked_lines(p_company uuid,p_month text,p_case text)
returns table(employee_ref text,applied_in text) language sql stable security invoker set search_path=public as $$
 select x.ref, x.applied_in from (
  select a->>'ref' ref, nl_recovery_line_applied(p_company,nl_recovery_key(p_month,p_case,a->>'ref'),null,null,true) applied_in
  from nl_loss_recoveries r cross join jsonb_array_elements(r.allocations) a
  where r.company_id=p_company and r.month=p_month and r.case_key=p_case) x
 where x.applied_in is not null
$$;


-- Workforce worksheets read these plans; bump every month a plan line can land in (its month, last month and this month).
create or replace function public.nl_recovery_bump_payout_months(p_company uuid,p_months text[]) returns void language plpgsql security definer set search_path='' as $$
declare m date; now_month date:=date_trunc('month',now() at time zone 'Asia/Kolkata')::date;
begin
 for m in select distinct x from unnest(array_cat(
   array(select to_date(v,'YYYY-MM') from unnest(coalesce(p_months,'{}')) v where v ~ '^\d{4}-(0[1-9]|1[0-2])$'),
   array[now_month,(now_month-interval '1 month')::date])) x
 loop
  perform public.workforce_bump_payout_period_dependency_revision(p_company,m);
 end loop;
end $$;

-- A source change (amount, status, Final arrival) can make a Workforce plan due or not due.
create or replace function public.nl_case_bump_payout_months() returns trigger language plpgsql security definer set search_path='' as $$
declare r record;
begin
 for r in
  select n.company_id, array_agg(distinct x.deduction_month) months
  from new_cases n join old_cases o on o.company_id=n.company_id and o.month=n.month and o.case_key=n.case_key
  join public.nl_loss_recoveries x on x.company_id=n.company_id and x.month=n.month and x.case_key=n.case_key and not x.is_deleted
  where (n.amount,n.source_status,n.source_present,n.final_seen_at) is distinct from (o.amount,o.source_status,o.source_present,o.final_seen_at)
   and exists(select 1 from jsonb_array_elements(x.allocations) a where a->>'ref' like 'workforce:%')
  group by n.company_id
 loop
  perform public.nl_recovery_bump_payout_months(r.company_id,r.months);
 end loop;
 return null;
end $$;
drop trigger if exists nl_case_bump_payout_months on public.nl_loss_month_cases;
create trigger nl_case_bump_payout_months after update on public.nl_loss_month_cases referencing old table as old_cases new table as new_cases
 for each statement execute function public.nl_case_bump_payout_months();

-- SLP Final arriving after the plan moves the plan to the salary month of that day.
create or replace function public.nl_case_final_reschedules() returns trigger language plpgsql security invoker set search_path=public as $$
begin
 update nl_loss_recoveries r set deduction_month=nl_recovery_deduction_month(new.report,new.month,r.assigned_at,new.final_seen_at,r.deduction_timing,
   coalesce((select (s.recovery_policy->>'payroll_cutoff_day')::int from nl_loss_sources s where s.company_id=new.company_id limit 1),7))
 where r.company_id=new.company_id and r.month=new.month and r.case_key=new.case_key and r.deduction_timing<>'none' and r.assigned_at is not null;
 return null;
end $$;
drop trigger if exists nl_case_final_reschedules on public.nl_loss_month_cases;
-- No column list: final_seen_at is set by the before trigger, never by the UPDATE itself.
create trigger nl_case_final_reschedules after update on public.nl_loss_month_cases for each row
 when (old.final_seen_at is null and new.final_seen_at is not null) execute function public.nl_case_final_reschedules();



-- Plans record when their allocation was assigned and the salary month it lands in; a deducted line is locked.
create or replace function public.save_nl_recovery(p_company uuid,p_month text,p_case text,p_version int,p_outcome text,p_mode text,p_allocations jsonb,p_remarks text,p_actor uuid,p_name text,p_details jsonb default '{}')
returns jsonb language plpgsql security invoker set search_path=public as $$
declare c nl_loss_month_cases; o nl_recovery_outcomes; old nl_loss_recoveries; saved nl_loss_recoveries; a jsonb; people jsonb:='[]'; person jsonb; station uuid; total bigint:=0; expected bigint; n int; i int:=0; amt bigint; deduction text; policy jsonb; settings_updated timestamptz; pay nl_recovery_payables; pay_month text; reserved numeric; cap numeric; attachment jsonb; assigned timestamptz; same_plan boolean; locked record;
begin
 -- Serialize plans across cases so two submissions cannot consume the same salary capacity.
 perform pg_advisory_xact_lock(hashtextextended('nl-recovery:'||p_company::text,0));
 select recovery_policy,updated_at into policy,settings_updated from nl_loss_sources where company_id=p_company;
 pay_month:=to_char(date_trunc('month',now() at time zone 'Asia/Kolkata')-make_interval(months=>(policy->>'salary_month_offset')::int),'YYYY-MM');
 select * into c from nl_loss_month_cases where company_id=p_company and month=p_month and case_key=p_case for update;
 if not found or not c.source_present or not nl_case_recoverable(p_company,c.report,c.source_status) then raise exception 'This case is no longer recoverable at source. Refresh the list.'; end if;
 select * into o from nl_recovery_outcomes where company_id=p_company and code=p_outcome and is_active;
 if not found then raise exception 'Choose an active outcome from Loss Recovery Master.'; end if;
 if p_remarks is null or length(trim(p_remarks))>2000 or (o.remarks_required and length(trim(p_remarks))<5) then raise exception 'Add a clear recovery remark (5–2,000 characters).'; end if;
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
   select * into pay from nl_recovery_payables q where q.company_id=p_company and q.employee_ref=a->>'employee_ref' and q.salary_month=pay_month for update;
   if not found or pay.checked_at<now()-interval '5 minutes' or pay.policy_updated_at is distinct from settings_updated then raise exception 'Refresh employee eligibility and salary payable before saving.'; end if;
   if not pay.eligible then raise exception 'Selected employee does not meet the active-period rules in Master.'; end if;
   if (policy->>'salary_cap_enabled')::boolean then
    if pay.payable is null then raise exception 'Previous-month salary payable is unavailable. Complete payroll or payout mapping first.'; end if;
    reserved:=0;
    if (policy->>'reserve_other_recoveries')::boolean then
     select coalesce(sum((x->>'amount')::numeric),0) into reserved from nl_loss_recoveries r cross join jsonb_array_elements(r.allocations)x
     where r.company_id=p_company and not r.is_deleted and not(r.month=p_month and r.case_key=p_case)
     and x->>'ref'=a->>'employee_ref' and x->>'salary_month'=pay.salary_month;
    end if;
    cap:=greatest(0,round(pay.payable*(policy->>'salary_cap_percent')::numeric/100,2)-reserved);
    if amt::numeric/100>cap then raise exception 'Recovery exceeds available previous-month salary payable for employee %. Maximum remaining: %.',person->>'employee_code',cap; end if;
   end if;
   person:=person||jsonb_build_object('salary_month',pay.salary_month,'salary_payable',pay.payable,'salary_source',pay.source);
   if amt<=0 then raise exception 'Every selected employee must have a positive amount.'; end if;
   total:=total+amt;i:=i+1;
   people:=people||jsonb_build_array(person||jsonb_build_object('amount',amt::numeric/100));
  end loop;
  if total<>expected then raise exception 'Allocate the full loss value. Partial recovery is not allowed, including next-month exceptions.'; end if;
 else
  if jsonb_array_length(p_allocations)>0 or p_mode<>'none' then raise exception 'This outcome does not allocate employee recovery.'; end if;
 end if;
 -- Same people, amounts and timing as the live plan: a remark or evidence edit keeps its assignment date and salary month.
 same_plan:=coalesce(old.version is not null and not old.is_deleted and old.deduction_timing=o.deduction_timing
  and (select coalesce(jsonb_agg(jsonb_build_array(x->>'ref',(x->>'amount')::numeric) order by x->>'ref'),'[]') from jsonb_array_elements(old.allocations) x)
   =(select coalesce(jsonb_agg(jsonb_build_array(x->>'ref',(x->>'amount')::numeric) order by x->>'ref'),'[]') from jsonb_array_elements(people) x),false);
 -- A line a reviewed payroll or a published payout already deducted cannot be moved, resized or removed.
 if not same_plan and old.version is not null and not old.is_deleted then
  for locked in select * from nl_recovery_locked_lines(p_company,p_month,p_case) l loop
   if not exists(select 1 from jsonb_array_elements(people) x join jsonb_array_elements(old.allocations) y on y->>'ref'=x->>'ref'
     where x->>'ref'=locked.employee_ref and (x->>'amount')::numeric=(y->>'amount')::numeric) or old.deduction_timing<>o.deduction_timing then
    raise exception 'This recovery was already deducted in % payroll for %. Keep that person and amount, or settle the difference in payroll.',
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
 insert into nl_loss_recoveries(company_id,month,case_key,outcome_code,outcome_label,split_mode,allocations,remarks,source_amount,source_status,version,updated_by,updated_by_name,deduction_timing,deduction_month,recovery_details,assigned_at)
 values(p_company,p_month,p_case,o.code,o.label,p_mode,people,trim(p_remarks),c.amount,c.source_status,p_version+1,p_actor,p_name,o.deduction_timing,deduction,p_details,assigned)
 on conflict(company_id,month,case_key) do update set outcome_code=excluded.outcome_code,outcome_label=excluded.outcome_label,split_mode=excluded.split_mode,
 allocations=excluded.allocations,remarks=excluded.remarks,source_amount=excluded.source_amount,source_status=excluded.source_status,
 recovery_details=excluded.recovery_details,deduction_timing=excluded.deduction_timing,deduction_month=excluded.deduction_month,assigned_at=excluded.assigned_at,
 is_deleted=false,version=excluded.version,updated_by=excluded.updated_by,updated_by_name=excluded.updated_by_name,updated_at=now() returning * into saved;
 insert into nl_loss_recovery_events(company_id,month,case_key,before_value,after_value,actor_id,actor_name)
 values(p_company,p_month,p_case,case when old.version is null then null else to_jsonb(old) end,to_jsonb(saved),p_actor,p_name);
 if exists(select 1 from jsonb_array_elements(coalesce(old.allocations,'[]')||saved.allocations) x where x->>'ref' like 'workforce:%') then
  perform nl_recovery_bump_payout_months(p_company,array[old.deduction_month,saved.deduction_month]);
 end if;
 return to_jsonb(saved);
end $$;

create or replace function public.clear_nl_recovery(p_company uuid,p_month text,p_case text,p_version int,p_actor uuid,p_name text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare old nl_loss_recoveries; saved nl_loss_recoveries; locked record;
begin
 perform pg_advisory_xact_lock(hashtextextended('nl-recovery:'||p_company::text,0));
 perform 1 from nl_loss_month_cases where company_id=p_company and month=p_month and case_key=p_case for update;
 select * into old from nl_loss_recoveries where company_id=p_company and month=p_month and case_key=p_case;
 if not found or old.version<>p_version or old.is_deleted then raise exception 'Recovery changed. Refresh before removing it.'; end if;
 select * into locked from nl_recovery_locked_lines(p_company,p_month,p_case) limit 1;
 if found then raise exception 'This recovery was already deducted in % payroll. It can no longer be removed.',to_char(to_date(locked.applied_in,'YYYY-MM'),'FMMonth YYYY'); end if;
 update nl_loss_recoveries set is_deleted=true,version=version+1,updated_by=p_actor,updated_by_name=p_name,updated_at=now()
 where company_id=p_company and month=p_month and case_key=p_case returning * into saved;
 insert into nl_loss_recovery_events(company_id,month,case_key,before_value,after_value,actor_id,actor_name)
 values(p_company,p_month,p_case,to_jsonb(old),to_jsonb(saved),p_actor,p_name);
 if exists(select 1 from jsonb_array_elements(old.allocations) x where x->>'ref' like 'workforce:%') then
  perform nl_recovery_bump_payout_months(p_company,array[old.deduction_month]);
 end if;
 return to_jsonb(saved);
end $$;

revoke all on function public.nl_case_final_seen(),public.nl_recovery_key(text,text,text),public.nl_recovery_deduction_month(text,text,timestamptz,timestamptz,text,int),
 public.nl_recovery_line_applied(uuid,text,uuid,date,boolean),public.nl_loss_recovery_due(uuid,text,text,uuid),public.nl_recovery_locked_lines(uuid,text,text),
 public.nl_recovery_bump_payout_months(uuid,text[]),public.nl_case_bump_payout_months(),public.nl_case_final_reschedules(),
 public.save_nl_recovery(uuid,text,text,int,text,text,jsonb,text,uuid,text,jsonb),public.clear_nl_recovery(uuid,text,text,int,uuid,text) from public,anon,authenticated;
grant execute on function public.nl_recovery_key(text,text,text),public.nl_recovery_deduction_month(text,text,timestamptz,timestamptz,text,int),
 public.nl_recovery_line_applied(uuid,text,uuid,date,boolean),public.nl_loss_recovery_due(uuid,text,text,uuid),public.nl_recovery_locked_lines(uuid,text,text),public.nl_recovery_bump_payout_months(uuid,text[]),
 public.save_nl_recovery(uuid,text,text,int,text,text,jsonb,text,uuid,text,jsonb),public.clear_nl_recovery(uuid,text,text,int,uuid,text) to service_role;
create index if not exists hr_payroll_run_items_ops_loss_recovery on public.hr_payroll_run_items(company_id,(metadata->>'recovery_key')) where code='OPS_LOSS_RECOVERY';
notify pgrst,'reload schema';
commit;
