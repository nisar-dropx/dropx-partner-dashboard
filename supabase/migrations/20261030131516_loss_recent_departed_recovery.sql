begin;
-- Recorded leavers in the two completed calendar months, independent of pay readiness.
-- Historical assignment / reporting overlaps prevent today's manager from replacing the former owner.
create or replace function public.loss_recovery_recent_leavers(p_company uuid,p_station uuid)
returns table(ref text,employee_code text,full_name text,designation text,is_active boolean,station_codes text[],left_on date)
language sql stable security invoker set search_path=public as $$
 with recursive bounds as (
  select (date_trunc('month',now() at time zone 'Asia/Kolkata')-interval '2 months')::date lo,
   (date_trunc('month',now() at time zone 'Asia/Kolkata')-interval '1 day')::date hi,
   (now() at time zone 'Asia/Kolkata')::date today
 ), scope as (select * from loss_recovery_station_scope(p_company,p_station)),
 assignments as (
  select a.id,a.engagement_id,a.location_id,a.is_primary,g.person_id,g.employee_id,g.contractor_id,
   g.worker_code,p.display_name,g.end_date,coalesce(d.name,a.position_title,'People') designation,
   upper(coalesce(d.code,'')) code,
   greatest(a.effective_from,g.start_date,b.lo) lo,
   least(coalesce(a.effective_to,b.hi),coalesce(g.end_date,b.hi),b.hi) hi
  from hr_work_assignments a join hr_engagements g on g.id=a.engagement_id and g.company_id=p_company
  join hr_people p on p.id=g.person_id and p.company_id=p_company
  left join designations d on d.id=a.designation_id and d.company_id=p_company cross join bounds b
  where a.company_id=p_company
   and not exists(select 1 from nl_loss_sources s where s.company_id=p_company
    and s.recovery_policy->'directory_excluded_designations' ? upper(coalesce(d.code,'')))
 ), roots as (
  select a.id,s.station_code,a.lo,a.hi from assignments a join scope s on s.station_id=a.location_id where a.lo<=a.hi
  union
  select a.id,s.station_code,greatest(a.lo,r.effective_from::date),
   least(a.hi,coalesce(r.effective_to::date,a.hi))
  from assignments a join station_responsibility_assignments r on r.company_id=p_company and r.assignment_id=a.id
  join scope s on s.station_id=r.station_id
  where greatest(a.lo,r.effective_from::date)<=least(a.hi,coalesce(r.effective_to::date,a.hi))
 ), chain as (
  select r.*,array[r.id] path from roots r
  union all
  select m.id,c.station_code,greatest(c.lo,m.lo,r.effective_from),
   least(c.hi,m.hi,coalesce(r.effective_to,c.hi)),c.path||m.id
  from chain c join assignments a on a.id=c.id
  join hr_reporting_relationships r on r.company_id=p_company and r.subject_assignment_id=c.id
   and r.is_primary and r.relationship_type='solid_line'
  join assignments m on m.id=r.manager_assignment_id
  where a.code<>'AOM' and not exists(select 1 from nl_loss_sources s where s.company_id=p_company
   and s.recovery_policy->'directory_ceiling_designations' ? a.code)
   and not m.id=any(c.path) and cardinality(c.path)<16
   and greatest(c.lo,m.lo,r.effective_from)<=least(c.hi,m.hi,coalesce(r.effective_to,c.hi))
 ), former_people as (
  select distinct case when a.employee_id is not null then 'employee:'||a.employee_id else 'contractor:'||a.contractor_id end ref,
   coalesce(nullif(a.worker_code,''),e.employee_code,k.dropx_id) employee_code,
   coalesce(nullif(a.display_name,''),e.full_name,k.full_name) full_name,a.designation,
   c.station_code,a.end_date left_on,a.is_primary,a.id
  from chain c join assignments a on a.id=c.id cross join bounds b
  left join employees e on e.company_id=p_company and e.id=a.employee_id and e.deleted_at is null
  left join contractors k on k.company_id=p_company and k.id=a.contractor_id and k.deleted_at is null
  where a.end_date between b.lo and b.hi and (e.id is not null or k.id is not null)
   and not exists(select 1 from hr_engagements g where g.company_id=p_company and g.person_id=a.person_id
    and g.status='active' and g.start_date<=b.today and (g.end_date is null or g.end_date>=b.today))
 ), canonical as (
  select distinct on(ref) ref,employee_code,full_name,designation,left_on from former_people
  order by ref,left_on desc,is_primary desc,id
 ), candidates as (
  select a.ref,a.employee_code,a.full_name,a.designation,false is_active,
   array(select distinct x.station_code from former_people x where x.ref=a.ref order by x.station_code) station_codes,a.left_on
  from canonical a
  union all
  select 'workforce:'||w.id,w.dropx_id,w.full_name,coalesce(d.name,w.designation,'Associate'),false,array[s.station_code],w.last_working_date
  from workforce w join scope s on s.station_id=w.location_id cross join bounds b
  left join designations d on d.company_id=p_company and d.id=w.designation_id
  where w.company_id=p_company and w.deleted_at is null and not w.is_active
   and w.last_working_date between b.lo and b.hi
   and not (coalesce(w.source_profile_type,'') in ('employee','contractor') and w.source_profile_id is not null)
   and not exists(select 1 from nl_loss_sources x where x.company_id=p_company
    and x.recovery_policy->'directory_excluded_designations' ? upper(coalesce(d.code,'')))
 )
 select * from candidates where nullif(trim(employee_code),'') is not null order by full_name,employee_code;
$$;
revoke all on function public.loss_recovery_recent_leavers(uuid,uuid) from public,anon,authenticated;
grant execute on function public.loss_recovery_recent_leavers(uuid,uuid) to service_role;

-- The assigned loss stays whole. Only the verified funded portion becomes a payroll debit.
-- Existing recovery keys are unchanged, and a remaining exit balance never becomes an automatic future debit.
create or replace function public.nl_recovery_alloc_keys(p_month text,p_case text,p_alloc jsonb)
returns table(recovery_key text,installment_no int,amount numeric)
language sql immutable set search_path=public as $$
 select nl_recovery_key(p_month,p_case,p_alloc->>'ref'),null::int,
  round(coalesce(p_alloc->>'payroll_amount',p_alloc->>'amount')::numeric,2)
 where jsonb_array_length(coalesce(p_alloc->'installments','[]'))=0
 union all
 select nl_recovery_key(p_month,p_case,p_alloc->>'ref')||'|'||(i->>'n'),(i->>'n')::int,round((i->>'amount')::numeric,2)
 from jsonb_array_elements(coalesce(p_alloc->'installments','[]')) i
$$;

do $migration$
declare d text; old_d text;
begin
 select pg_get_functiondef('public.save_nl_recovery(uuid,text,text,integer,text,text,jsonb,text,uuid,text,jsonb,jsonb)'::regprocedure) into d;
 if position('-- Verified recent leaver' in d)=0 then
  old_d:=d;
  d:=replace(d,'locked record;', 'locked record; departed jsonb; funded boolean:=false;');
  d:=replace(d,'-- Explicit payroll month,', $patch$
  -- Verified recent leaver: scope, identity and exit date are server facts, never free text.
  if o.code='responsible_left' then
   select to_jsonb(l) into departed from stations s
    left join cod_station_settings x on x.company_id=p_company and x.location_id=s.id
    cross join lateral loss_recovery_recent_leavers(p_company,s.id) l
    where s.company_id=p_company and upper(coalesce(nullif(x.portal_station_code,''),s.station_code))=upper(c.station_code)
     and l.ref=p_details->>'employee_ref' order by (s.station_code=c.station_code) desc limit 1;
   if departed is null then raise exception 'Select a verified person who left in the previous two months at this station or its linked stations.'; end if;
   if length(trim(coalesce(p_details->>'follow_up','')))<10 or length(trim(coalesce(p_remarks,'')))<5 then
    raise exception 'Record the recovery owner, next step and departure remarks.'; end if;
   p_details:=jsonb_build_object('employee_ref',departed->>'ref','employee_id',departed->>'employee_code',
    'employee_name',departed->>'full_name','left_on',departed->>'left_on',
    'follow_up',p_details->>'follow_up','payroll_amount',p_details->>'payroll_amount');
   funded:=jsonb_array_length(p_allocations)>0;
   if funded then
    if jsonb_array_length(p_allocations)<>1 or p_allocations->0->>'employee_ref'<>departed->>'ref' or v_mode<>'full' then
     raise exception 'Use one full recovery assignment for the selected departed person.'; end if;
    o.allocation_required:=true; o.deduction_timing:='current_month';
   end if;
  end if;
  -- Explicit payroll month,$patch$);
  d:=regexp_replace(d,$patch$select to_jsonb\(d\) into person from loss_recovery_people\(p_company,station\)d\s+where d.ref=a->>'employee_ref';$patch$,$patch$
      if funded then person:=departed; else
       select to_jsonb(d) into person from loss_recovery_people(p_company,station)d where d.ref=a->>'employee_ref';
      end if;$patch$);
  d:=replace(d,'cap:=greatest(0,round(pay.payable,2)-reserved);',$patch$
        cap:=greatest(0,round(pay.payable,2)-reserved);
        if funded then
         monthly:=least(amt,round(cap*100)::bigint);
         if monthly<=0 then raise exception 'No unpaid salary is available. Refresh and save the person-left balance without a payroll adjustment.'; end if;
         if coalesce(p_details->>'payroll_amount','') !~ '^\d+(\.\d{1,2})?$'
          or round((p_details->>'payroll_amount')::numeric*100)<>monthly then
          raise exception 'Available unpaid salary changed. Refresh and review the salary adjustment before saving.'; end if;
        end if;$patch$);
  d:=replace(d,'total:=total+amt; i:=i+1;',$patch$
      if funded then person:=person||jsonb_build_object('payroll_amount',round(monthly::numeric/100,2)); end if;
      total:=total+amt; i:=i+1;$patch$);
  d:=replace(d,'if (policy->>''reserve_other_recoveries'')::boolean then',
    'if funded or (policy->>''reserve_other_recoveries'')::boolean then');
  -- Funding changes are structural even when the assigned full loss has not changed.
  d:=replace(d,$patch$jsonb_build_array(x->>'ref',(x->>'amount')::numeric)$patch$,
   $patch$jsonb_build_array(x->>'ref',(x->>'amount')::numeric,coalesce(x->>'payroll_amount',x->>'amount')::numeric)$patch$);
  d:=replace(d,$patch$(x->>'amount')::numeric=(y->>'amount')::numeric$patch$,
   $patch$(x->>'amount')::numeric=(y->>'amount')::numeric
        and coalesce(x->>'payroll_amount',x->>'amount')::numeric=coalesce(y->>'payroll_amount',y->>'amount')::numeric$patch$);
  d:=replace(d,'same_plan:=coalesce(',$patch$
  if o.code='responsible_left' then
   if not funded then
    -- A zero-funded line owns the outstanding loss without creating a payroll debit.
    o.deduction_timing:='current_month';
    pay_month:=nl_recovery_deduction_month(c.report,c.month,now(),c.final_seen_at,'current_month',coalesce((policy->>'payroll_cutoff_day')::int,5));
    people:=jsonb_build_array(departed||jsonb_build_object('amount',c.amount,'monthly_amount',0,'payroll_amount',0,'salary_month',pay_month));
   end if;
   p_details:=p_details||jsonb_build_object('payroll_amount',case when funded then round(monthly::numeric/100,2) else 0 end,
    'remaining_amount',c.amount-case when funded then round(monthly::numeric/100,2) else 0 end);
  end if;
  same_plan:=coalesce($patch$);
  if d=old_d or position('if funded then person:=departed;' in d)=0 or position('monthly:=least(amt,' in d)=0 then
   raise exception 'Recent leaver writer patch did not match'; end if;
  execute d;
 end if;
end $migration$;

-- Recorded People exit dates also apply when the legacy profile has not copied the exit date yet.
do $migration$ declare d text; begin
 select pg_get_functiondef('public.nl_recovery_ledger(uuid,text,text)'::regprocedure) into d;
 if position('l.alloc->>''left_on''' in d)=0 then
  d:=replace(d,'nl_recovery_person_exit(p_company,l.ref)',
   'coalesce((l.alloc->>''left_on'')::date,nl_recovery_person_exit(p_company,l.ref))');
  execute d;
 end if;
end $migration$;

-- Write-off remains disabled until an authorised user enables this shipment in Exceptions.
alter table public.nl_loss_exception_options drop constraint if exists nl_loss_exception_options_kind_check;
alter table public.nl_loss_exception_options add constraint nl_loss_exception_options_kind_check check(kind in ('next_month','installments','write_off'));
do $migration$ declare d text; begin
 select pg_get_functiondef('public.nl_loss_exception_set(uuid,text,text,text,boolean,integer,text,uuid,text)'::regprocedure) into d;
 d:=replace(d,'p_kind not in (''next_month'',''installments'')','p_kind not in (''next_month'',''installments'',''write_off'')');
 execute d;
 select pg_get_functiondef('public.nl_loss_exception_allowed(uuid,text,text,text,text)'::regprocedure) into d;
 d:=replace(d,'p_kind=''installments''','p_kind in (''installments'',''write_off'')');
 execute d;
 select pg_get_functiondef('public.waive_nl_recovery_balance(uuid,text,text,text,text,uuid,text)'::regprocedure) into d;
 if position('-- Write-off exception gate' in d)=0 then
  d:=replace(d,'-- Product write-off approval guard',$patch$
 -- Write-off exception gate
 if not nl_loss_exception_allowed(p_company,p_month,p_case,'write_off',null) then
  raise exception 'Enable Write-off for this shipment in Exceptions before writing off the outstanding balance.'; end if;
 -- Product write-off approval guard$patch$);
  d:=replace(d,'if l.outstanding<=0 then',$patch$
 -- Funded salary is collected first; the exception only writes off the remaining exit balance.
 if exists(select 1 from nl_loss_recoveries r cross join jsonb_array_elements(r.allocations) a
   where r.company_id=p_company and r.month=p_month and r.case_key=p_case and a->>'ref'=p_ref
    and a ? 'payroll_amount' and (a->>'payroll_amount')::numeric>l.deducted) then
  raise exception 'Complete the approved salary adjustment before writing off the remaining balance.'; end if;
 if l.outstanding<=0 then$patch$);
  execute d;
 end if;
end $migration$;
notify pgrst,'reload schema';
commit;
