begin;
-- A recovery directory is separate from audit attribution. It follows current People
-- postings and reporting relationships, stopping at the configured operational ceiling.
update nl_loss_sources set recovery_policy=recovery_policy||jsonb_build_object(
 'payroll_cutoff_day',5,'salary_month_offset',0,
 'directory_ceiling_designations',coalesce(recovery_policy->'directory_ceiling_designations','["AOM"]'::jsonb),
 'directory_excluded_designations',coalesce(recovery_policy->'directory_excluded_designations','["NH","BH","RH","RM","ZH","GM","FINMGR","SLPM","MP","MANAGING_PARTNER","OWNER"]'::jsonb))
where not (recovery_policy ? 'directory_ceiling_designations');

create or replace function loss_recovery_people(p_company uuid,p_station uuid)
returns table(ref text,employee_code text,full_name text,designation text,is_active boolean)
language sql stable security invoker set search_path=public as $$
with recursive policy as (
 select recovery_policy p from nl_loss_sources where company_id=p_company
), current_assignments as (
 select a.id,a.location_id,a.engagement_id,g.person_id,g.employee_id,g.contractor_id,g.worker_code,
 p.display_name,coalesce(nullif(d.name,''),a.position_title,'People') designation,
 upper(coalesce(d.code,'')) code,a.is_primary,
 coalesce((select p->'directory_ceiling_designations' ? upper(coalesce(d.code,'')) from policy),false) ceiling,
 coalesce((select p->'directory_excluded_designations' ? upper(coalesce(d.code,'')) from policy),false) excluded
 from hr_work_assignments a join hr_engagements g on g.id=a.engagement_id and g.company_id=p_company
 join hr_people p on p.id=g.person_id and p.company_id=p_company
 left join designations d on d.id=a.designation_id and d.company_id=p_company
 where a.company_id=p_company and a.effective_from <= (now() at time zone 'Asia/Kolkata')::date
 and (a.effective_to is null or a.effective_to >= (now() at time zone 'Asia/Kolkata')::date)
 and g.start_date <= (now() at time zone 'Asia/Kolkata')::date
 and (g.end_date is null or g.end_date >= (now() at time zone 'Asia/Kolkata')::date)
 and g.status='active' and p.status='active'
), roots as (
 select a.* from current_assignments a where not a.excluded and (a.location_id=p_station or exists (
 select 1 from station_responsibility_assignments r
 left join hr_work_assignments h on h.id=r.assignment_id and h.company_id=p_company
 left join hr_engagements g on g.id=h.engagement_id and g.company_id=p_company
 where r.company_id=p_company and r.station_id=p_station and r.effective_from<=now() and (r.effective_to is null or r.effective_to>=now())
 and (g.person_id=a.person_id or exists(select 1 from hr_user_person_links l where l.company_id=p_company and l.person_id=a.person_id and l.user_id=r.assignee_user_id and l.status='active'))
 ))
), chain as (
 select r.id,array[r.id] path from roots r
 union all
 select m.id,c.path||m.id from chain c join current_assignments a on a.id=c.id
 join hr_reporting_relationships r on r.subject_assignment_id=c.id and r.company_id=p_company and r.is_primary and r.relationship_type='solid_line'
 join current_assignments m on m.id=r.manager_assignment_id
 where not a.ceiling and not m.excluded and not m.id=any(c.path) and cardinality(c.path)<16
 and r.effective_from <= (now() at time zone 'Asia/Kolkata')::date and (r.effective_to is null or r.effective_to >= (now() at time zone 'Asia/Kolkata')::date)
), people as (
 select distinct on (a.person_id) a.* from current_assignments a join chain c on c.id=a.id
 order by a.person_id,a.is_primary desc,a.id
), directory as (
 select 'employee:'||e.id ref,coalesce(nullif(p.worker_code,''),e.employee_code) employee_code,
 coalesce(nullif(p.display_name,''),e.full_name) full_name,p.designation,e.is_active
 from people p join employees e on e.id=p.employee_id and e.company_id=p_company and e.deleted_at is null
 union all
 select 'contractor:'||e.id,coalesce(nullif(p.worker_code,''),e.dropx_id),coalesce(nullif(p.display_name,''),e.full_name),p.designation,e.is_active
 from people p join contractors e on e.id=p.contractor_id and e.company_id=p_company and e.deleted_at is null
 union all
 select d.* from station_audit_employee_directory(p_company,p_station) d
 where d.ref like 'workforce:%' or (d.ref like 'employee:%' and not exists(select 1 from hr_engagements g where g.company_id=p_company and 'employee:'||g.employee_id=d.ref))
 union all
 select 'contractor:'||e.id,e.dropx_id,e.full_name,coalesce(e.designation,'People'),e.is_active from contractors e
 where e.company_id=p_company and e.location_id=p_station and e.deleted_at is null
 and not exists(select 1 from hr_engagements g where g.company_id=p_company and g.contractor_id=e.id)
)
select distinct d.* from directory d where nullif(trim(d.employee_code),'') is not null
 and not exists(select 1 from designations x cross join policy p where x.company_id=p_company and (lower(x.name)=lower(d.designation) or upper(x.code)=upper(d.designation)) and p.p->'directory_excluded_designations' ? upper(x.code))
 and not exists(select 1 from workforce w join people p on (w.source_profile_type='employee' and w.source_profile_id=p.employee_id or w.source_profile_type='contractor' and w.source_profile_id=p.contractor_id)
 where w.company_id=p_company and 'workforce:'||w.id=d.ref)
order by full_name,employee_code;
$$;
revoke all on function loss_recovery_people(uuid,uuid) from public,anon,authenticated;
grant execute on function loss_recovery_people(uuid,uuid) to service_role;

-- The 5th is inclusive: October remains open through 5 November IST.
create or replace function nl_recovery_deduction_month(p_report text,p_case_month text,p_assigned_at timestamptz,p_final_seen_at timestamptz,p_timing text,p_cutoff_day int default 5)
returns text language plpgsql stable set search_path=public as $$
declare settled date; m date;
begin
 if p_timing is null or p_timing='none' or p_assigned_at is null then return null; end if;
 settled:=(greatest(p_assigned_at,coalesce(p_final_seen_at,p_assigned_at)) at time zone 'Asia/Kolkata')::date;
 m:=date_trunc('month',settled)::date;
 if extract(day from settled)<=greatest(1,least(coalesce(p_cutoff_day,5),28)) then m:=(m-interval '1 month')::date; end if;
 if p_report='nl' and p_case_month ~ '^\d{4}-(0[1-9]|1[0-2])$' then m:=greatest(m,(to_date(p_case_month,'YYYY-MM')+interval '1 month')::date); end if;
 if p_timing='next_month' then m:=(m+interval '1 month')::date; end if;
 return to_char(m,'YYYY-MM');
end $$;

-- Keep canonical recovery keys intact; add People contractors to the same payroll path.
do $$ declare f record; d text; begin
 for f in select oid,proname from pg_proc where pronamespace='public'::regnamespace and proname in ('nl_recovery_line_applied','nl_recovery_person_exit','nl_loss_recovery_due','save_nl_recovery') loop
 d:=pg_get_functiondef(f.oid);
 if f.proname='nl_recovery_line_applied' then
 d:=replace(d,'case split_part(split_part(p_key,''|'',3),'':'',1)','case (case when split_part(split_part(p_key,''|'',3),'':'',1) in (''employee'',''contractor'') then ''employee'' else split_part(split_part(p_key,''|'',3),'':'',1) end)');
 elsif f.proname='nl_recovery_person_exit' and position('when ''contractor''' in d)=0 then
 d:=replace(d,'when ''workforce'' then','when ''contractor'' then (select e.last_working_date from contractors e where e.company_id=p_company and e.id=split_part(p_ref,'':'',2)::uuid) when ''workforce'' then');
 elsif f.proname='nl_loss_recovery_due' then
 d:=replace(d,'split_part(x->>''ref'','':'',1)=case p_target when ''hrms'' then ''employee'' when ''workforce'' then ''workforce'' end','((p_target=''hrms'' and split_part(x->>''ref'','':'',1) in (''employee'',''contractor'')) or (p_target=''workforce'' and split_part(x->>''ref'','':'',1)=''workforce''))');
 elsif f.proname='save_nl_recovery' and position('-- Explicit payroll month' in d)=0 then
 d:=replace(d,'station_audit_employee_directory(p_company,station)','loss_recovery_people(p_company,station)');
 d:=regexp_replace(d,'  pay_month:=to_char\(date_trunc\(''month'',now\(\) at time zone ''Asia/Kolkata''\).*?;', '  pay_month:=null;');
 d:=replace(d,'  if p_remarks is null', $patch$  -- Explicit payroll month, independent of the loss month. Old locked schedules stay immutable.
  pay_month:=coalesce(nullif(p_plan->>'deduction_month',''),nl_recovery_deduction_month(c.report,c.month,now(),c.final_seen_at,o.deduction_timing,coalesce((policy->>'payroll_cutoff_day')::int,5)));
  if o.allocation_required and (pay_month !~ '^\d{4}-(0[1-9]|1[0-2])$' or pay_month is null) then raise exception 'Choose a valid recovery payroll month.'; end if;
  if o.allocation_required and pay_month < nl_recovery_deduction_month(c.report,c.month,now(),c.final_seen_at,'current_month',coalesce((policy->>'payroll_cutoff_day')::int,5))
     and not exists(select 1 from nl_loss_recoveries r where r.company_id=p_company and r.month=p_month and r.case_key=p_case and not r.is_deleted and r.deduction_month=pay_month) then
    raise exception 'That payroll month is past the recovery cutoff. Select an open month.';
  end if;
  if pay_month>to_char(date_trunc('month',now())+interval '12 months','YYYY-MM') then raise exception 'Choose a payroll month within the next 12 months.'; end if;
  if p_remarks is null$patch$);
 d:=replace(d,'and old.recovery_mode=v_mode','and old.deduction_month is not distinct from pay_month and old.recovery_mode=v_mode');
 d:=replace(d,'or old.deduction_timing<>o.deduction_timing','or old.deduction_month is distinct from pay_month or old.deduction_timing<>o.deduction_timing');
 d:=regexp_replace(d,'deduction:=case when same_plan and old.deduction_month is not null then old.deduction_month[\s\S]*?coalesce\(\(policy->>''payroll_cutoff_day''\)::int,7\)\) end;', 'deduction:=pay_month;');
 d:=replace(d,'and v_mode=''full'' and not v_override','and deduction=nl_recovery_deduction_month(c.report,c.month,now(),c.final_seen_at,''current_month'',coalesce((policy->>''payroll_cutoff_day'')::int,5)) and v_mode=''full'' and not v_override');
 d:=replace(d,'or exists(select 1 from workforce w where','or exists(select 1 from contractors e where ''contractor:''||e.id=x->>''ref'' and e.company_id=p_company and e.last_working_date <= (now() at time zone ''Asia/Kolkata'')::date) or exists(select 1 from workforce w where');
 d:=replace(d,'Previous-month salary payable is unavailable.','Selected payroll month salary payable is unavailable.');
 end if;
 execute d;
 end loop;
end $$;
-- One record per actual deduction key, never inferred from a plan's scheduled month.
create or replace function nl_recovery_debits(p_company uuid,p_ref text default null)
returns table(recovery_key text,loss_month text,case_key text,station_code text,employee_ref text,employee_code text,full_name text,designation text,amount numeric,payroll_month text,is_deducted boolean,shipment_id text)
language sql stable security invoker set search_path=public as $$
 select k.recovery_key,r.month,r.case_key,c.station_code,a->>'ref',a->>'employee_code',a->>'full_name',a->>'designation',k.amount,
 coalesce(f.final_in,f.any_in),f.final_in is not null,coalesce(nullif(c.details->>'tid',''),regexp_replace(r.case_key,'^slp:','','i'))
 from nl_loss_recoveries r join nl_loss_month_cases c on c.company_id=r.company_id and c.month=r.month and c.case_key=r.case_key
 cross join jsonb_array_elements(r.allocations) a cross join lateral nl_recovery_alloc_keys(r.month,r.case_key,a) k
 cross join lateral (select nl_recovery_line_applied(p_company,k.recovery_key,null,null,true) final_in,nl_recovery_line_applied(p_company,k.recovery_key,null,null,false) any_in) f
 where r.company_id=p_company and (p_ref is null or a->>'ref'=p_ref) and not r.is_deleted and coalesce(f.final_in,f.any_in) is not null
$$;
revoke all on function nl_recovery_debits(uuid,text) from public,anon,authenticated;
grant execute on function nl_recovery_debits(uuid,text) to service_role;
commit;
