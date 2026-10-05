begin;
-- Timing belongs to editable outcomes in Master; every employee deduction requires full allocation.
alter table public.nl_recovery_outcomes add column deduction_timing text not null default 'none';
update public.nl_recovery_outcomes set deduction_timing='current_month', updated_at=now() where allocation_required;
alter table public.nl_recovery_outcomes add constraint nl_outcome_deduction_policy check (
 deduction_timing in ('none','current_month','next_month')
 and allocation_required=(deduction_timing<>'none')
 and (deduction_timing<>'next_month' or remarks_required)
);
insert into public.nl_recovery_outcomes(company_id,code,label,allocation_required,remarks_required,sort_order,deduction_timing)
select id,'deduct_next_month','Deduct next month',true,true,15,'next_month' from public.companies
on conflict(company_id,code) do nothing;
alter table public.nl_loss_recoveries add column deduction_timing text not null default 'none';
alter table public.nl_loss_recoveries add column deduction_month text;
-- Existing plans keep their original creation-month timing; historical event snapshots remain untouched.
update public.nl_loss_recoveries set deduction_timing='current_month',
 deduction_month=to_char(updated_at at time zone 'Asia/Kolkata','YYYY-MM') where jsonb_array_length(allocations)>0;
alter table public.nl_loss_recoveries add constraint nl_recovery_deduction_period check (
 deduction_timing in ('none','current_month','next_month') and
 ((deduction_timing='none' and deduction_month is null) or
 (deduction_timing<>'none' and deduction_month is not null and deduction_month ~ '^\d{4}-(0[1-9]|1[0-2])$'))
);

alter table public.nl_loss_sources add column recovery_policy jsonb not null default '{"active_only":true,"previous_month_active_only":true,"salary_cap_enabled":true,"salary_month_offset":1,"salary_cap_percent":100,"reserve_other_recoveries":true,"people_run_statuses":["calculated","reviewed","approved","locked","published"],"people_calculation_statuses":["ready"],"workforce_payout_statuses":["Ready for review"],"eligible_designations":[],"attachment_types":["image/jpeg","image/png","image/webp","application/pdf"],"attachment_max_count":5,"attachment_max_mb":10,"cctv_public_confirmation":true}';
update public.nl_loss_sources set include_inactive_people=false,updated_at=now();
alter table public.nl_recovery_outcomes add column dispute_fields_enabled boolean not null default false;
alter table public.nl_recovery_outcomes add column reason_required boolean not null default false;
alter table public.nl_recovery_outcomes add column details_required boolean not null default false;
alter table public.nl_recovery_outcomes add column attachments_enabled boolean not null default false;
alter table public.nl_recovery_outcomes add column cctv_enabled boolean not null default false;
update public.nl_recovery_outcomes set label='Re-dispute',remarks_required=false,dispute_fields_enabled=true,reason_required=true,details_required=true,attachments_enabled=true,cctv_enabled=true,updated_at=now() where code='post_dispute';
alter table public.nl_loss_recoveries add column recovery_details jsonb not null default '{}';
create table public.nl_recovery_payables (
 company_id uuid not null references companies(id), employee_ref text not null, salary_month text not null,
 eligible boolean not null, payable numeric(14,2), source text not null, checked_at timestamptz not null default now(), policy_updated_at timestamptz not null,
 primary key(company_id,employee_ref,salary_month)
);
create table public.nl_recovery_attachments (
 id uuid primary key default gen_random_uuid(),company_id uuid not null,month text not null,case_key text not null,
 file_name text not null,storage_bucket text not null,storage_path text not null,content_type text,file_size bigint,
 created_by uuid not null,created_at timestamptz not null default now(),
 foreign key(company_id,month,case_key) references nl_loss_month_cases(company_id,month,case_key)
);
alter table public.nl_recovery_payables enable row level security;
alter table public.nl_recovery_attachments enable row level security;
revoke all on public.nl_recovery_payables,public.nl_recovery_attachments from anon,authenticated;
grant all on public.nl_recovery_payables,public.nl_recovery_attachments to service_role;
drop function public.save_nl_recovery(uuid,text,text,int,text,text,jsonb,text,uuid,text);
create or replace function public.save_nl_recovery(p_company uuid,p_month text,p_case text,p_version int,p_outcome text,p_mode text,p_allocations jsonb,p_remarks text,p_actor uuid,p_name text,p_details jsonb default '{}')
returns jsonb language plpgsql security invoker set search_path=public as $$
declare c nl_loss_month_cases; o nl_recovery_outcomes; old nl_loss_recoveries; saved nl_loss_recoveries; a jsonb; people jsonb:='[]'; person jsonb; station uuid; total bigint:=0; expected bigint; n int; i int:=0; amt bigint; deduction text; policy jsonb; settings_updated timestamptz; pay nl_recovery_payables; pay_month text; reserved numeric; cap numeric; attachment jsonb;
begin
 -- Serialize plans across cases so two submissions cannot consume the same salary capacity.
 perform pg_advisory_xact_lock(hashtextextended('nl-recovery:'||p_company::text,0));
 select recovery_policy,updated_at into policy,settings_updated from nl_loss_sources where company_id=p_company;
 pay_month:=to_char(date_trunc('month',now() at time zone 'Asia/Kolkata')-make_interval(months=>(policy->>'salary_month_offset')::int),'YYYY-MM');
 select * into c from nl_loss_month_cases where company_id=p_company and month=p_month and case_key=p_case for update;
 if not found or not c.source_present or not nl_is_recoverable(p_company,c.source_status) then raise exception 'This case is no longer recoverable in Cloak. Refresh the list.'; end if;
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
revoke all on function public.save_nl_recovery(uuid,text,text,int,text,text,jsonb,text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.save_nl_recovery(uuid,text,text,int,text,text,jsonb,text,uuid,text,jsonb) to service_role;
commit;
