-- An audit and its rescheduling trail move together. Only the scoped server action
-- may call this function; direct browser roles have no execution privilege.
create or replace function public.reschedule_station_audit(
  p_company_id uuid, p_audit_id uuid, p_expected_date timestamptz,
  p_scheduled_for timestamptz, p_cycle_key text, p_period_slot text,
  p_reason text, p_actor_id uuid, p_actor_name text, p_actor_email text, p_actor_role text
) returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_audit public.ops_station_audits%rowtype;
  v_hours integer;
begin
  if p_scheduled_for is null or p_scheduled_for <= now() or coalesce(length(trim(p_reason)), 0) = 0 then
    raise exception 'Choose a future date and time and provide a reason.';
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
