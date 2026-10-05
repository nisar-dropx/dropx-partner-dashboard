begin;
-- The existing worker has one account. Bind it explicitly to its owning company.
create table public.nl_loss_sources (
 account_key text primary key, company_id uuid not null references public.companies(id), partner_shortcode text not null,
 recoverable_statuses text[] not null default array['Recoverable','Recoverable - Missed SLA by eDSP','Recoverable - Missed SLA by eDSP1','Recoverable - Missed SLA by eDSP2'],
 allow_equal_split boolean not null default true, allow_custom_split boolean not null default true,
 include_inactive_people boolean not null default true, history_months int not null default 12 check(history_months between 1 and 36), updated_by uuid, updated_at timestamptz not null default now()
);
insert into public.nl_loss_sources(account_key,company_id,partner_shortcode) select 'default',id,'DROP' from public.companies where code='DROPX_LOGISTICS';
create table public.nl_loss_month_cases (
 company_id uuid not null references public.companies(id), month text not null check(month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
 case_key text not null, station_code text, amount numeric(14,2), source_status text,
 details jsonb not null, source_present boolean not null default true, source_file text, source_run_id uuid,
 source_updated_at timestamptz not null default now(), last_seen_at timestamptz not null default now(),
 primary key(company_id,month,case_key)
);
create index nl_loss_month_station on public.nl_loss_month_cases(company_id,month,station_code);
create table public.nl_recovery_outcomes (
 company_id uuid not null references public.companies(id), code text not null check(code ~ '^[a-z][a-z0-9_]{1,49}$'),
 label text not null check(length(label) between 2 and 80), allocation_required boolean not null default false,
 remarks_required boolean not null default true, is_active boolean not null default true, sort_order int not null default 0,
 updated_by uuid, updated_at timestamptz not null default now(), primary key(company_id,code)
);
insert into public.nl_recovery_outcomes(company_id,code,label,allocation_required,sort_order)
select c.id,d.code,d.label,d.allocate,d.ord from public.companies c cross join (values
 ('recover','Recover from employees',true,10),('post_dispute','Post dispute',false,20),
 ('non_recoverable','Non-recoverable',false,30),('da_left','DA left',false,40),('utr_left','UTR left',false,50)
) d(code,label,allocate,ord);
create table public.nl_loss_recoveries (
 company_id uuid not null, month text not null, case_key text not null, outcome_code text not null,
 outcome_label text not null, split_mode text not null check(split_mode in ('equal','custom','none')),
 allocations jsonb not null default '[]', remarks text not null default '', source_amount numeric(14,2), source_status text,
 is_deleted boolean not null default false, version int not null default 1, updated_by uuid not null, updated_by_name text not null, updated_at timestamptz not null default now(),
 primary key(company_id,month,case_key), foreign key(company_id,month,case_key) references public.nl_loss_month_cases(company_id,month,case_key),
 foreign key(company_id,outcome_code) references public.nl_recovery_outcomes(company_id,code)
);
create table public.nl_loss_recovery_events (
 id uuid primary key default gen_random_uuid(), company_id uuid not null, month text not null, case_key text not null,
 before_value jsonb, after_value jsonb not null, actor_id uuid not null, actor_name text not null, created_at timestamptz not null default now()
);
create index nl_recovery_history on public.nl_loss_recovery_events(company_id,month,case_key,created_at desc);
create table public.nl_recovery_master_events (
 id uuid primary key default gen_random_uuid(), company_id uuid not null, code text not null,
 before_value jsonb, after_value jsonb not null, actor_id uuid, created_at timestamptz not null default now()
);
alter table public.nl_loss_sources enable row level security;
alter table public.nl_loss_month_cases enable row level security;
alter table public.nl_recovery_outcomes enable row level security;
alter table public.nl_loss_recoveries enable row level security;
alter table public.nl_loss_recovery_events enable row level security;
alter table public.nl_recovery_master_events enable row level security;
revoke all on public.nl_loss_sources,public.nl_loss_month_cases,public.nl_recovery_outcomes,public.nl_loss_recoveries,public.nl_loss_recovery_events,public.nl_recovery_master_events from anon,authenticated;
grant all on public.nl_loss_sources,public.nl_loss_month_cases,public.nl_recovery_outcomes,public.nl_loss_recoveries,public.nl_loss_recovery_events,public.nl_recovery_master_events to service_role;

-- Match the provider's explicit decision, not generic case workflow status or a substring of Non-Recoverable.
create function public.nl_is_recoverable(co uuid,status text) returns boolean language sql stable security invoker set search_path=public as $$
 select exists(select 1 from nl_loss_sources s,unnest(s.recoverable_statuses) label where s.company_id=co and lower(trim(label))=lower(trim(status)))
$$;
create function public.nl_recovery_month(c jsonb, pulled_at timestamptz) returns text language plpgsql immutable as $$
declare p text:=trim(c->>'period'); y int; m int; ref date:=pulled_at::date;
begin
 if p ~ '^\d{4}-(0?[1-9]|1[0-2])$' then return split_part(p,'-',1)||'-'||lpad(split_part(p,'-',2),2,'0'); end if;
 if p ~ '^(0?[1-9]|1[0-2])(\.0+)?$' then
  m:=p::numeric::int;
  y:=coalesce(nullif(c->'extra'->>'recovery_year','')::int,substring(c->>'impact_date' from '^([0-9]{4})')::int,extract(year from ref)::int);
  if nullif(c->>'impact_date','') is null and nullif(c->'extra'->>'recovery_year','') is null and m>extract(month from ref) then y:=y-1; end if;
  return y::text||'-'||lpad(m::text,2,'0');
 end if;
 raise exception 'NL recovery month is missing or ambiguous. Preserve the previous successful month and review the source.';
end $$;
create function public.nl_archive_pull(p_run uuid,p_cases jsonb) returns void language plpgsql security invoker set search_path=public as $$
declare co uuid; r public.loss_report_runs; months text[];
begin
 select company_id into strict co from nl_loss_sources where account_key='default';
 select * into strict r from loss_report_runs where id=p_run and report='nl';
 if jsonb_array_length(p_cases)=0 then raise exception 'Empty NL export cannot replace verified monthly data.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('nl-import:'||co::text,0));
 select array_agg(distinct nl_recovery_month(c,r.started_at)) into months from jsonb_array_elements(p_cases)c;
 -- Only months explicitly present in a complete export are refreshed. Earlier months survive rollover.
 update nl_loss_month_cases set source_present=false where company_id=co and month=any(months);
 insert into nl_loss_month_cases(company_id,month,case_key,station_code,amount,source_status,details,source_file,source_run_id,last_seen_at)
 select co,nl_recovery_month(c,r.started_at),c->>'case_key',c->>'station_code',(c->>'amount')::numeric,
  c->'extra'->>'nl_status',c,r.source_file,p_run,now() from jsonb_array_elements(p_cases)c
 on conflict(company_id,month,case_key) do update set station_code=excluded.station_code,amount=excluded.amount,source_status=excluded.source_status,
  details=excluded.details,source_present=true,source_file=excluded.source_file,source_run_id=excluded.source_run_id,last_seen_at=now(),
  source_updated_at=case when nl_loss_month_cases.details is distinct from excluded.details then now() else nl_loss_month_cases.source_updated_at end;
end $$;
-- Preserve already imported August data without changing any internal recovery decisions.
do $$ declare r uuid; cases jsonb; begin
 select id into r from public.loss_report_runs where report='nl' and status='completed' order by started_at desc limit 1;
 select jsonb_agg(to_jsonb(c)-'report'-'run_id'-'updated_at') into cases from public.loss_cases c where report='nl';
 if r is not null and cases is not null then perform public.nl_archive_pull(r,cases); end if;
end $$;

-- Atomic recovery plans; no payroll deductions are generated here.
create function public.save_nl_recovery(p_company uuid,p_month text,p_case text,p_version int,p_outcome text,p_mode text,p_allocations jsonb,p_remarks text,p_actor uuid,p_name text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare c nl_loss_month_cases; o nl_recovery_outcomes; old nl_loss_recoveries; saved nl_loss_recoveries; a jsonb; people jsonb:='[]'; person jsonb; station uuid; total bigint:=0; expected bigint; n int; i int:=0; amt bigint;
begin
 select * into c from nl_loss_month_cases where company_id=p_company and month=p_month and case_key=p_case for update;
 if not found or not c.source_present or not nl_is_recoverable(p_company,c.source_status) then raise exception 'This case is no longer recoverable in Cloak. Refresh the list.'; end if;
 select * into o from nl_recovery_outcomes where company_id=p_company and code=p_outcome and is_active;
 if not found then raise exception 'Choose an active outcome from Loss Recovery Master.'; end if;
 if length(trim(p_remarks))>2000 or (o.remarks_required and length(trim(p_remarks))<5) then raise exception 'Add a clear recovery remark (5–2,000 characters).'; end if;
 select * into old from nl_loss_recoveries where company_id=p_company and month=p_month and case_key=p_case;
 if coalesce(old.version,0)<>p_version then raise exception 'Another person updated this recovery. Refresh before saving.'; end if;
 if jsonb_typeof(p_allocations)<>'array' or jsonb_array_length(p_allocations)>50 then raise exception 'Select up to 50 employees.'; end if;
 select s.id into station from stations s left join cod_station_settings x on x.location_id=s.id and x.company_id=p_company
  where s.company_id=p_company and upper(coalesce(nullif(x.portal_station_code,''),s.station_code))=upper(c.station_code) order by (s.station_code=c.station_code) desc limit 1;
 if station is null then raise exception 'Map the source station before allocating recovery.'; end if;
 if o.allocation_required then
  if not exists(select 1 from nl_loss_sources where company_id=p_company and ((p_mode='equal' and allow_equal_split) or (p_mode='custom' and allow_custom_split))) then raise exception 'This split method is disabled in Master.'; end if;
  n:=jsonb_array_length(p_allocations); expected:=round(c.amount*100);
  if n<1 or expected is null or expected<=0 or p_mode not in ('equal','custom') then raise exception 'Select employees and a valid split for the full loss value.'; end if;
  if (select count(distinct x->>'employee_ref') from jsonb_array_elements(p_allocations)x)<>n then raise exception 'An employee can only be selected once.'; end if;
  for a in select value from jsonb_array_elements(p_allocations) loop
   select to_jsonb(d) into person from station_audit_employee_directory(p_company,station)d where d.ref=a->>'employee_ref';
   if not coalesce((person->>'is_active')::boolean,false) and not exists(select 1 from nl_loss_sources where company_id=p_company and include_inactive_people) then raise exception 'Inactive employees are disabled in Master.'; end if;
   if person is null then raise exception 'Selected employee is not linked to this station.'; end if;
   if p_mode='equal' then amt:=expected/n+case when i<expected%n then 1 else 0 end;
   else
    if coalesce(a->>'amount','') !~ '^\d+(\.\d{1,2})?$' then raise exception 'Enter amounts with at most two decimal places.'; end if;
    amt:=((a->>'amount')::numeric*100)::bigint;
   end if;
   if amt<=0 then raise exception 'Every selected employee must have a positive amount.'; end if;
   total:=total+amt;i:=i+1;
   people:=people||jsonb_build_array(person||jsonb_build_object('amount',amt::numeric/100));
  end loop;
  if total<>expected then raise exception 'Individual amounts must equal the full loss value.'; end if;
 else
  if jsonb_array_length(p_allocations)>0 or p_mode<>'none' then raise exception 'This outcome does not allocate employee recovery.'; end if;
 end if;
 insert into nl_loss_recoveries(company_id,month,case_key,outcome_code,outcome_label,split_mode,allocations,remarks,source_amount,source_status,version,updated_by,updated_by_name)
 values(p_company,p_month,p_case,o.code,o.label,p_mode,people,trim(p_remarks),c.amount,c.source_status,p_version+1,p_actor,p_name)
 on conflict(company_id,month,case_key) do update set outcome_code=excluded.outcome_code,outcome_label=excluded.outcome_label,split_mode=excluded.split_mode,
 allocations=excluded.allocations,remarks=excluded.remarks,source_amount=excluded.source_amount,source_status=excluded.source_status,
 is_deleted=false,version=excluded.version,updated_by=excluded.updated_by,updated_by_name=excluded.updated_by_name,updated_at=now() returning * into saved;
 insert into nl_loss_recovery_events(company_id,month,case_key,before_value,after_value,actor_id,actor_name)
 values(p_company,p_month,p_case,case when old.version is null then null else to_jsonb(old) end,to_jsonb(saved),p_actor,p_name);
 return to_jsonb(saved);
end $$;

create function public.clear_nl_recovery(p_company uuid,p_month text,p_case text,p_version int,p_actor uuid,p_name text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare old nl_loss_recoveries; saved nl_loss_recoveries;
begin
 perform 1 from nl_loss_month_cases where company_id=p_company and month=p_month and case_key=p_case for update;
 select * into old from nl_loss_recoveries where company_id=p_company and month=p_month and case_key=p_case;
 if not found or old.version<>p_version or old.is_deleted then raise exception 'Recovery changed. Refresh before removing it.'; end if;
 update nl_loss_recoveries set is_deleted=true,version=version+1,updated_by=p_actor,updated_by_name=p_name,updated_at=now()
 where company_id=p_company and month=p_month and case_key=p_case returning * into saved;
 insert into nl_loss_recovery_events(company_id,month,case_key,before_value,after_value,actor_id,actor_name)
 values(p_company,p_month,p_case,to_jsonb(old),to_jsonb(saved),p_actor,p_name);
 return to_jsonb(saved);
end $$;
revoke all on function public.clear_nl_recovery(uuid,text,text,int,uuid,text) from public,anon,authenticated;
grant execute on function public.clear_nl_recovery(uuid,text,text,int,uuid,text) to service_role;

create function public.nl_master_audit() returns trigger language plpgsql security invoker set search_path=public as $$
begin
 insert into nl_recovery_master_events(company_id,code,before_value,after_value,actor_id) values(new.company_id,case when tg_table_name='nl_loss_sources' then 'source_settings' else to_jsonb(new)->>'code' end,case when tg_op='UPDATE' then to_jsonb(old) end,to_jsonb(new),new.updated_by);
 return new;
end $$;
create trigger nl_source_changes after update on public.nl_loss_sources for each row execute function public.nl_master_audit();
create trigger nl_outcome_changes after insert or update on public.nl_recovery_outcomes for each row execute function public.nl_master_audit();
revoke all on function public.nl_is_recoverable(uuid,text),public.nl_recovery_month(jsonb,timestamptz),public.nl_archive_pull(uuid,jsonb),public.save_nl_recovery(uuid,text,text,int,text,text,jsonb,text,uuid,text),public.nl_master_audit() from public,anon,authenticated;
grant execute on function public.nl_is_recoverable(uuid,text),public.nl_recovery_month(jsonb,timestamptz),public.nl_archive_pull(uuid,jsonb),public.save_nl_recovery(uuid,text,text,int,text,text,jsonb,text,uuid,text),public.nl_master_audit() to service_role;

insert into public.app_pages(company_id,code,name,sort_order) select id,'ops_loss_master','Loss Recovery Master',94 from public.companies on conflict(company_id,code) do nothing;
-- Follow existing COD master administration, with an independently editable permission.
insert into public.role_page_permissions(company_id,role_id,page_id,can_view,can_add,can_edit)
select p.company_id,p.role_id,t.id,p.can_view,p.can_add,p.can_edit from public.role_page_permissions p join public.app_pages a on a.id=p.page_id and a.code='cod_master' join public.app_pages t on t.company_id=p.company_id and t.code='ops_loss_master'
on conflict(company_id,role_id,page_id) do nothing;
-- Explicitly requested cluster-manager recovery editing; station scope remains enforced on every read/write.
insert into public.role_page_permissions(company_id,role_id,page_id,can_view,can_add,can_edit)
select r.company_id,r.id,p.id,true,true,true from public.user_roles r join public.app_pages p on p.company_id=r.company_id where r.code='OPERATIONS_CLM' and p.code='ops_losses'
on conflict(company_id,role_id,page_id) do update set can_view=true,can_add=true,can_edit=true;

create or replace function public.loss_apply_cases(p_report text, p_run jsonb, p_cases jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run uuid;
begin
  insert into loss_report_runs (report, status, source_file, source_week, source_created_at, period_label,
    source_total_count, headers, station_column, amount_column, reference_column, total_rows, total_amount,
    triggered_by, content_hash, checked_at, finished_at)
  select p_report, 'completed', p_run->>'source_file', p_run->>'source_week', p_run->>'source_created_at',
    p_run->>'period_label', (p_run->>'source_total_count')::int, coalesce(p_run->'headers', '[]'::jsonb),
    p_run->>'station_column', p_run->>'amount_column', p_run->>'reference_column',
    jsonb_array_length(p_cases),
    coalesce((select sum((c->>'amount')::numeric) from jsonb_array_elements(p_cases) c), 0),
    p_run->>'triggered_by', p_run->>'content_hash', now(), now()
  returning id into v_run;

  insert into loss_cases (report, case_key, run_id, tid, tid_approximate, station_code, amount, case_status,
    category, sub_category, impact_date, closed_date, da_name, remarks, period, extra, updated_at)
  select p_report, c.case_key, v_run, c.tid, coalesce(c.tid_approximate, false), c.station_code, c.amount,
    c.case_status, c.category, c.sub_category, c.impact_date, c.closed_date, c.da_name, c.remarks, c.period,
    coalesce(c.extra, '{}'::jsonb), now()
  from jsonb_to_recordset(p_cases) as c(case_key text, tid text, tid_approximate boolean, station_code text,
    amount numeric, case_status text, category text, sub_category text, impact_date date, closed_date date,
    da_name text, remarks text, period text, extra jsonb)
  on conflict (report, case_key) do update set
    run_id = excluded.run_id, tid = excluded.tid, tid_approximate = excluded.tid_approximate,
    station_code = excluded.station_code, amount = excluded.amount, case_status = excluded.case_status,
    category = excluded.category, sub_category = excluded.sub_category, impact_date = excluded.impact_date,
    closed_date = excluded.closed_date, da_name = excluded.da_name, remarks = excluded.remarks,
    period = excluded.period, extra = excluded.extra, updated_at = now();

  if p_report = 'nl' then perform public.nl_archive_pull(v_run,p_cases); end if;

  delete from loss_cases where report = p_report and run_id is distinct from v_run;

  insert into loss_report_station_totals (run_id, report, station_code, row_count, total_amount)
  select v_run, p_report, coalesce(station_code, 'UNMAPPED'), count(*), coalesce(sum(amount), 0)
  from loss_cases where report = p_report group by 1, 2, 3;

  delete from loss_report_runs where report = p_report and id in (
    select id from loss_report_runs where report = p_report order by started_at desc offset 10);

  return v_run;
end;
$$;


commit;
