begin;
-- Preserve source changes independently of import refreshes and workflow events.
create table if not exists public.nl_loss_source_events (
 id uuid primary key default gen_random_uuid(), company_id uuid not null, month text not null,
 case_key text not null, action text not null, before_value jsonb, after_value jsonb not null,
 actor_name text not null, created_at timestamptz not null default now()
);
create index if not exists nl_loss_source_events_case on public.nl_loss_source_events(company_id,month,case_key,created_at,id);
alter table public.nl_loss_source_events enable row level security;
revoke all on public.nl_loss_source_events from public,anon,authenticated;
grant select,insert on public.nl_loss_source_events to service_role;
create or replace function public.nl_loss_source_history_immutable() returns trigger language plpgsql set search_path=public as $$
begin raise exception 'PID source history cannot be changed.'; end $$;
drop trigger if exists nl_loss_source_history_immutable on public.nl_loss_source_events;
create trigger nl_loss_source_history_immutable before update or delete on public.nl_loss_source_events for each row execute function public.nl_loss_source_history_immutable();
create or replace function public.nl_loss_source_snapshot(r jsonb) returns jsonb language sql immutable set search_path=public as $$
 select jsonb_build_object('station_code',r->'station_code','amount',r->'amount','source_status',r->'source_status',
 'details',r->'details','source_present',r->'source_present','source_file',r->'source_file','report',r->'report','data_source',r->'data_source','final_seen_at',r->'final_seen_at')
$$;
create or replace function public.nl_loss_record_source_history() returns trigger language plpgsql security definer set search_path=public as $$
declare previous jsonb; current_value jsonb; identity_row jsonb;
begin
 if tg_op<>'INSERT' then previous:=nl_loss_source_snapshot(to_jsonb(old)); end if;
 if tg_op='DELETE' then identity_row:=to_jsonb(old); current_value:='{}'::jsonb;
 else identity_row:=to_jsonb(new); current_value:=nl_loss_source_snapshot(identity_row); end if;
 if previous is distinct from current_value then
  insert into nl_loss_source_events(company_id,month,case_key,action,before_value,after_value,actor_name)
  values((identity_row->>'company_id')::uuid,identity_row->>'month',identity_row->>'case_key',
   case tg_op when 'INSERT' then 'Source imported' when 'DELETE' then 'Source removed' else 'Source updated' end,
   previous,current_value,'Source sync · '||coalesce(nullif(identity_row->>'report',''),'NL')||' (source editor not supplied)');
 end if;
 return null;
end $$;
drop trigger if exists nl_loss_record_source_history on public.nl_loss_month_cases;
create trigger nl_loss_record_source_history after insert or update or delete on public.nl_loss_month_cases for each row execute function public.nl_loss_record_source_history();
-- A labelled baseline is not invented historical activity. Re-running never adds another baseline.
insert into public.nl_loss_source_events(company_id,month,case_key,action,after_value,actor_name)
select c.company_id,c.month,c.case_key,'Source baseline',nl_loss_source_snapshot(to_jsonb(c)),'System · history tracking started'
from public.nl_loss_month_cases c where not exists(select 1 from public.nl_loss_source_events e where e.company_id=c.company_id and e.month=c.month and e.case_key=c.case_key);

-- Editing a plan during an active redispute must not restart payroll. The due/ledger gates stay intact.
do $$ declare d text; begin
 select pg_get_functiondef(oid) into strict d from pg_proc where pronamespace='public'::regnamespace and proname='save_nl_recovery';
 if position('-- PID editable recovery plan' in d)=0 then
  if position('(rw.enabled or rw.workflow_status=''won'')' in d)=0 then raise exception 'Expected redispute plan guard missing'; end if;
  d:=replace(d,'(rw.enabled or rw.workflow_status=''won'')','(rw.workflow_status=''won'')');
  d:=replace(d,'-- Redispute plan gate','-- Redispute plan gate / -- PID editable recovery plan');
  d:=replace(d,'Recovery is paused or stopped by redispute. Use the redispute desk for this shipment.','A won redispute stops recovery. Review its outcome before changing the plan.');
  execute d;
 end if;
 -- Revocation must remain possible after the imported outcome or source availability changes.
 select pg_get_functiondef(oid) into strict d from pg_proc where pronamespace='public'::regnamespace and proname='nl_redispute_transition';
 if position('-- PID revoke after source change' in d)=0 then
  if position('if not nl_case_recoverable' in d)=0 then raise exception 'Expected redispute source guard missing'; end if;
  d:=replace(d,'if not nl_case_recoverable(p_company,c.report,c.source_status) or (c.report=''slp'' and c.final_seen_at is null) then',
   E'-- PID revoke after source change\n if p_action<>''revoke'' and (not nl_case_recoverable(p_company,c.report,c.source_status) or (c.report=''slp'' and c.final_seen_at is null)) then');
  execute d;
 end if;
end $$;
commit;
