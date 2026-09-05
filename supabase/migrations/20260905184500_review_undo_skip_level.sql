-- Undo an accidental explicit skip so Proxy / completion can continue.
create or replace function public.ops_undo_bypass_review_level(
  p_company uuid,
  p_actor uuid,
  p_review uuid,
  p_step uuid,
  p_expected_version timestamptz
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_review ops_performance_reviews;
  v_step ops_performance_review_steps;
  v_profile profiles;
  v_role user_roles;
  v_people_labels text[];
  v_actor_role text;
  v_allowed boolean := false;
  v_next integer;
begin
  select * into v_profile from profiles where id = p_actor and company_id = p_company and is_active;
  if not found then raise exception 'Your account is unavailable.'; end if;
  select * into v_role from user_roles where id = v_profile.role_id and company_id = p_company and is_active;
  select array_agg(upper(regexp_replace(concat_ws(' ', d.code, d.name, a.position_title), '[^a-zA-Z0-9]+', ' ', 'g'))),
    min(coalesce(d.name, a.position_title)) into v_people_labels, v_actor_role
  from hr_user_person_links l
  join hr_engagements e on e.person_id = l.person_id and e.company_id = l.company_id and e.status = 'active'
  join hr_work_assignments a on a.engagement_id = e.id and a.company_id = e.company_id and a.is_primary
    and a.effective_from <= (now() at time zone 'Asia/Kolkata')::date
    and (a.effective_to is null or a.effective_to >= (now() at time zone 'Asia/Kolkata')::date)
  left join designations d on d.id = a.designation_id and d.company_id = a.company_id
  where l.company_id = p_company and l.user_id = p_actor and l.status = 'active';

  v_allowed := coalesce(v_profile.is_master_owner, false)
    or coalesce(v_role.code in ('OWNER', 'TECH', 'OPERATIONS_TECH'), false)
    or coalesce(upper(concat_ws(' ', v_role.code, v_role.name)) ~ 'MANAGING[ _]PARTNER', false)
    or exists (
      select 1
      from unnest(coalesce(v_people_labels, array[upper(regexp_replace(concat_ws(' ', v_role.code, v_role.name), '[^a-zA-Z0-9]+', ' ', 'g'))])) label
      where label ~ '(^| )(PGM|PROGRAM MANAGER|PROGRAM HEAD|NH|NATIONAL HEAD|FSD|TECH|FULL STACK DEVELOPER)( |$)'
    );
  if not v_allowed then raise exception 'Your role cannot undo a skipped review level.'; end if;

  select * into v_review from ops_performance_reviews where id = p_review and company_id = p_company for update;
  if not found or v_review.review_type <> 'daily_operations' then raise exception 'This review is unavailable.'; end if;
  if p_expected_version is distinct from v_review.updated_at then raise exception 'This review changed. Refresh before undoing a skip.'; end if;

  select * into v_step from ops_performance_review_steps where id = p_step and review_id = p_review and company_id = p_company for update;
  if not found or v_step.status <> 'skipped' or v_step.bypassed_at is null then
    raise exception 'Only an explicit skipped level can be undone.';
  end if;

  update ops_performance_review_steps
  set status = 'pending',
      bypass_reason = null,
      bypassed_at = null,
      bypassed_by = null,
      bypassed_by_name = null,
      completed_at = null,
      completed_by = null,
      updated_at = clock_timestamp()
  where id = p_step;

  select min(step_order) into v_next
  from ops_performance_review_steps
  where review_id = p_review and status = 'pending';

  update ops_performance_reviews
  set status = 'in_review',
      current_step_order = coalesce(v_next, v_step.step_order),
      closed_at = null,
      closed_by = null,
      updated_by = p_actor,
      updated_at = clock_timestamp()
  where id = p_review;

  insert into ops_performance_review_updates(company_id, review_id, update_type, note, created_by, author_name, author_role, stage_label)
  values (
    p_company,
    p_review,
    'status',
    'Restored skipped level · ' || v_step.reviewer_role || ' · ' || v_step.reviewer_name || E'\nPrevious reason: ' || coalesce(v_step.bypass_reason, '—'),
    p_actor,
    coalesce(nullif(v_profile.full_name, ''), 'Authorised reviewer'),
    coalesce(v_actor_role, v_role.name, 'Reviewer'),
    'Skip undone'
  );

  return jsonb_build_object('next_step_order', coalesce(v_next, v_step.step_order), 'reopened', true);
end;
$$;

revoke all on function public.ops_undo_bypass_review_level(uuid, uuid, uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.ops_undo_bypass_review_level(uuid, uuid, uuid, uuid, timestamptz) to service_role;
