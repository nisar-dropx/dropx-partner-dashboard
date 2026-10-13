-- A scheduled audit may be pulled forward, or dated up to 31 days back for a
-- surprise visit that has already happened. Postponing keeps its existing rules.
-- Apply after 20261013090000_station_audit_unscheduled_cross.sql.

create or replace function public.reschedule_station_audit(
  p_company_id uuid, p_audit_id uuid, p_expected_date timestamptz,
  p_scheduled_for timestamptz, p_cycle_key text, p_period_slot text,
  p_reason text, p_actor_id uuid, p_actor_name text, p_actor_email text, p_actor_role text
) returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_audit public.ops_station_audits%rowtype;
  v_hours integer;
begin
  if p_scheduled_for is null or p_scheduled_for < now() - interval '32 days' or coalesce(length(trim(p_reason)), 0) = 0 then
    raise exception 'Choose a date no more than 31 days back and provide a reason.';
  end if;
  select * into v_audit from public.ops_station_audits
    where company_id = p_company_id and id = p_audit_id for update;
  if not found then raise exception 'Audit unavailable.'; end if;
  if v_audit.status_code <> 'scheduled' or v_audit.started_at is not null or v_audit.completed_at is not null then
    raise exception 'Only an audit that has not started can be rescheduled.';
  end if;
  if v_audit.scheduled_for is distinct from p_expected_date then
    raise exception 'This audit was changed by another user. Refresh and try again.';
  end if;
  select default_response_hours into v_hours from public.ops_audit_types where id = v_audit.audit_type_id and company_id = p_company_id;
  update public.ops_station_audits set scheduled_for = p_scheduled_for, cycle_key = p_cycle_key, period_slot = p_period_slot,
    response_due_at = p_scheduled_for + make_interval(hours => coalesce(v_hours, 24)), updated_at = now()
    where company_id = p_company_id and id = p_audit_id;
  insert into public.ops_station_audit_events (company_id, audit_id, event_type, before_data, after_data, actor_user_id, actor_name, actor_email, actor_role)
    values (p_company_id, p_audit_id, 'rescheduled',
      jsonb_build_object('scheduled_for', v_audit.scheduled_for, 'cycle_key', v_audit.cycle_key, 'period_slot', v_audit.period_slot),
      jsonb_build_object('scheduled_for', p_scheduled_for, 'cycle_key', p_cycle_key, 'period_slot', p_period_slot, 'reason', trim(p_reason)),
      p_actor_id, p_actor_name, p_actor_email, p_actor_role);
end;
$$;
revoke all on function public.reschedule_station_audit(uuid,uuid,timestamptz,timestamptz,text,text,text,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.reschedule_station_audit(uuid,uuid,timestamptz,timestamptz,text,text,text,uuid,text,text,text) to service_role;

-- Moving a planned audit earlier may take it into an earlier window or month, as
-- long as that window is free. Moving it later still stays inside its own window.
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
  if d>=old_d then
   if date_trunc('month',old_d)<>date_trunc('month',d) then raise exception 'Reschedule within the same month.'; end if;
   if extract(day from old_d)<first_day or extract(day from old_d)>last_day then raise exception 'Keep this audit in its original date window.'; end if;
  end if;
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
