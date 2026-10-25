begin;
-- Existing history stays intact. New non-recovery shortcuts are refused in every entry point.
insert into public.nl_recovery_outcomes(company_id,code,label,allocation_required,remarks_required,sort_order,deduction_timing)
select distinct company_id,'responsible_left','Person left · recovery outstanding',false,true,20,'none' from public.nl_loss_sources
on conflict(company_id,code) do nothing;

create or replace function public.nl_recovery_control_guard() returns trigger language plpgsql set search_path=public as $$
declare o public.nl_recovery_outcomes; c public.nl_loss_month_cases;
begin
 if new.is_deleted then return new; end if;
 select * into c from nl_loss_month_cases where company_id=new.company_id and month=new.month and case_key=new.case_key;
 if c.report='nl' and coalesce(c.details->>'case_status','') not in ('resolved','sla_missed','not_disputed')
    and c.details->'extra'->>'current_sla_stage' in ('eDSP1','eDSP2','NL1','NL2') then
   raise exception 'This case is still in Initial. Recovery requires a final source outcome.';
 end if;
 select * into o from nl_recovery_outcomes where company_id=new.company_id and code=new.outcome_code;
 if o.dispute_fields_enabled or not (o.allocation_required or o.code in ('already_recovered','responsible_left')) then
   raise exception 'Choose a recovery plan. Redisputes require case-specific activation in Case response.';
 end if;
 if o.code='responsible_left' and (
   length(trim(coalesce(new.recovery_details->>'employee_id','')))<2 or
   length(trim(coalesce(new.recovery_details->>'employee_name','')))<2 or
   length(trim(coalesce(new.recovery_details->>'follow_up','')))<10 or length(trim(new.remarks))<5
 ) then raise exception 'Employee ID, name, departure details and recovery follow-up are required. The balance remains outstanding.'; end if;
 return new;
end $$;
drop trigger if exists nl_recovery_control_guard on public.nl_loss_recoveries;
create trigger nl_recovery_control_guard before insert or update of outcome_code,recovery_details,remarks on public.nl_loss_recoveries
for each row execute function public.nl_recovery_control_guard();

-- Preserve all existing payroll rules; a departed person is an outstanding exit balance, never a waiver.
do $$ declare f record; definition text; begin
 for f in select oid from pg_proc where pronamespace='public'::regnamespace and proname='save_nl_recovery' loop
   definition:=pg_get_functiondef(f.oid);
   if position('when o.code = ''responsible_left''' in definition)=0 and position('when o.code = ''already_recovered'' then ''recovered''' in definition)>0 then
     definition:=replace(definition,'when o.code = ''already_recovered'' then ''recovered''',
       'when o.code = ''responsible_left'' then ''exit_balance'' when o.code = ''already_recovered'' then ''recovered''');
   end if;
   definition:=regexp_replace(definition,'else[[:space:]]+p_details[[:space:]]*:=[[:space:]]*''\{\}'';','elsif o.code <> ''responsible_left'' then p_details:=''{}'';','g');
   if position('when o.code = ''responsible_left''' in definition)>0 and position('elsif o.code <> ''responsible_left''' in definition)=0 then
     raise exception 'Recovery details patch could not be verified';
   end if;
   execute definition;
 end loop;
end $$;

create table if not exists public.nl_case_response_windows (
 company_id uuid not null, month text not null, case_key text not null,
 enabled boolean not null default false, version integer not null default 0,
 updated_at timestamptz not null default now(), updated_by uuid, updated_by_name text,
 primary key(company_id,month,case_key),
 foreign key(company_id,month,case_key) references public.nl_loss_month_cases(company_id,month,case_key)
);
create table if not exists public.nl_case_response_events (
 id uuid primary key default gen_random_uuid(), company_id uuid not null, month text not null, case_key text not null,
 action text not null check(action in ('activate','revoke','response','vendor_response')),
 note text not null, evidence_url text, public_confirmed boolean not null default false,
 actor_id uuid not null, actor_name text not null, created_at timestamptz not null default now(),
 foreign key(company_id,month,case_key) references public.nl_case_response_windows(company_id,month,case_key)
);
create index if not exists nl_case_response_history on public.nl_case_response_events(company_id,month,case_key,created_at);
alter table public.nl_case_response_windows enable row level security;
alter table public.nl_case_response_events enable row level security;
revoke all on public.nl_case_response_windows,public.nl_case_response_events from anon,authenticated,service_role;
grant select on public.nl_case_response_windows,public.nl_case_response_events to service_role;

-- Only the authenticated, scoped server route may invoke this function. Events are append-only.
create or replace function public.nl_case_response_transition(
 p_company uuid,p_month text,p_case text,p_version integer,p_action text,p_note text,
 p_url text,p_public boolean,p_actor uuid,p_name text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare w nl_case_response_windows;
begin
 if p_actor is null or length(trim(coalesce(p_name,'')))=0 then raise exception 'An authenticated actor is required.'; end if;
 if p_action not in ('activate','revoke','response','vendor_response') then raise exception 'Unknown response action.'; end if;
 if length(trim(coalesce(p_note,'')))<10 or length(p_note)>4000 then raise exception 'Provide clear details (10–4000 characters).'; end if;
 if coalesce(p_url,'')<>'' and (p_url !~ '^https://' or length(p_url)>2000 or not coalesce(p_public,false)) then
   raise exception 'Use an HTTPS evidence link and confirm anyone with the link can view.';
 end if;
 insert into nl_case_response_windows(company_id,month,case_key) values(p_company,p_month,p_case) on conflict do nothing;
 select * into strict w from nl_case_response_windows where company_id=p_company and month=p_month and case_key=p_case for update;
 if w.version<>p_version then raise exception 'This case changed. Reload before continuing.'; end if;
 if p_action='response' and not w.enabled then raise exception 'Redispute is not activated for this TID.'; end if;
 update nl_case_response_windows set enabled=case when p_action='activate' then true when p_action='revoke' then false else enabled end,
   version=version+1,updated_at=now(),updated_by=p_actor,updated_by_name=p_name
 where company_id=p_company and month=p_month and case_key=p_case returning * into w;
 insert into nl_case_response_events(company_id,month,case_key,action,note,evidence_url,public_confirmed,actor_id,actor_name)
 values(p_company,p_month,p_case,p_action,trim(p_note),nullif(p_url,''),coalesce(p_public,false),p_actor,p_name);
 return to_jsonb(w);
end $$;
revoke all on function public.nl_case_response_transition(uuid,text,text,integer,text,text,text,boolean,uuid,text) from public,anon,authenticated;
grant execute on function public.nl_case_response_transition(uuid,text,text,integer,text,text,text,boolean,uuid,text) to service_role;
commit;
