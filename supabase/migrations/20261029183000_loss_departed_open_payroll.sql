begin;
alter table public.nl_recovery_payables add column if not exists bank_paid numeric;
-- Server-only payroll windows. A former worker's unpaid month remains selectable
-- until that payroll closes. Issued bank files are never rewritten by recovery.
create or replace function public.loss_recovery_payroll_windows(p_company uuid,p_refs text[] default null)
returns table(employee_ref text,salary_month text,payroll_open boolean,payable numeric,paid numeric,processing boolean)
language sql stable security invoker set search_path=public as $$
 with people as (
  select distinct on (p.worker_type,p.worker_id,r.period_start)
   p.worker_type||':'||p.worker_id ref,to_char(r.period_start,'YYYY-MM') m,
   r.status in ('draft','calculated') opened,
   greatest(0,coalesce(p.adjusted_net_pay,p.net_pay,0)
     -case when h.in_net then 0 else h.held end + h.loss) net,
   b.paid,b.processing
  from hr_payroll_run_people p join hr_payroll_runs r on r.id=p.run_id and r.company_id=p.company_id
  cross join lateral (select coalesce(sum(i.amount) filter(where i.code='SALARY_HOLD'),0) held,
   coalesce(bool_or(i.code='SALARY_HOLD' and i.item_type='deduction' and i.amount>0),false) in_net,
   coalesce(sum(i.amount) filter(where i.code='OPS_LOSS_RECOVERY'),0) loss
   from hr_payroll_run_items i where i.company_id=p.company_id and i.run_person_id=p.id) h
  cross join lateral (select coalesce(sum(b.amount) filter(where b.status='paid'),0) paid,
   coalesce(bool_or(b.status in ('issued','processing')),false) processing
   from hr_payroll_bank_lines b where b.company_id=p.company_id and b.run_id=p.run_id and b.worker_id=p.worker_id) b
  where p.company_id=p_company and p.worker_type in ('employee','contractor')
   and (p_refs is null or p.worker_type||':'||p.worker_id=any(p_refs))
   and r.period_start=date_trunc('month',r.period_start)::date
   and r.period_end=(r.period_start+interval '1 month -1 day')::date
   and r.period_start<=(now() at time zone 'Asia/Kolkata')::date
  order by p.worker_type,p.worker_id,r.period_start,r.updated_at desc,r.id desc
 ), publications as (
  select distinct on(w.workforce_id,w.station_id,w.period_start,w.period_end) w.*
  from workforce_payout_publications w where w.company_id=p_company
   and (p_refs is null or 'workforce:'||w.workforce_id=any(p_refs))
   and w.period_start=date_trunc('month',w.period_start)::date
   and w.period_end=(w.period_start+interval '1 month -1 day')::date
  order by w.workforce_id,w.station_id,w.period_start,w.period_end,w.revision desc
 ), workforce_months as (
  select workforce_id,period_start,sum(coalesce((snapshot->'item'->>'net_amount')::numeric,0)) net
  from publications group by workforce_id,period_start
  union all
  -- Unpublished live worksheets: recent departed profiles must still be findable.
  select w.id,m::date,null::numeric
  from workforce w cross join generate_series(date_trunc('month',now() at time zone 'Asia/Kolkata')-interval '1 month',date_trunc('month',now() at time zone 'Asia/Kolkata'),interval '1 month') m where w.company_id=p_company and w.deleted_at is null
   and (p_refs is null or 'workforce:'||w.id=any(p_refs))
   and (w.last_working_date is null or w.last_working_date>=m::date)
   and (w.date_of_join is null or w.date_of_join<(m+interval '1 month')::date)
 ), wf as (
  select workforce_id,period_start,max(net) net from workforce_months group by workforce_id,period_start
 )
 select ref,m,opened and not processing,greatest(0,net-paid),paid,processing from people
 union all
 select 'workforce:'||w.workforce_id,to_char(w.period_start,'YYYY-MM'),
  not b.processing and not exists(select 1 from workforce_payroll_runs r where r.company_id=p_company
   and lower(r.status) in ('approved','paid','closed','locked')
   and daterange(r.period_start,r.period_end,'[]') && daterange(w.period_start::date,(w.period_start+interval '1 month -1 day')::date,'[]')),
  case when w.net is not null then greatest(0,w.net-b.paid) end,b.paid,b.processing
 from wf w cross join lateral (select coalesce(sum(b.instruction_amount) filter(where b.status='paid'),0) paid,
  coalesce(bool_or(b.status='processing'),false) processing from workforce_payout_payment_items b
  where b.company_id=p_company and b.workforce_id=w.workforce_id and b.period_start=w.period_start
   and b.period_end=(w.period_start+interval '1 month -1 day')::date) b;
$$;

-- Preserve the active hierarchy, then add former People using their postings in
-- the unpaid payroll period (not a different station they moved through years ago).
do $$ declare d text; begin
 if to_regprocedure('public.loss_recovery_people_active_station(uuid,uuid)') is null then
  d:=pg_get_functiondef('public.loss_recovery_people_station(uuid,uuid)'::regprocedure);
  execute replace(d,'FUNCTION public.loss_recovery_people_station(', 'FUNCTION public.loss_recovery_people_active_station(');
 end if;
end $$;
create or replace function public.loss_recovery_people_station(p_company uuid,p_station uuid)
returns table(ref text,employee_code text,full_name text,designation text,is_active boolean)
language sql stable security invoker set search_path=public as $$
 with windows as (select * from loss_recovery_payroll_windows(p_company) where payroll_open and payable>0),
 former as (
  select distinct on(w.employee_ref) w.employee_ref ref,g.worker_code employee_code,
   p.display_name full_name,coalesce(d.name,a.position_title,'People') designation,false is_active
  from windows w join hr_engagements g on g.company_id=p_company
   and w.employee_ref=case when g.employee_id is not null then 'employee:'||g.employee_id else 'contractor:'||g.contractor_id end
  join hr_people p on p.company_id=p_company and p.id=g.person_id
  join hr_work_assignments a on a.company_id=p_company and a.engagement_id=g.id
  left join designations d on d.company_id=p_company and d.id=a.designation_id
  where (g.status<>'active' or p.status<>'active' or g.end_date<(now() at time zone 'Asia/Kolkata')::date)
   and a.effective_from<(to_date(w.salary_month,'YYYY-MM')+interval '1 month')::date
   and (a.effective_to is null or a.effective_to>=to_date(w.salary_month,'YYYY-MM'))
   and (a.location_id=p_station or exists(select 1 from station_responsibility_assignments s
     where s.company_id=p_company and s.station_id=p_station and s.assignment_id=a.id
      and s.effective_from<(to_date(w.salary_month,'YYYY-MM')+interval '1 month')::date
      and (s.effective_to is null or s.effective_to>=to_date(w.salary_month,'YYYY-MM'))))
   and not exists(select 1 from nl_loss_sources s where s.company_id=p_company
     and s.recovery_policy->'directory_excluded_designations' ? upper(coalesce(d.code,'')))
   and (exists(select 1 from employees e where e.company_id=p_company and e.id=g.employee_id and e.deleted_at is null)
     or exists(select 1 from contractors e where e.company_id=p_company and e.id=g.contractor_id and e.deleted_at is null))
  order by w.employee_ref,w.salary_month desc,a.is_primary desc,a.effective_from desc
 ), candidates as (
  select * from loss_recovery_people_active_station(p_company,p_station)
  union all select * from former
 ) select distinct on(c.ref) c.* from candidates c where nullif(trim(c.employee_code),'') is not null
 order by c.ref,c.is_active desc;
$$;

-- Current balance check used by the writer, separate from picker presentation.
create or replace function public.loss_recovery_open_payroll(p_company uuid,p_ref text,p_month text)
returns boolean language sql stable security invoker set search_path=public as $$
 select exists(select 1 from loss_recovery_payroll_windows(p_company,array[p_ref]) w
  where w.salary_month=p_month and w.payroll_open and (w.payable>0 or w.payable is null));
$$;

do $$ declare f record; d text; patched boolean:=false; begin
 for f in select oid from pg_proc where pronamespace='public'::regnamespace and proname='save_nl_recovery' loop
 d:=pg_get_functiondef(f.oid);
 if position('-- Unpaid open payroll' in d)>0 then patched:=true; continue; end if;
 if position('-- People pay checked in payroll' in d)=0 then continue; end if;
 d:=replace(d,'-- Explicit payroll month',E'-- Unpaid open payroll: protect bank instructions and run closure during validation.\n  lock table hr_payroll_runs,hr_payroll_bank_lines,workforce_payroll_runs,workforce_payout_payment_items in share mode;\n  -- Explicit payroll month');
 d:=replace(d,'and not exists(select 1 from nl_loss_recoveries r where r.company_id=p_company and r.month=p_month and r.case_key=p_case and not r.is_deleted and r.deduction_month=pay_month) then',
  'and not exists(select 1 from nl_loss_recoveries r where r.company_id=p_company and r.month=p_month and r.case_key=p_case and not r.is_deleted and r.deduction_month=pay_month) and not (jsonb_array_length(p_allocations)>0 and not exists(select 1 from jsonb_array_elements(p_allocations) entry where not loss_recovery_open_payroll(p_company,entry->>''employee_ref'',pay_month))) then');
 d:=replace(d,'and not exists(select 1 from nl_loss_sources where company_id=p_company and include_inactive_people) then',
  'and not exists(select 1 from nl_loss_sources where company_id=p_company and include_inactive_people) and not loss_recovery_open_payroll(p_company,a->>''employee_ref'',pay_month) then');
 -- An earlier open month is not a next-month exception; it still requires independent approval.
 d:=replace(d,'and not nl_loss_exception_allowed(p_company,p_month,p_case,''next_month'',deduction) then',
  'and not nl_loss_exception_allowed(p_company,p_month,p_case,''next_month'',deduction) and not (deduction < nl_recovery_deduction_month(c.report,c.month,now(),c.final_seen_at,''current_month'',coalesce((policy->>''payroll_cutoff_day'')::int,5)) and not exists(select 1 from jsonb_array_elements(p_allocations) entry where not loss_recovery_open_payroll(p_company,entry->>''employee_ref'',deduction))) then');
 -- Former People and backdated allocations must have real available pay, like Workforce.
 d:=replace(d,'if a->>''employee_ref'' like ''workforce:%'' then -- People pay checked in payroll',
  'if a->>''employee_ref'' like ''workforce:%'' or not coalesce((person->>''is_active'')::boolean,false) or pay_month<nl_recovery_deduction_month(c.report,c.month,now(),c.final_seen_at,''current_month'',coalesce((policy->>''payroll_cutoff_day'')::int,5)) then -- People pay checked in payroll');
 d:=replace(d,'if not pay.eligible then', $p$
      if not coalesce((person->>'is_active')::boolean,false) or pay_month<nl_recovery_deduction_month(c.report,c.month,now(),c.final_seen_at,'current_month',coalesce((policy->>'payroll_cutoff_day')::int,5)) then
       if not loss_recovery_open_payroll(p_company,a->>'employee_ref',pay_month) then raise exception 'This unpaid payroll is closed or has a bank file in progress. Select another open month.'; end if;
       if v_mode<>'full' then raise exception 'Use a full debit against this unpaid payroll. Do not schedule future earnings for a departed person.'; end if;
       -- Recheck People balance under the payroll/bank locks; cached Workforce amounts
       -- were freshly calculated by the server and are checked again for bank movement.
       if a->>'employee_ref' not like 'workforce:%' then
        select least(pay.payable,w.payable) into pay.payable from loss_recovery_payroll_windows(p_company,array[a->>'employee_ref']) w where w.salary_month=pay_month;
       end if;
      end if;
      if a->>'employee_ref' like 'workforce:%' and pay.bank_paid is not null and exists(select 1 from loss_recovery_payroll_windows(p_company,array[a->>'employee_ref']) w where w.salary_month=pay_month and (w.paid<>pay.bank_paid or not w.payroll_open)) then raise exception 'Payment changed. Refresh the available recovery amount.'; end if;
      if not pay.eligible then$p$);
 d:=replace(d,'''salary_month'',pay.salary_month,''salary_payable''', '''unpaid_open_payroll'',pay_month<nl_recovery_deduction_month(c.report,c.month,now(),c.final_seen_at,''current_month'',coalesce((policy->>''payroll_cutoff_day'')::int,5)),''salary_month'',pay.salary_month,''salary_payable''');
 d:=replace(d,'if round(monthly::numeric/100,2)>cap then', $p$if round(monthly::numeric/100,2)>cap and (not coalesce((person->>'is_active')::boolean,false) or pay_month<nl_recovery_deduction_month(c.report,c.month,now(),c.final_seen_at,'current_month',coalesce((policy->>'payroll_cutoff_day')::int,5))) then
          raise exception '%: maximum available recovery is ₹% in %. Reduce this share or select another open month.',person->>'employee_code',cap,pay_month;
        end if;
        if round(monthly::numeric/100,2)>cap then$p$);
 if position('-- Unpaid open payroll' in d)=0 or position('''unpaid_open_payroll''' in d)=0 then raise exception 'Open-payroll writer patch failed'; end if;
 execute d; patched:=true;
 end loop;
 if not patched then raise exception 'Expected recovery writer missing'; end if;
 -- Explicit audited assignments may use an older open payroll without enabling
 -- historical plans globally. Canonical keys / approval / source checks stay intact.
 for f in select oid from pg_proc where pronamespace='public'::regnamespace and proname='nl_loss_recovery_due' loop
 d:=pg_get_functiondef(f.oid);
 if position('-- Explicit unpaid month' in d)>0 then continue; end if;
 d:=replace(d,'where p_salary_month>=policy.start_month', $p$where (p_salary_month>=policy.start_month or (coalesce((x->>'unpaid_open_payroll')::boolean,false) and p_salary_month>=r.deduction_month)) -- Explicit unpaid month$p$);
 d:=replace(d,'and greatest(r.deduction_month,policy.start_month)<=p_salary_month','and (greatest(r.deduction_month,policy.start_month)<=p_salary_month or (coalesce((x->>''unpaid_open_payroll'')::boolean,false) and r.deduction_month<=p_salary_month))');
 execute d;
 end loop;
end $$;
revoke all on function public.loss_recovery_payroll_windows(uuid,text[]),public.loss_recovery_open_payroll(uuid,text,text),public.loss_recovery_people_active_station(uuid,uuid) from public,anon,authenticated;
grant execute on function public.loss_recovery_payroll_windows(uuid,text[]),public.loss_recovery_open_payroll(uuid,text,text),public.loss_recovery_people_active_station(uuid,uuid) to service_role;
notify pgrst,'reload schema';
commit;
