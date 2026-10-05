-- Retain the full previous row for duplicate reconciliation and later date changes.
create table if not exists public.fleet_audit_schedule_revisions (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 audit_id uuid not null,
 reason text not null,
 previous_row jsonb not null,
 recorded_at timestamptz not null default now()
);
alter table public.fleet_audit_schedule_revisions enable row level security;
revoke all on public.fleet_audit_schedule_revisions from anon, authenticated;
grant select,insert on public.fleet_audit_schedule_revisions to service_role;

-- Prefer evidence, then started work, then the earliest original slot.
create temporary table fleet_duplicate_audit_slots as
select id, first_value(id) over w as retained_id, row_number() over w as position
from public.fleet_audits a where status <> 'cancelled'
window w as (partition by company_id,vehicle_id,date_trunc('month',scheduled_for::timestamp),
 case when scheduled_reason ~* '^\[mode:video\]' then 'video' else 'physical' end
 order by (case when status in ('passed','failed') then 0 when draft <> '{}'::jsonb or exists(select 1 from public.fleet_audit_responses r where r.audit_id=a.id) or exists(select 1 from public.fleet_audit_evidence e where e.audit_id=a.id) then 1 when status='in_progress' then 2 else 3 end),created_at,id);
do $$ begin
 if exists(select 1 from fleet_duplicate_audit_slots d join public.fleet_audits a using(id) where d.position>1 and (a.status in ('passed','failed') or a.draft <> '{}'::jsonb or exists(select 1 from public.fleet_audit_responses r where r.audit_id=a.id) or exists(select 1 from public.fleet_audit_evidence e where e.audit_id=a.id))) then
 raise exception 'Duplicate audits contain saved work; reconcile their evidence before proceeding.';
 end if;
end $$;
insert into public.fleet_audit_schedule_revisions(company_id,audit_id,reason,previous_row)
select a.company_id,a.id,'Duplicate monthly slot; retained '||d.retained_id,to_jsonb(a) from public.fleet_audits a join fleet_duplicate_audit_slots d using(id) where d.position>1;
update public.fleet_audits a set status='cancelled',scheduled_reason=coalesce(a.scheduled_reason,'')||' [superseded:'||d.retained_id||']',updated_at=now()
from fleet_duplicate_audit_slots d where a.id=d.id and d.position>1;

drop table fleet_duplicate_audit_slots;

create unique index if not exists fleet_audit_one_active_monthly_mode
on public.fleet_audits(company_id,vehicle_id,date_trunc('month',scheduled_for::timestamp),
 (case when scheduled_reason ~* '^\[mode:video\]' then 'video' else 'physical' end))
where status <> 'cancelled';

create or replace function public.fleet_apply_audit_month_plan(p_company uuid,p_month date,p_expected jsonb,p_changes jsonb,p_template uuid,p_actor uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare change jsonb; existing public.fleet_audits%rowtype; n_created integer:=0; n_moved integer:=0; active_count integer;
begin
 if date_trunc('month',p_month::timestamp)::date<>p_month then raise exception 'Month must begin on day one'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_company::text||':'||p_month::text,0));
 perform 1 from public.fleet_audits where company_id=p_company and scheduled_for>=p_month and scheduled_for<(p_month+interval '1 month') and status<>'cancelled' for update;
 select count(*) into active_count from public.fleet_audits where company_id=p_company and scheduled_for>=p_month and scheduled_for<(p_month+interval '1 month') and status<>'cancelled';
 if active_count<>jsonb_array_length(p_expected) or exists(
 select 1 from jsonb_to_recordset(p_expected) as e(id uuid,status text,updated_at timestamptz)
 left join public.fleet_audits a on a.id=e.id and a.company_id=p_company and a.scheduled_for>=p_month and a.scheduled_for<(p_month+interval '1 month')
 where a.id is null or a.status is distinct from e.status or a.updated_at is distinct from e.updated_at) then
 raise exception 'Audit programme changed while planning. Refresh and rebuild.'; end if;
 if p_template is not null and not exists(select 1 from public.fleet_audit_templates where id=p_template and company_id=p_company) then raise exception 'Invalid template company'; end if;
 for change in select value from jsonb_array_elements(p_changes) loop
  if (change->>'scheduled_for')::date<p_month or (change->>'scheduled_for')::date>=(p_month+interval '1 month') then raise exception 'Audit date must stay within its month'; end if;
  if change->>'mode' not in ('physical','video') or not exists(select 1 from public.fleet_vehicles where id=(change->>'vehicle_id')::uuid and company_id=p_company) then raise exception 'Invalid vehicle or mode'; end if;
  if nullif(change->>'id','') is not null then
   select * into existing from public.fleet_audits where id=(change->>'id')::uuid and company_id=p_company for update;
   if existing.id is null or existing.status<>'scheduled' or existing.vehicle_id<>(change->>'vehicle_id')::uuid or not exists(select 1 from jsonb_to_recordset(p_expected) as e(id uuid) where e.id=existing.id) then raise exception 'Only unchanged, unstarted monthly audits can be moved'; end if;
   if existing.scheduled_for<>(change->>'scheduled_for')::date then
    insert into public.fleet_audit_schedule_revisions(company_id,audit_id,reason,previous_row) values(p_company,existing.id,'Monthly schedule balanced',to_jsonb(existing));
    update public.fleet_audits set scheduled_for=(change->>'scheduled_for')::date,updated_at=now() where id=existing.id;
    n_moved:=n_moved+1;
   end if;
  else
   insert into public.fleet_audits(company_id,vehicle_id,template_id,scheduled_for,scheduled_reason,status,assigned_to,created_by)
   values(p_company,(change->>'vehicle_id')::uuid,p_template,(change->>'scheduled_for')::date,'[mode:'||(change->>'mode')||'] Auto programme · monthly balanced schedule','scheduled',nullif(change->>'assigned_to','')::uuid,p_actor);
   n_created:=n_created+1;
  end if;
 end loop;
 return jsonb_build_object('created',n_created,'moved',n_moved);
end $$;
revoke all on function public.fleet_apply_audit_month_plan(uuid,date,jsonb,jsonb,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fleet_apply_audit_month_plan(uuid,date,jsonb,jsonb,uuid,uuid) to service_role;
