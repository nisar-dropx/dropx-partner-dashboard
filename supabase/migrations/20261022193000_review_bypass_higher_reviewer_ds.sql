-- Allow higher reviewers on a route (e.g. Regional Manager) to skip a lower pending level,
-- and allow Dark Store City / Regional / National Head steps to be skipped (not only LM CM/AOM/NH).
begin;

create or replace function public.ops_bypass_review_level(
  p_company uuid, p_actor uuid, p_review uuid, p_step uuid, p_reason text, p_expected_version timestamptz
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare
  v_review ops_performance_reviews; v_step ops_performance_review_steps;
  v_profile profiles; v_role user_roles; v_next integer; v_reason text=trim(p_reason);
  v_people_labels text[]; v_actor_role text; v_allowed boolean=false; v_higher boolean=false;
begin
  select * into v_profile from profiles where id=p_actor and company_id=p_company and is_active;
  if not found then raise exception 'Your account is unavailable.'; end if;
  select * into v_role from user_roles where id=v_profile.role_id and company_id=p_company and is_active;
  select array_agg(upper(regexp_replace(concat_ws(' ',d.code,d.name,a.position_title),'[^a-zA-Z0-9]+',' ','g'))),
    min(coalesce(d.name,a.position_title)) into v_people_labels,v_actor_role
  from hr_user_person_links l join hr_engagements e on e.person_id=l.person_id and e.company_id=l.company_id and e.status='active'
  join hr_work_assignments a on a.engagement_id=e.id and a.company_id=e.company_id and a.is_primary
    and a.effective_from <= (now() at time zone 'Asia/Kolkata')::date
    and (a.effective_to is null or a.effective_to >= (now() at time zone 'Asia/Kolkata')::date)
  left join designations d on d.id=a.designation_id and d.company_id=a.company_id
  where l.company_id=p_company and l.user_id=p_actor and l.status='active';
  v_allowed := coalesce(v_profile.is_master_owner,false)
    or coalesce(v_role.code in ('OWNER','TECH','OPERATIONS_TECH'),false)
    or coalesce(upper(concat_ws(' ',v_role.code,v_role.name)) ~ 'MANAGING[ _]PARTNER',false)
    or exists(select 1 from unnest(coalesce(v_people_labels,array[upper(regexp_replace(concat_ws(' ',v_role.code,v_role.name),'[^a-zA-Z0-9]+',' ','g'))])) label
      where label ~ '(^| )(PGM|PROGRAM MANAGER|PROGRAM HEAD|NH|NATIONAL HEAD|FSD|TECH|FULL STACK DEVELOPER)( |$)');

  select * into v_review from ops_performance_reviews where id=p_review and company_id=p_company for update;
  if not found or v_review.status='closed' or v_review.review_type<>'daily_operations' then raise exception 'This review is no longer open.'; end if;
  if p_expected_version is distinct from v_review.updated_at then raise exception 'This review changed. Refresh before skipping a level.'; end if;
  select * into v_step from ops_performance_review_steps where id=p_step and review_id=p_review and company_id=p_company for update;
  if not found or v_step.status<>'pending' then raise exception 'This level is no longer pending.'; end if;

  -- Higher assigned reviewer on this same review (e.g. RM when City is pending).
  v_higher := exists(
    select 1 from ops_performance_review_steps s
    where s.company_id=p_company
      and s.review_id=p_review
      and s.reviewer_user_id=p_actor
      and s.step_order > v_step.step_order
      and s.status <> 'skipped'
  );
  if not v_allowed and not v_higher then
    raise exception 'Your role cannot skip review levels.';
  end if;
  if v_reason is null or length(v_reason)<5 or length(v_reason)>2000 then
    raise exception 'Add a clear skip reason between 5 and 2,000 characters.';
  end if;

  -- LM CM/AOM/NH and Dark Store City / Regional / National Head stages.
  if upper(regexp_replace(v_step.reviewer_role,'[^a-zA-Z0-9]+',' ','g'))
    !~ '(^| )(CLM|CLUSTER MANAGER|CLUSTER HEAD|AOM|AREA OPERATIONS? MANAGER|CITY MANAGER|CTM|RM|REGIONAL MANAGER|REGIONAL HEAD|NH|NATIONAL HEAD)( |$)'
  then
    raise exception 'Only a manager review level can be skipped.';
  end if;

  update ops_performance_review_steps set status='skipped',bypass_reason=v_reason,bypassed_by=p_actor,
    bypassed_by_name=coalesce(nullif(v_profile.full_name,''),'Authorised reviewer'),bypassed_at=clock_timestamp(),updated_at=clock_timestamp()
    where id=p_step;
  select min(step_order) into v_next from ops_performance_review_steps where review_id=p_review and status='pending';
  update ops_performance_reviews set current_step_order=coalesce(v_next,current_step_order),
    status=case when v_next is null then 'closed' else 'in_review' end,
    closed_at=case when v_next is null then clock_timestamp() end,closed_by=case when v_next is null then p_actor end,
    updated_by=p_actor,updated_at=clock_timestamp() where id=p_review;
  insert into ops_performance_review_updates(company_id,review_id,update_type,note,created_by,author_name,author_role,stage_label)
  values(p_company,p_review,'status',
    'Skipped '||v_step.reviewer_role||' · '||v_step.reviewer_name||E'\nReason: '||v_reason||
      case when v_next is null then E'\nReview closed with skipped levels. This is not an approval by the skipped manager.' else '' end,
    p_actor,coalesce(nullif(v_profile.full_name,''),'Authorised reviewer'),coalesce(v_actor_role,v_role.name,'Reviewer'),'Level skipped');
  return jsonb_build_object('closed',v_next is null,'next_step_order',v_next);
end $$;

revoke all on function public.ops_bypass_review_level(uuid,uuid,uuid,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.ops_bypass_review_level(uuid,uuid,uuid,uuid,text,timestamptz) to service_role;

notify pgrst, 'reload schema';
commit;
