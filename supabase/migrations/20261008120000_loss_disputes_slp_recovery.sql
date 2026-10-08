begin;
-- Team Ops → Losses: SLP cases join the NL recovery ledger, live Cloak months carry their
-- dispute window, and stations raise dispute requests inside OpsPulse.

-- 1. One recovery ledger for NL and SLP. SLP keys are namespaced ('slp:…'), so the existing
--    (company, month, case_key) identity, recovery plans, history and salary reservations all apply.
alter table public.nl_loss_month_cases add column report text not null default 'nl' check (report in ('nl','slp'));
alter table public.nl_loss_month_cases add column data_source text check (data_source in ('live','historic'));
update public.nl_loss_month_cases set data_source = case when source_file like 'cloak-historic-%' then 'historic' else 'live' end;
create index nl_loss_month_report on public.nl_loss_month_cases(company_id,report,month);
alter table public.nl_loss_sources add column live_window jsonb;
alter table public.nl_loss_sources add column live_window_checked_at timestamptz;

create function public.nl_case_recoverable(co uuid,p_report text,status text) returns boolean language sql stable security invoker set search_path=public as $$
 -- An SLP recovery file lists only amounts Amazon is recovering; NL follows the Master's final decisions.
 select p_report='slp' or nl_is_recoverable(co,status)
$$;

create or replace function public.nl_archive_pull(p_run uuid,p_cases jsonb) returns void language plpgsql security invoker set search_path=public as $$
declare co uuid; r public.loss_report_runs; months text[]; src text;
begin
 select company_id into strict co from nl_loss_sources where account_key='default';
 select * into strict r from loss_report_runs where id=p_run and report='nl';
 if jsonb_array_length(p_cases)=0 then raise exception 'Empty NL export cannot replace verified monthly data.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('nl-import:'||co::text,0));
 -- Historic exports are requested per recovery month; the live export carries no month label.
 src:=case when r.period_label is null then 'live' else 'historic' end;
 select array_agg(distinct nl_recovery_month(c,r.started_at)) into months from jsonb_array_elements(p_cases)c;
 -- Only months explicitly present in a complete export are refreshed. Earlier months survive rollover.
 update nl_loss_month_cases set source_present=false where company_id=co and report='nl' and month=any(months);
 insert into nl_loss_month_cases(company_id,month,case_key,station_code,amount,source_status,details,source_file,source_run_id,last_seen_at,data_source)
 select co,nl_recovery_month(c,r.started_at),c->>'case_key',c->>'station_code',(c->>'amount')::numeric,
  c->'extra'->>'nl_status',c,r.source_file,p_run,now(),src from jsonb_array_elements(p_cases)c
 on conflict(company_id,month,case_key) do update set station_code=excluded.station_code,amount=excluded.amount,source_status=excluded.source_status,
  details=excluded.details,source_present=true,source_file=excluded.source_file,source_run_id=excluded.source_run_id,last_seen_at=now(),data_source=excluded.data_source,
  source_updated_at=case when nl_loss_month_cases.details is distinct from excluded.details then now() else nl_loss_month_cases.source_updated_at end;
end $$;

-- SLP Initial and Final list the same case; it is archived once so it can only be recovered once.
create function public.slp_case_month(c public.loss_cases) returns text language plpgsql immutable as $$
declare m text[]:=regexp_match(coalesce(c.extra->>'month',''),'^\s*(\d{1,2})(?:\.0+)?\s+(\d{4})\s*$'); d date:=coalesce(c.closed_date,c.impact_date);
begin
 if m is not null and m[1]::int between 1 and 12 then return m[2]||'-'||lpad(m[1],2,'0'); end if;
 if d is not null then return to_char(d,'YYYY-MM'); end if;
 return null;
end $$;
create function public.slp_current_cases() returns table(case_key text,month text,station_code text,amount numeric,stage text,details jsonb,source_file text,run_id uuid)
language sql stable security invoker set search_path=public as $$
 select distinct on (c.case_key) 'slp:'||c.case_key, slp_case_month(c), c.station_code, c.amount,
  case when c.report='slp_final' then 'SLP Final' else 'SLP Initial' end,
  (to_jsonb(c)-'report'-'run_id'-'updated_at') || jsonb_build_object(
   'in_initial',exists(select 1 from loss_cases i where i.report='slp_initial' and i.case_key=c.case_key),
   'in_final',exists(select 1 from loss_cases f where f.report='slp_final' and f.case_key=c.case_key),
   'final_published',exists(select 1 from loss_cases f where f.report='slp_final' and f.period=c.period)),
  (select r.source_file from loss_report_runs r where r.id=c.run_id), c.run_id
 from loss_cases c where c.report in ('slp_initial','slp_final')
 -- The Final file is the settled amount, so it wins when a case is in both.
 order by c.case_key,(c.report='slp_final') desc
$$;
create function public.slp_archive_cases(p_run uuid) returns void language plpgsql security invoker set search_path=public as $$
declare co uuid;
begin
 select company_id into co from nl_loss_sources where account_key='default';
 if co is null then return; end if;
 perform pg_advisory_xact_lock(hashtextextended('nl-import:'||co::text,0));
 -- A case without a usable month cannot join a payroll cycle; it stays visible in the source report only.
 update nl_loss_month_cases o set source_present=false where o.company_id=co and o.report='slp' and o.source_present
  and not exists(select 1 from slp_current_cases() n where n.month=o.month and n.case_key=o.case_key);
 insert into nl_loss_month_cases(company_id,report,month,case_key,station_code,amount,source_status,details,source_file,source_run_id,last_seen_at)
 select co,'slp',n.month,n.case_key,n.station_code,n.amount,n.stage,n.details,n.source_file,n.run_id,now() from slp_current_cases() n where n.month is not null
 on conflict(company_id,month,case_key) do update set station_code=excluded.station_code,amount=excluded.amount,source_status=excluded.source_status,
  details=excluded.details,source_present=true,source_file=excluded.source_file,source_run_id=excluded.source_run_id,last_seen_at=now(),
  source_updated_at=case when nl_loss_month_cases.details is distinct from excluded.details then now() else nl_loss_month_cases.source_updated_at end;
end $$;

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

  if p_report in ('slp_initial','slp_final') then perform public.slp_archive_cases(v_run); end if;

  return v_run;
end;
$$;

-- Cases already pulled before this migration.
select public.slp_archive_cases(null);

-- 2. Recovery plans accept SLP cases; everything else in the saved-plan contract is unchanged.
create or replace function public.save_nl_recovery(p_company uuid,p_month text,p_case text,p_version int,p_outcome text,p_mode text,p_allocations jsonb,p_remarks text,p_actor uuid,p_name text,p_details jsonb default '{}')
returns jsonb language plpgsql security invoker set search_path=public as $$
declare c nl_loss_month_cases; o nl_recovery_outcomes; old nl_loss_recoveries; saved nl_loss_recoveries; a jsonb; people jsonb:='[]'; person jsonb; station uuid; total bigint:=0; expected bigint; n int; i int:=0; amt bigint; deduction text; policy jsonb; settings_updated timestamptz; pay nl_recovery_payables; pay_month text; reserved numeric; cap numeric; attachment jsonb;
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
 -- Keep a saved deduction period stable when its plan is edited in a later month.
 if o.deduction_timing<>'none' then
  deduction:=case when not coalesce(old.is_deleted,true) and old.deduction_timing=o.deduction_timing and old.deduction_month is not null then old.deduction_month
   else to_char(date_trunc('month',now() at time zone 'Asia/Kolkata') + case when o.deduction_timing='next_month' then interval '1 month' else interval '0 month' end,'YYYY-MM') end;
 end if;
 insert into nl_loss_recoveries(company_id,month,case_key,outcome_code,outcome_label,split_mode,allocations,remarks,source_amount,source_status,version,updated_by,updated_by_name,deduction_timing,deduction_month,recovery_details)
 values(p_company,p_month,p_case,o.code,o.label,p_mode,people,trim(p_remarks),c.amount,c.source_status,p_version+1,p_actor,p_name,o.deduction_timing,deduction,p_details)
 on conflict(company_id,month,case_key) do update set outcome_code=excluded.outcome_code,outcome_label=excluded.outcome_label,split_mode=excluded.split_mode,
 allocations=excluded.allocations,remarks=excluded.remarks,source_amount=excluded.source_amount,source_status=excluded.source_status,
 recovery_details=excluded.recovery_details,deduction_timing=excluded.deduction_timing,deduction_month=excluded.deduction_month,
 is_deleted=false,version=excluded.version,updated_by=excluded.updated_by,updated_by_name=excluded.updated_by_name,updated_at=now() returning * into saved;
 insert into nl_loss_recovery_events(company_id,month,case_key,before_value,after_value,actor_id,actor_name)
 values(p_company,p_month,p_case,case when old.version is null then null else to_jsonb(old) end,to_jsonb(saved),p_actor,p_name);
 return to_jsonb(saved);
end $$;

-- 3. "Already recovered" closes a case without a second deduction. Restricted outcomes need their own permission.
alter table public.nl_recovery_outcomes add column restricted boolean not null default false;
insert into public.nl_recovery_outcomes(company_id,code,label,allocation_required,remarks_required,sort_order,deduction_timing,restricted)
select id,'already_recovered','Already recovered',false,true,25,'none',true from public.companies
on conflict(company_id,code) do update set restricted=true;
insert into public.app_pages(company_id,code,name,sort_order) select id,'ops_loss_recovered','Team Ops · Losses · Mark already recovered',89 from public.companies on conflict(company_id,code) do nothing;
-- Loss Recovery Master editors and the SLP manager start with it; grant others in Designation Access.
insert into public.role_page_permissions(company_id,role_id,page_id,can_view,can_add,can_edit)
select p.company_id,p.role_id,t.id,true,true,true from public.role_page_permissions p
 join public.app_pages a on a.id=p.page_id and a.code='ops_loss_master' join public.app_pages t on t.company_id=p.company_id and t.code='ops_loss_recovered'
 where p.can_edit
on conflict(company_id,role_id,page_id) do nothing;
insert into public.role_page_permissions(company_id,role_id,page_id,can_view,can_add,can_edit)
select r.company_id,r.id,p.id,true,true,true from public.user_roles r join public.app_pages p on p.company_id=r.company_id where r.code='OPERATIONS_SLPM' and p.code='ops_loss_recovered'
on conflict(company_id,role_id,page_id) do nothing;

-- 4. Station dispute requests for the live Cloak month. One current request per case; every change is kept in events.
create table public.nl_dispute_requests (
 company_id uuid not null, month text not null, case_key text not null,
 decision text not null check (decision in ('dispute','accept')),
 reason text not null default '', remarks text not null default '', cctv_url text,
 attachments jsonb not null default '[]',
 status text not null check (status in ('draft','submitted','returned','filed')),
 desk_note text not null default '', source_stage text, source_amount numeric(14,2),
 version int not null default 1,
 created_by uuid not null, created_by_name text not null, updated_by uuid not null, updated_by_name text not null,
 submitted_at timestamptz, filed_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 primary key(company_id,month,case_key),
 foreign key(company_id,month,case_key) references public.nl_loss_month_cases(company_id,month,case_key)
);
create index nl_dispute_requests_status on public.nl_dispute_requests(company_id,month,status);
create table public.nl_dispute_request_events (
 id uuid primary key default gen_random_uuid(), company_id uuid not null, month text not null, case_key text not null,
 action text not null, snapshot jsonb not null, actor_id uuid not null, actor_name text not null, created_at timestamptz not null default now()
);
create index nl_dispute_request_history on public.nl_dispute_request_events(company_id,month,case_key,created_at desc);
alter table public.nl_dispute_requests enable row level security;
alter table public.nl_dispute_request_events enable row level security;
revoke all on public.nl_dispute_requests,public.nl_dispute_request_events from anon,authenticated;
grant all on public.nl_dispute_requests,public.nl_dispute_request_events to service_role;

-- Version-checked write with its history row, so two people cannot overwrite each other's request.
create function public.save_nl_dispute_request(p_company uuid,p_month text,p_case text,p_version int,p_action text,p_values jsonb,p_actor uuid,p_name text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare c nl_loss_month_cases; old nl_dispute_requests; saved nl_dispute_requests; next_status text; a jsonb;
begin
 select * into c from nl_loss_month_cases where company_id=p_company and month=p_month and case_key=p_case and report='nl' for update;
 if not found or not c.source_present then raise exception 'This case is no longer in the Cloak export. Refresh the list.'; end if;
 select * into old from nl_dispute_requests where company_id=p_company and month=p_month and case_key=p_case;
 if coalesce(old.version,0)<>p_version then raise exception 'Another person updated this dispute. Refresh before saving.'; end if;
 if p_action in ('save','submit') then
  -- A request sent in an earlier stage is history once Amazon hands the case back (eDSP1 → eDSP2): the station answers afresh.
  if old.status in ('submitted','filed') and old.source_stage is not distinct from c.details->'extra'->>'current_sla_stage' then raise exception 'This dispute was already sent to the Cloak desk. Withdraw it, or ask the desk to return it, before editing.'; end if;
  if coalesce(p_values->>'decision','') not in ('dispute','accept') then raise exception 'Choose whether to dispute or accept this loss.'; end if;
  if length(coalesce(p_values->>'reason',''))>200 or length(coalesce(p_values->>'remarks',''))>4000 then raise exception 'Dispute text is too long.'; end if;
  if nullif(p_values->>'cctv_url','') is not null and (p_values->>'cctv_url') !~ '^https://[^[:space:]]+$' then raise exception 'Enter a valid HTTPS CCTV link.'; end if;
  if jsonb_typeof(coalesce(p_values->'attachments','[]'))<>'array' or jsonb_array_length(coalesce(p_values->'attachments','[]'))>5 then raise exception 'Too many attachments.'; end if;
  for a in select value from jsonb_array_elements(coalesce(p_values->'attachments','[]')) loop
   if not exists(select 1 from nl_recovery_attachments f where f.company_id=p_company and f.month=p_month and f.case_key=p_case and f.id::text=a->>'id') then raise exception 'Attachment is not linked to this case.'; end if;
  end loop;
  if p_action='submit' and p_values->>'decision'='dispute' then
   if length(trim(coalesce(p_values->>'reason','')))<2 then raise exception 'Choose the dispute reason.'; end if;
   if length(trim(coalesce(p_values->>'remarks','')))<10 then raise exception 'Explain the dispute for Amazon (at least 10 characters).'; end if;
  end if;
  next_status:=case when p_action='submit' then 'submitted' else 'draft' end;
  insert into nl_dispute_requests(company_id,month,case_key,decision,reason,remarks,cctv_url,attachments,status,source_stage,source_amount,version,created_by,created_by_name,updated_by,updated_by_name,submitted_at)
  values(p_company,p_month,p_case,p_values->>'decision',trim(coalesce(p_values->>'reason','')),trim(coalesce(p_values->>'remarks','')),nullif(trim(coalesce(p_values->>'cctv_url','')),''),
   coalesce(p_values->'attachments','[]'),next_status,c.details->'extra'->>'current_sla_stage',c.amount,p_version+1,p_actor,p_name,p_actor,p_name,case when p_action='submit' then now() end)
  on conflict(company_id,month,case_key) do update set decision=excluded.decision,reason=excluded.reason,remarks=excluded.remarks,cctv_url=excluded.cctv_url,
   attachments=excluded.attachments,status=excluded.status,source_stage=excluded.source_stage,source_amount=excluded.source_amount,version=excluded.version,
   updated_by=excluded.updated_by,updated_by_name=excluded.updated_by_name,submitted_at=excluded.submitted_at,filed_at=null,updated_at=now()
  returning * into saved;
 elsif p_action in ('return','file','withdraw') then
  if old.version is null then raise exception 'There is no dispute request for this case.'; end if;
  if p_action='withdraw' and old.status<>'submitted' then raise exception 'Only a submitted dispute can be withdrawn.'; end if;
  if p_action='return' and old.status not in ('submitted','filed') then raise exception 'Only a submitted dispute can be returned.'; end if;
  if p_action='file' and old.status<>'submitted' then raise exception 'Only a submitted dispute can be marked as filed.'; end if;
  if p_action='return' and length(trim(coalesce(p_values->>'desk_note','')))<5 then raise exception 'Tell the station what to correct (at least 5 characters).'; end if;
  if length(coalesce(p_values->>'desk_note',''))>2000 then raise exception 'Desk note is too long.'; end if;
  update nl_dispute_requests set status=case p_action when 'return' then 'returned' when 'file' then 'filed' else 'draft' end,
   desk_note=case when p_action='withdraw' then desk_note else trim(coalesce(p_values->>'desk_note','')) end,
   filed_at=case when p_action='file' then now() end,submitted_at=case when p_action='withdraw' then null else submitted_at end,
   version=version+1,updated_by=p_actor,updated_by_name=p_name,updated_at=now()
  where company_id=p_company and month=p_month and case_key=p_case returning * into saved;
 else
  raise exception 'Unknown dispute action.';
 end if;
 insert into nl_dispute_request_events(company_id,month,case_key,action,snapshot,actor_id,actor_name) values(p_company,p_month,p_case,p_action,to_jsonb(saved),p_actor,p_name);
 return to_jsonb(saved);
end $$;

revoke all on function public.nl_case_recoverable(uuid,text,text),public.slp_case_month(public.loss_cases),public.slp_current_cases(),public.slp_archive_cases(uuid),public.save_nl_dispute_request(uuid,text,text,int,text,jsonb,uuid,text) from public,anon,authenticated;
grant execute on function public.nl_case_recoverable(uuid,text,text),public.slp_case_month(public.loss_cases),public.slp_current_cases(),public.slp_archive_cases(uuid),public.save_nl_dispute_request(uuid,text,text,int,text,jsonb,uuid,text) to service_role;
commit;
