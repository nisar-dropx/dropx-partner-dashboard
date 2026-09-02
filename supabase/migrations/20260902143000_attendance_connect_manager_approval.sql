begin;

-- Allow DropX One managers to act on attendance steps when their linked person_id
-- matches the assigned approver, even if the stored approver_user_id was refreshed
-- after a connect-only login was provisioned.
create or replace function public.hr_decide_attendance_regularization_step(
  p_company_id uuid,
  p_request_id uuid,
  p_actor_user_id uuid,
  p_decision text,
  p_note text
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_step public.attendance_regularization_approval_steps%rowtype;
  v_actor_person_id uuid;
  v_subject_person_id uuid;
  v_next_step_id uuid;
  v_next_approver_user_id uuid;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'Decision must be approved or rejected.';
  end if;

  select person_id into v_actor_person_id
  from public.hr_user_person_links
  where company_id = p_company_id and user_id = p_actor_user_id and status = 'active';

  select * into v_current_step
  from public.attendance_regularization_approval_steps
  where company_id = p_company_id
    and request_id = p_request_id
    and status = 'pending'
    and (
      approver_user_id = p_actor_user_id
      or (v_actor_person_id is not null and approver_person_id = v_actor_person_id)
    )
  order by step_order
  limit 1
  for update;
  if v_current_step.id is null then
    raise exception 'This request is not assigned to you or is no longer pending.';
  end if;

  if v_current_step.approver_user_id is distinct from p_actor_user_id then
    update public.attendance_regularization_approval_steps
    set approver_user_id = p_actor_user_id,
        updated_at = now()
    where id = v_current_step.id;
    v_current_step.approver_user_id := p_actor_user_id;
  end if;

  select engagement.person_id into v_subject_person_id
  from public.attendance_regularization_requests request
  join public.hr_engagements engagement
    on engagement.company_id = request.company_id
   and (
     (request.profile_type = 'employee' and engagement.employee_id = request.profile_id)
     or (request.profile_type = 'contractor' and engagement.contractor_id = request.profile_id)
   )
  where request.company_id = p_company_id and request.id = p_request_id
  order by engagement.start_date desc
  limit 1;
  if v_actor_person_id is not null and v_actor_person_id = v_subject_person_id then
    raise exception 'Self-approval is not allowed.';
  end if;

  update public.attendance_regularization_approval_steps
  set status = p_decision,
      decision_note = nullif(btrim(p_note), ''),
      decided_at = now(),
      updated_at = now()
  where id = v_current_step.id;

  if p_decision = 'rejected' then
    update public.attendance_regularization_requests
    set status = 'rejected', review_remarks = nullif(btrim(p_note), ''),
        reviewed_by = p_actor_user_id, reviewed_at = now(), updated_at = now()
    where company_id = p_company_id and id = p_request_id and status = 'pending_manager';
    update public.attendance_regularization_approval_steps
    set status = 'skipped', updated_at = now()
    where company_id = p_company_id and request_id = p_request_id and status = 'queued';
    return 'rejected';
  end if;

  select id, approver_user_id into v_next_step_id, v_next_approver_user_id
  from public.attendance_regularization_approval_steps
  where company_id = p_company_id and request_id = p_request_id and status = 'queued'
  order by step_order
  limit 1
  for update;
  if v_next_step_id is not null then
    update public.attendance_regularization_approval_steps
    set status = 'pending', updated_at = now()
    where id = v_next_step_id;
    return 'pending_manager';
  end if;

  update public.attendance_regularization_requests
  set status = 'pending_hr', updated_at = now()
  where company_id = p_company_id and id = p_request_id and status = 'pending_manager';
  return 'pending_hr';
end;
$$;

revoke execute on function public.hr_decide_attendance_regularization_step(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.hr_decide_attendance_regularization_step(uuid, uuid, uuid, text, text) to service_role;

notify pgrst, 'reload schema';

commit;
