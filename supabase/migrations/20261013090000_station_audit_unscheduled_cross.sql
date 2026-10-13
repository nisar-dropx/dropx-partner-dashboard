-- Unscheduled (surprise) audits, cross-station auditors, audit-type changes and
-- cross-station requests. Planned programme slots keep every existing rule.

-- An auditor assigned outside their own station scope reaches that one audit only.
alter table public.ops_station_audits add column if not exists cross_station boolean not null default false;

-- Roles that may create or assign an audit at any eligible station and approve
-- cross-station requests. Maintained in Audit Master; seeded once below.
alter table public.ops_audit_programme_settings add column if not exists cross_audit_role_ids uuid[] not null default '{}';
update public.ops_audit_programme_settings s
set cross_audit_role_ids = coalesce((
  select array_agg(r.id order by r.name) from public.user_roles r
  where r.company_id = s.company_id and r.product_code = 'operations' and r.is_active
    and r.code in ('OPERATIONS_BH', 'OPERATIONS_SLPM')), '{}'::uuid[])
where cardinality(s.cross_audit_role_ids) = 0;

create table if not exists public.ops_station_audit_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  location_id uuid not null references public.stations(id),
  audit_type_id uuid not null references public.ops_audit_types(id),
  requested_by uuid not null,
  requested_name text,
  preferred_date date,
  reason text not null check (length(trim(reason)) between 1 and 500),
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'cancelled')),
  decided_by uuid,
  decided_name text,
  decided_at timestamptz,
  decision_note text check (decision_note is null or length(decision_note) <= 500),
  audit_id uuid references public.ops_station_audits(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One open request per person, station and audit type.
create unique index if not exists ops_station_audit_requests_open
  on public.ops_station_audit_requests(company_id, requested_by, location_id, audit_type_id) where status = 'pending';
create index if not exists ops_station_audit_requests_queue
  on public.ops_station_audit_requests(company_id, status, created_at desc);
alter table public.ops_station_audit_requests enable row level security;
revoke all on table public.ops_station_audit_requests from public, anon, authenticated;
grant select, insert, update on table public.ops_station_audit_requests to service_role;

create index if not exists ops_station_audits_cross_auditor
  on public.ops_station_audits(company_id, assigned_to) where cross_station and deleted_at is null;

-- Date windows apply to planned programme audits only. An unscheduled audit sits
-- outside the programme: it needs no window and never blocks a planned slot.
create or replace function public.check_station_audit_window() returns trigger language plpgsql security invoker set search_path='' as $$
declare t public.ops_audit_types%rowtype; s jsonb; d date; old_d date; first_day integer; last_day integer;
begin
 if new.deleted_at is not null then return new; end if;
 if tg_op='UPDATE' then
  if old.deleted_at is not null then raise exception 'Deleted audit is read-only.'; end if;
  if new.scheduled_for is not distinct from old.scheduled_for and new.period_slot is not distinct from old.period_slot then return new; end if;
 end if;
 if new.schedule_source='unscheduled' then return new; end if;
 select * into t from public.ops_audit_types where id=new.audit_type_id and company_id=new.company_id;
 if t.cadence_unit<>'monthly' then return new; end if;
 d=(new.scheduled_for at time zone 'Asia/Kolkata')::date;
 select value into s from jsonb_array_elements(t.scheduling_config->'period_slots') where value->>'code'=new.period_slot;
 if s is null then raise exception 'Choose a valid audit window.'; end if;
 first_day=coalesce((s->>'start_day')::integer,1); last_day=coalesce((s->>'end_day')::integer,31);
 if extract(day from d)<first_day or extract(day from d)>last_day then raise exception 'Audit date must stay within its configured window.'; end if;
 if tg_op='UPDATE' then
  old_d=(old.scheduled_for at time zone 'Asia/Kolkata')::date;
  if date_trunc('month',old_d)<>date_trunc('month',d) then raise exception 'Reschedule within the same month.'; end if;
  if extract(day from old_d)<first_day or extract(day from old_d)>last_day then raise exception 'Keep this audit in its original date window.'; end if;
 end if;
 perform pg_advisory_xact_lock(hashtextextended(new.company_id::text || new.audit_type_id::text || new.location_id::text || to_char(d,'YYYY-MM'),0));
 if exists(select 1 from public.ops_station_audits a where a.company_id=new.company_id and a.audit_type_id=new.audit_type_id and a.location_id=new.location_id and a.id<>new.id and a.deleted_at is null
 and a.schedule_source<>'unscheduled'
 and date_trunc('month',a.scheduled_for at time zone 'Asia/Kolkata')=date_trunc('month',d)
 and extract(day from a.scheduled_for at time zone 'Asia/Kolkata') between first_day and last_day)
 then raise exception 'This station already has an audit in this date window. Open that audit to reschedule it.'; end if;
 return new;
end; $$;
revoke all on function public.check_station_audit_window() from public,anon,authenticated;

-- Change the audit type, the auditor, or both in one step with one history trail.
-- The caller decides who may do this; the function guards the audit's own state.
create or replace function public.change_station_audit(
 p_company_id uuid, p_audit_id uuid, p_expected_updated_at timestamptz,
 p_audit_type_id uuid, p_cycle_key text, p_period_slot text, p_schedule_source text,
 p_assigned_to uuid, p_cross_station boolean, p_reason text,
 p_actor_id uuid, p_actor_name text, p_actor_email text, p_actor_role text)
returns void language plpgsql security invoker set search_path='' as $$
declare v public.ops_station_audits%rowtype; t public.ops_audit_types%rowtype; old_type public.ops_audit_types%rowtype; target public.profiles%rowtype;
 type_changed boolean; auditor_changed boolean;
begin
 select * into v from public.ops_station_audits where id=p_audit_id and company_id=p_company_id and deleted_at is null for update;
 if not found then raise exception 'Audit unavailable.'; end if;
 if v.updated_at is distinct from p_expected_updated_at then raise exception 'This audit changed. Refresh and try again.'; end if;
 if coalesce(length(trim(p_reason)),0)=0 or length(p_reason)>500 then raise exception 'Enter a reason up to 500 characters.'; end if;
 if v.completed_at is not null or v.status_code not in ('scheduled','in_progress') then raise exception 'Only an audit that has not been submitted can be changed.'; end if;
 type_changed = p_audit_type_id is distinct from v.audit_type_id;
 auditor_changed = p_assigned_to is distinct from v.assigned_to or v.assignment_verified is not true;
 if not type_changed and not auditor_changed then raise exception 'Choose a different audit type or auditor.'; end if;
 if auditor_changed and (v.started_at is not null or v.status_code<>'scheduled') then raise exception 'Only an unstarted audit can be reassigned.'; end if;
 select * into target from public.profiles where id=p_assigned_to and company_id=p_company_id and is_active;
 if not found then raise exception 'Choose an active auditor.'; end if;
 if type_changed then
  select * into t from public.ops_audit_types where id=p_audit_type_id and company_id=p_company_id and is_active;
  if not found then raise exception 'Choose an active audit type from Audit Master.'; end if;
  if p_schedule_source not in ('manual','unscheduled') or coalesce(length(trim(p_cycle_key)),0)=0 or coalesce(length(trim(p_period_slot)),0)=0 then raise exception 'Invalid audit plan.'; end if;
  select * into old_type from public.ops_audit_types where id=v.audit_type_id;
  -- Photos taken for the old checklist stay on the audit as general proof.
  update public.ops_station_audit_evidence set checklist_item_id=null, evidence_kind_code='document'
   where company_id=p_company_id and audit_id=v.id and checklist_item_id is not null;
  update public.ops_station_audits set audit_type_id=t.id, cycle_key=p_cycle_key, period_slot=p_period_slot,
   schedule_source=case when v.schedule_source='unscheduled' then 'unscheduled' else p_schedule_source end,
   response_due_at=v.scheduled_for + make_interval(hours => t.default_response_hours), updated_at=now() where id=v.id;
  insert into public.ops_station_audit_events(company_id,audit_id,event_type,before_data,after_data,actor_user_id,actor_name,actor_email,actor_role)
  values(p_company_id,v.id,'type_changed',
   jsonb_build_object('audit_type_id',v.audit_type_id,'type_name',old_type.name,'period_slot',v.period_slot,'schedule_source',v.schedule_source),
   jsonb_build_object('audit_type_id',t.id,'type_name',t.name,'period_slot',p_period_slot,'schedule_source',case when v.schedule_source='unscheduled' then 'unscheduled' else p_schedule_source end,'reason',trim(p_reason)),
   p_actor_id,p_actor_name,p_actor_email,p_actor_role);
 end if;
 if auditor_changed then
  update public.ops_station_audits set assigned_to=target.id,assigned_name=target.full_name,assigned_email=target.email,assignment_verified=true,
   cross_station=coalesce(p_cross_station,false),updated_at=now() where id=v.id;
  insert into public.ops_station_audit_events(company_id,audit_id,event_type,before_data,after_data,actor_user_id,actor_name,actor_email,actor_role)
  values(p_company_id,v.id,'reassigned',
   jsonb_build_object('assigned_to',v.assigned_to,'assigned_name',v.assigned_name,'status_code',v.status_code),
   jsonb_build_object('reason',trim(p_reason),'assigned_to',target.id,'assigned_name',target.full_name,'cross_station',coalesce(p_cross_station,false)),
   p_actor_id,p_actor_name,p_actor_email,p_actor_role);
 end if;
end; $$;
revoke all on function public.change_station_audit(uuid,uuid,timestamptz,uuid,text,text,text,uuid,boolean,text,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.change_station_audit(uuid,uuid,timestamptz,uuid,text,text,text,uuid,boolean,text,uuid,text,text,text) to service_role;
