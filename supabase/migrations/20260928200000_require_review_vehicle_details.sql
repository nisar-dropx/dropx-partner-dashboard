begin;

-- A station-day review has one required vehicle record. The client presents an
-- unsaved Vehicle 1 by default; this guard makes the rule hold for every
-- completion path, including server-side RPC calls and final-stage bypasses.
create or replace function public.ops_assert_review_vehicle_details(p_company uuid,p_station uuid,p_date date)
returns void language plpgsql security invoker set search_path=public as $$
begin
  if not exists (
    select 1 from ops_performance_connections
    where company_id=p_company and station_id=p_station and service_date=p_date
      and arrival_at is not null and unloading_at is not null
  ) then
    raise exception 'Record Vehicle 1 arrival and unloading before completing this review.';
  end if;
end $$;
revoke all on function public.ops_assert_review_vehicle_details(uuid,uuid,date) from public,anon,authenticated;
grant execute on function public.ops_assert_review_vehicle_details(uuid,uuid,date) to service_role;

create or replace function public.ops_save_review_connection(p_company uuid,p_actor uuid,p_station uuid,p_data jsonb)
returns uuid language plpgsql security invoker set search_path=public as $$
declare v_id uuid=nullif(p_data->>'id','')::uuid;
begin
  if not exists(select 1 from profiles where id=p_actor and company_id=p_company and is_active)
    or not exists(select 1 from stations where id=p_station and company_id=p_company and is_active)
    then raise exception 'Station access unavailable.'; end if;
  if nullif(trim(p_data->>'label'),'') is null then raise exception 'Enter a vehicle label.'; end if;
  if nullif(p_data->>'arrival','') is null or nullif(p_data->>'unloading','') is null then
    raise exception 'Enter Vehicle 1 arrival and unloading times.';
  end if;
  if v_id is null then
    insert into ops_performance_connections(company_id,station_id,service_date,label,arrival_at,unloading_at,created_by,updated_by,updated_by_name)
    values(p_company,p_station,(p_data->>'service_date')::date,trim(p_data->>'label'),(p_data->>'arrival')::timestamptz,(p_data->>'unloading')::timestamptz,p_actor,p_actor,p_data->>'author_name') returning id into v_id;
  else
    update ops_performance_connections set label=trim(p_data->>'label'),arrival_at=(p_data->>'arrival')::timestamptz,unloading_at=(p_data->>'unloading')::timestamptz,
      version=version+1,updated_by=p_actor,updated_by_name=p_data->>'author_name',updated_at=now()
    where id=v_id and company_id=p_company and station_id=p_station and service_date=(p_data->>'service_date')::date and version=(p_data->>'version')::int;
    if not found then raise exception 'This connection was updated by someone else. Refresh and try again.'; end if;
  end if;
  return v_id;
end $$;
revoke all on function public.ops_save_review_connection(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.ops_save_review_connection(uuid,uuid,uuid,jsonb) to service_role;

create or replace function public.ops_mutate_manager_review(p_company uuid,p_actor uuid,p_review uuid,p_action text,p_data jsonb)
returns void language plpgsql security invoker set search_path=public as $$
declare v_review ops_performance_reviews; v_step ops_performance_review_steps; v_item ops_performance_review_items;
  v_item_id uuid; v_note text; v_type text='review'; v_next integer;
begin
  if not exists(select 1 from profiles where id=p_actor and company_id=p_company and is_active) then raise exception 'Your account is unavailable.'; end if;
  select * into v_review from ops_performance_reviews where id=p_review and company_id=p_company for update;
  if not found then raise exception 'Review unavailable.'; end if;
  select * into v_step from ops_performance_review_steps where review_id=p_review and step_order=v_review.current_step_order;
  if p_action in ('item','summary','comment') and nullif(p_data->>'expected_review_version','')::timestamptz is distinct from v_review.updated_at then
    raise exception 'This review was updated by someone else. Refresh and try again.';
  end if;
  if p_action='summary' then
    update ops_performance_reviews set review_summary=nullif(p_data->>'summary',''),updated_at=clock_timestamp(),updated_by=p_actor where id=p_review;
    v_note='Takeaway: '||coalesce(nullif(p_data->>'summary',''),'Cleared');
  elsif p_action='item' then
    select * into v_item from ops_performance_review_items where review_id=p_review and metric_key=p_data->>'metric_key' for update;
    insert into ops_performance_review_items(company_id,review_id,metric_key,metric_label,root_cause,corrective_action,action_owner,due_date,status,severity,actual_value,target_value,target_direction,created_by,updated_by,updated_at,closed_by,closed_at)
    values(p_company,p_review,p_data->>'metric_key',p_data->>'metric_label',p_data->>'root_cause',p_data->>'corrective_action',p_data->>'action_owner',
      (p_data->>'due_date')::date,p_data->>'status',p_data->>'severity',nullif(p_data->>'actual_value','')::numeric,nullif(p_data->>'target_value','')::numeric,p_data->>'target_direction',p_actor,p_actor,clock_timestamp(),
      case when p_data->>'status'='done' then p_actor end,case when p_data->>'status'='done' then now() end)
    on conflict(review_id,metric_key) do update set root_cause=excluded.root_cause,corrective_action=excluded.corrective_action,action_owner=excluded.action_owner,
      due_date=excluded.due_date,status=excluded.status,updated_by=p_actor,updated_at=excluded.updated_at,closed_by=excluded.closed_by,closed_at=excluded.closed_at
    returning id into v_item_id;
    update ops_performance_reviews set updated_at=clock_timestamp(),updated_by=p_actor where id=p_review;
    v_note=(p_data->>'metric_label')||E'\nRCA: '||(p_data->>'root_cause')||E'\nAction: '||(p_data->>'corrective_action')||E'\nOwner: '||(p_data->>'action_owner')||' · Due '||(p_data->>'due_date')||' · '||(p_data->>'status');
    v_type='action';
  elsif p_action in ('comment','complete') then
    v_note=nullif(trim(p_data->>'note'),'');
    if p_action='complete' then
      if v_review.status='closed' or v_step.id is distinct from nullif(p_data->>'step_id','')::uuid or v_step.status<>'pending' then raise exception 'The review has moved to another stage. Refresh to continue.'; end if;
      if coalesce(v_step.proxy_reviewer_user_id,v_step.reviewer_user_id) is distinct from p_actor then raise exception 'Only the assigned reviewer or recorded proxy can complete this stage.'; end if;
      perform public.ops_assert_review_vehicle_details(p_company,v_review.station_id,v_review.source_date);
      update ops_performance_review_steps set status='completed',completed_at=now(),completed_by=p_actor,feedback=coalesce(v_note,feedback),updated_at=now() where id=v_step.id;
      select min(step_order) into v_next from ops_performance_review_steps where review_id=p_review and status='pending';
      update ops_performance_reviews set status=case when v_next is null then 'closed' else 'in_review' end,current_step_order=coalesce(v_next,current_step_order),
        closed_at=case when v_next is null then now() end,closed_by=case when v_next is null then p_actor end,updated_by=p_actor,updated_at=clock_timestamp() where id=p_review;
      v_note=case when v_step.proxy_reviewer_user_id is not null then 'Proxy review completed for '||v_step.reviewer_name||E'\n' else '' end||coalesce(v_note,'Reviewed — no additional comments.');
    elsif v_note is null then raise exception 'Enter your comment.';
    end if;
  else raise exception 'Unsupported review action.';
  end if;
  insert into ops_performance_review_updates(company_id,review_id,review_item_id,update_type,note,created_by,author_name,author_role,stage_label)
  values(p_company,p_review,v_item_id,v_type,v_note,p_actor,p_data->>'author_name',p_data->>'author_role',coalesce(v_step.reviewer_role,'Completed review'));
end $$;

create or replace function public.ops_bypass_review_level(
  p_company uuid, p_actor uuid, p_review uuid, p_step uuid, p_reason text, p_expected_version timestamptz
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare
  v_review ops_performance_reviews; v_step ops_performance_review_steps;
  v_profile profiles; v_role user_roles; v_next integer; v_reason text=trim(p_reason);
  v_people_labels text[]; v_actor_role text; v_allowed boolean=false;
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
  if not v_allowed then raise exception 'Your role cannot skip review levels.'; end if;
  if v_reason is null or length(v_reason)<5 or length(v_reason)>2000 then raise exception 'Add a clear skip reason between 5 and 2,000 characters.'; end if;

  select * into v_review from ops_performance_reviews where id=p_review and company_id=p_company for update;
  if not found or v_review.status='closed' or v_review.review_type<>'daily_operations' then raise exception 'This review is no longer open.'; end if;
  if p_expected_version is distinct from v_review.updated_at then raise exception 'This review changed. Refresh before skipping a level.'; end if;
  select * into v_step from ops_performance_review_steps where id=p_step and review_id=p_review and company_id=p_company for update;
  if not found or v_step.status<>'pending' then raise exception 'This level is no longer pending.'; end if;
  if upper(regexp_replace(v_step.reviewer_role,'[^a-zA-Z0-9]+',' ','g')) !~ '(^| )(CLM|CLUSTER MANAGER|CLUSTER HEAD|AOM|AREA OPERATIONS? MANAGER|NH|NATIONAL HEAD)( |$)' then
    raise exception 'Only a manager review level can be skipped.';
  end if;
  select min(step_order) into v_next from ops_performance_review_steps where review_id=p_review and status='pending' and id<>p_step;
  if v_next is null then perform public.ops_assert_review_vehicle_details(p_company,v_review.station_id,v_review.source_date); end if;

  update ops_performance_review_steps set status='skipped',bypass_reason=v_reason,bypassed_by=p_actor,
    bypassed_by_name=coalesce(nullif(v_profile.full_name,''),'Authorised reviewer'),bypassed_at=clock_timestamp(),updated_at=clock_timestamp()
    where id=p_step;
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

commit;
