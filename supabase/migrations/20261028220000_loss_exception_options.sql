begin;
create table if not exists public.nl_loss_exception_options (
 company_id uuid not null, month text not null, case_key text not null,
 kind text not null check(kind in ('next_month','installments')),
 enabled boolean not null default false, version integer not null default 0,
 deduction_month text, source_amount numeric, source_status text,
 reason text not null, updated_by uuid not null, updated_by_name text not null,
 updated_at timestamptz not null default now(), primary key(company_id,month,case_key,kind)
);
create table if not exists public.nl_loss_exception_events (
 id uuid primary key default gen_random_uuid(), company_id uuid not null, month text not null,
 case_key text not null, kind text not null, before_value jsonb, after_value jsonb not null,
 actor_id uuid not null, actor_name text not null, created_at timestamptz not null default now()
);
alter table public.nl_loss_exception_options enable row level security;
alter table public.nl_loss_exception_events enable row level security;
revoke all on public.nl_loss_exception_options, public.nl_loss_exception_events from public,anon,authenticated;
grant select,insert,update on public.nl_loss_exception_options to service_role;
grant select,insert on public.nl_loss_exception_events to service_role;

create or replace function public.nl_loss_exception_set(p_company uuid,p_month text,p_case text,p_kind text,p_enabled boolean,p_version integer,p_reason text,p_actor uuid,p_name text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare c nl_loss_month_cases; old nl_loss_exception_options; saved nl_loss_exception_options; policy jsonb; target text;
begin
 if p_actor is null or nullif(trim(p_name),'') is null then raise exception 'Actor is required'; end if;
 if p_kind not in ('next_month','installments') or p_kind is null or p_enabled is null or p_version is null or p_version<0
   or length(trim(coalesce(p_reason,'')))<10 or length(p_reason)>2000 then raise exception 'Choose an exception and provide a reason (10–2000 characters).'; end if;
 perform pg_advisory_xact_lock(hashtextextended('nl-recovery:'||p_company::text,0));
 select * into c from nl_loss_month_cases where company_id=p_company and month=p_month and case_key=p_case for update;
 if c.case_key is null then raise exception 'Case is unavailable'; end if;
 if p_enabled and (not c.source_present or not nl_case_recoverable(p_company,c.report,c.source_status)
   or (c.report='slp' and c.final_seen_at is null)
   or (c.report='nl' and upper(coalesce(c.details->'extra'->>'current_sla_stage','')) in ('EDSP1','EDSP2','NL1','NL2')
      and lower(coalesce(c.details->>'case_status','')) not in ('resolved','sla_missed','not_disputed'))) then
   raise exception 'Exceptions are available only for final recoverable cases.';
 end if;
 select recovery_policy into policy from nl_loss_sources where company_id=p_company;
 if p_enabled and p_kind='next_month' then
   target:=nl_recovery_deduction_month(c.report,c.month,now(),c.final_seen_at,'next_month',coalesce((policy->>'payroll_cutoff_day')::int,5));
 end if;
 select * into old from nl_loss_exception_options where company_id=p_company and month=p_month and case_key=p_case and kind=p_kind for update;
 if coalesce(old.version,0)<>p_version then raise exception 'Exception changed. Reload before saving.'; end if;
 insert into nl_loss_exception_options(company_id,month,case_key,kind,enabled,version,deduction_month,source_amount,source_status,reason,updated_by,updated_by_name)
 values(p_company,p_month,p_case,p_kind,p_enabled,p_version+1,target,c.amount,c.source_status,trim(p_reason),p_actor,p_name)
 on conflict(company_id,month,case_key,kind) do update set enabled=excluded.enabled,version=excluded.version,deduction_month=excluded.deduction_month,
 source_amount=excluded.source_amount,source_status=excluded.source_status,reason=excluded.reason,updated_by=excluded.updated_by,updated_by_name=excluded.updated_by_name,updated_at=now()
 returning * into saved;
 insert into nl_loss_exception_events(company_id,month,case_key,kind,before_value,after_value,actor_id,actor_name)
 values(p_company,p_month,p_case,p_kind,case when old.version is null then null else to_jsonb(old) end,to_jsonb(saved),p_actor,p_name);
 return to_jsonb(saved);
end $$;
revoke all on function public.nl_loss_exception_set(uuid,text,text,text,boolean,integer,text,uuid,text) from public,anon,authenticated;
grant execute on function public.nl_loss_exception_set(uuid,text,text,text,boolean,integer,text,uuid,text) to service_role;

create or replace function public.nl_loss_exception_allowed(p_company uuid,p_month text,p_case text,p_kind text,p_payroll text)
returns boolean language sql stable security invoker set search_path=public as $$
 select exists(select 1 from nl_loss_exception_options g join nl_loss_month_cases c using(company_id,month,case_key)
 where g.company_id=p_company and g.month=p_month and g.case_key=p_case and g.kind=p_kind and g.enabled
 and g.source_amount=c.amount and g.source_status is not distinct from c.source_status
 and (p_kind='installments' or g.deduction_month=p_payroll))
$$;
revoke all on function public.nl_loss_exception_allowed(uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.nl_loss_exception_allowed(uuid,text,text,text,text) to service_role;

-- Enforce entitlements inside the same transaction and company lock as the canonical writer.
-- Existing approved schedules remain intact; revocation prevents new or changed schedules.
do $$ declare f record; d text; prefix text; replacement text; found boolean:=false; begin
 for f in select oid from pg_proc where pronamespace='public'::regnamespace and proname='save_nl_recovery' loop
  d:=pg_get_functiondef(f.oid);
  if position('-- Explicit exception options' in d)>0 then found:=true; continue; end if;
  if position('-- Exception-only recovery approval' in d)=0 or position('-- Explicit payroll month' in d)=0 then continue; end if;
  d:=replace(d,'-- Exception-only recovery approval',$patch$-- Explicit exception options
  if o.allocation_required and not (same_plan and old.approval_status='approved') then
   if v_mode='installments' and not nl_loss_exception_allowed(p_company,p_month,p_case,'installments',deduction) then
    raise exception 'Recurring debit must first be enabled for this TID in Exceptions.';
   end if;
   if deduction <> greatest(nl_recovery_deduction_month(c.report,c.month,now(),c.final_seen_at,'current_month',coalesce((policy->>'payroll_cutoff_day')::int,5)),
       coalesce((select w.recovery_month from nl_case_response_windows w where w.company_id=p_company and w.month=p_month and w.case_key=p_case),''))
      and not nl_loss_exception_allowed(p_company,p_month,p_case,'next_month',deduction) then
    raise exception 'Deduct next month must first be enabled for this TID in Exceptions. Use the enabled payroll month.';
   end if;
  end if;
  -- Exception-only recovery approval$patch$);
  prefix:=$p$o.allocation_required and o.deduction_timing='current_month'
     and deduction=nl_recovery_deduction_month(c.report,c.month,now(),c.final_seen_at,'current_month',coalesce((policy->>'payroll_cutoff_day')::int,5)) and v_mode='full' and not v_override$p$;
  replacement:=$p$o.allocation_required
     and (same_plan and old.approval_status='approved' or deduction=greatest(nl_recovery_deduction_month(c.report,c.month,now(),c.final_seen_at,'current_month',coalesce((policy->>'payroll_cutoff_day')::int,5)),coalesce((select w.recovery_month from nl_case_response_windows w where w.company_id=p_company and w.month=p_month and w.case_key=p_case),'')) or nl_loss_exception_allowed(p_company,p_month,p_case,'next_month',deduction))
     and (v_mode='full' or same_plan and old.approval_status='approved' or nl_loss_exception_allowed(p_company,p_month,p_case,'installments',deduction)) and not v_override$p$;
  d:=regexp_replace(d,'o.allocation_required and o.deduction_timing=''current_month''[[:space:]]+and deduction=[^\n]+and v_mode=''full'' and not v_override',replacement);
  if position(replacement in d)=0 then raise exception 'Exception approval routing did not match the current writer'; end if;
  d:=replace(d,'Automatic · full recovery','Automatic · permitted recovery');
  d:=replace(d,'Full recovery in the applicable payroll; no exception approval required.','Recovery within enabled options; no further approval required.');
  execute d; found:=true;
 end loop;
 if not found then raise exception 'Current recovery writer is required'; end if;
end $$;
commit;
