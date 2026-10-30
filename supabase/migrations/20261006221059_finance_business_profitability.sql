-- Finance-only configuration and monthly Amazon Now units. Browser roles have no direct access.
create table public.finance_business_master (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
 kind text not null check(kind in ('now_rate','now_store','cost_head','contract','overhead','insight')),
 key text not null check(length(key) between 1 and 160), label text not null check(length(label) between 1 and 200),
 data jsonb not null check(jsonb_typeof(data)='object'), revision integer not null default 1,
 deleted_at timestamptz, updated_by uuid, updated_at timestamptz not null default now(),
 unique(company_id,kind,key)
);
create table public.finance_now_volumes (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
 station_code text not null, month date not null check(extract(day from month)=1),
 through_date date not null, units bigint not null check(units>=0),
 incentive_percent numeric(5,2) check(incentive_percent between 0 and 100),
 note text not null default '', revision integer not null default 1,
 updated_by uuid, updated_at timestamptz not null default now(),
 check(date_trunc('month',through_date)::date=month),unique(company_id,station_code,month)
);
create table public.finance_business_audit (
 id bigint generated always as identity primary key,company_id uuid not null references public.companies(id),
 entity text not null,record_id uuid not null,actor uuid,previous jsonb,current jsonb,created_at timestamptz not null default now()
);
alter table public.finance_business_master enable row level security;
alter table public.finance_now_volumes enable row level security;
alter table public.finance_business_audit enable row level security;
revoke all on public.finance_business_master,public.finance_now_volumes,public.finance_business_audit from anon,authenticated;
grant all on public.finance_business_master,public.finance_now_volumes,public.finance_business_audit to service_role;
grant usage,select on sequence public.finance_business_audit_id_seq to service_role;
create index finance_business_audit_company_date on public.finance_business_audit(company_id,created_at);

create function public.finance_save_business_master(p_company uuid,p_actor uuid,p_kind text,p_key text,p_label text,p_data jsonb,p_revision integer,p_delete boolean default false)
returns uuid language plpgsql security invoker set search_path=public as $$
declare oldrow finance_business_master;newrow finance_business_master;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_company::text||p_kind||p_key,0));
 select * into oldrow from finance_business_master where company_id=p_company and kind=p_kind and key=p_key for update;
 if coalesce(oldrow.revision,0)<>p_revision then raise exception 'Record changed. Refresh before saving.';end if;
 if p_delete and oldrow.id is null then raise exception 'Record not found';end if;
 insert into finance_business_master(company_id,kind,key,label,data,revision,deleted_at,updated_by)
 values(p_company,p_kind,p_key,p_label,p_data,1,case when p_delete then now() end,p_actor)
 on conflict(company_id,kind,key) do update set label=excluded.label,data=excluded.data,revision=finance_business_master.revision+1,deleted_at=excluded.deleted_at,updated_by=p_actor,updated_at=now()
 returning * into newrow;
 insert into finance_business_audit(company_id,entity,record_id,actor,previous,current) values(p_company,p_kind,newrow.id,p_actor,case when oldrow.id is not null then to_jsonb(oldrow) end,to_jsonb(newrow));
 return newrow.id;
end;$$;
revoke all on function public.finance_save_business_master(uuid,uuid,text,text,text,jsonb,integer,boolean) from public,anon,authenticated;
grant execute on function public.finance_save_business_master(uuid,uuid,text,text,text,jsonb,integer,boolean) to service_role;

create function public.finance_save_now_volumes(p_company uuid,p_actor uuid,p_rows jsonb)
returns integer language plpgsql security invoker set search_path=public as $$
declare item jsonb;oldrow finance_now_volumes;newrow finance_now_volumes;n integer:=0;
begin
 if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 500 then raise exception 'Invalid volume import';end if;
 for item in select value from jsonb_array_elements(p_rows) order by value->>'station_code',value->>'month' loop
  if not exists(select 1 from stations s join location_models m on m.id=s.location_model_id where s.company_id=p_company and s.station_code=item->>'station_code' and upper(m.code)='NOW' and not s.is_ho) then raise exception 'Only Amazon Now stores accept unit volumes';end if;
  perform pg_advisory_xact_lock(hashtextextended(p_company::text||(item->>'station_code')||(item->>'month'),0));
  select * into oldrow from finance_now_volumes where company_id=p_company and station_code=item->>'station_code' and month=((item->>'month')||'-01')::date for update;
  if coalesce(oldrow.revision,0)<>coalesce((item->>'revision')::integer,0) then raise exception 'Volume changed. Refresh and review before saving.';end if;
  insert into finance_now_volumes(company_id,station_code,month,through_date,units,incentive_percent,note,updated_by)
  values(p_company,item->>'station_code',((item->>'month')||'-01')::date,(item->>'through_date')::date,(item->>'units')::bigint,nullif(item->>'incentive_percent','')::numeric,coalesce(item->>'note',''),p_actor)
  on conflict(company_id,station_code,month) do update set through_date=excluded.through_date,units=excluded.units,incentive_percent=excluded.incentive_percent,note=excluded.note,revision=finance_now_volumes.revision+1,updated_at=now(),updated_by=p_actor returning * into newrow;
  insert into finance_business_audit(company_id,entity,record_id,actor,previous,current)values(p_company,'now_volume',newrow.id,p_actor,case when oldrow.id is not null then to_jsonb(oldrow) end,to_jsonb(newrow));n:=n+1;
 end loop;
 return n;
end;$$;
revoke all on function public.finance_save_now_volumes(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.finance_save_now_volumes(uuid,uuid,jsonb) to service_role;

-- Full People CTC for residual HO costs. Attendance and roster are deliberately not inputs.
create function public.finance_ho_people(p_company uuid,p_from date,p_through date)
returns jsonb language sql stable security invoker set search_path=public as $$
with profiles as (
 select e.id,e.employee_code code,e.full_name name,e.location_id,e.date_of_join,e.last_working_date,e.is_active,e.deleted_at,d.code role,'employee'::text profile_type
 from employees e left join designations d on d.id=e.designation_id and d.company_id=p_company
 where e.company_id=p_company and (e.deleted_at is null or e.deleted_at::date>=p_from)
 union all
 select c.id,c.dropx_id,c.full_name,c.location_id,c.date_of_join,c.last_working_date,c.is_active,c.deleted_at,c.designation,'contractor'
 from contractors c where c.company_id=p_company and (c.deleted_at is null or c.deleted_at::date>=p_from)
), assignments as (
 select p.id person_id,s.station_code,greatest(a.effective_from,g.start_date) effective_from,
 least(coalesce(a.effective_to,p_through),coalesce(g.end_date,p_through)) effective_to
 from profiles p join hr_engagements g on g.company_id=p_company and ((p.profile_type='employee' and g.employee_id=p.id) or (p.profile_type='contractor' and g.contractor_id=p.id))
 join hr_work_assignments a on a.engagement_id=g.id and a.company_id=p_company
 join stations s on s.id=a.location_id and s.company_id=p_company
 where a.effective_from<=p_through and coalesce(a.effective_to,p_through)>=p_from
),ho as (
 select p.*,s.station_code from profiles p join stations s on s.id=p.location_id and s.company_id=p_company where s.is_ho or exists(select 1 from assignments a join stations h on h.company_id=p_company and h.station_code=a.station_code and h.is_ho where a.person_id=p.id)
), salaries as (
 select a.id,a.employee_id person_id,a.effective_from,a.effective_to,max(v.amount)filter(where h.head_type='ctc') monthly_ctc
 from hr_employee_salary_assignments a left join hr_employee_salary_values v on v.assignment_id=a.id and v.company_id=p_company
 left join hr_payroll_heads h on h.id=v.payroll_head_id and h.company_id=p_company
 where a.company_id=p_company and a.employee_id in(select id from ho where profile_type='employee') and a.effective_from<=p_through and coalesce(a.effective_to,p_through)>=p_from
 group by a.id,a.employee_id,a.effective_from,a.effective_to
 union all
 select a.id,a.contractor_id,a.effective_from,a.effective_to,case when payment_basis='monthly' then base_amount end
 from hr_contractor_pay_profiles a where a.company_id=p_company and a.contractor_id in(select id from ho where profile_type='contractor') and a.effective_from<=p_through and coalesce(a.effective_to,p_through)>=p_from
)
select jsonb_build_object('people',coalesce((select jsonb_agg(ho)from ho),'[]'),'salaries',coalesce((select jsonb_agg(salaries)from salaries),'[]'),'assignments',coalesce((select jsonb_agg(assignments)from assignments),'[]'));
$$;
revoke all on function public.finance_ho_people(uuid,date,date) from public,anon,authenticated;
grant execute on function public.finance_ho_people(uuid,date,date) to service_role;
