begin;

-- Ordered after the legacy discussion/connection migration so proxy completion checks
-- remain the final function definition on a fresh database as well as production.

-- Explicit exceptions are separate from legacy route-reconciliation skips.
alter table public.ops_performance_review_steps
  add column bypass_reason text,
  add column bypassed_at timestamptz,
  add column bypassed_by uuid references public.profiles(id) on delete set null,
  add column bypassed_by_name text,
  add constraint ops_review_step_bypass_evidence check (
    (bypass_reason is null and bypassed_at is null and bypassed_by is null and bypassed_by_name is null)
    or (status='skipped' and bypassed_at is not null and bypassed_by_name is not null and bypass_reason is not null
      and length(trim(bypass_reason)) between 5 and 2000)
  );
create index ops_review_step_bypass_actor_idx on public.ops_performance_review_steps(bypassed_by) where bypassed_by is not null;
create index ops_review_older_pending_idx on public.ops_performance_reviews(company_id,source_date,station_code,id)
  where review_type='daily_operations' and status in ('open','in_review');

-- Server-only RPC: the server action also checks page permission and exact station scope.
-- Role validation here is defence in depth, using current People assignments, never a client role.
create function public.ops_bypass_review_level(
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

create table public.ops_performance_daily_inputs (
  company_id uuid not null references public.companies(id),
  station_id uuid not null references public.stations(id),
  source_date date not null,
  emd_noon_pct numeric(5,2) check (emd_noon_pct between 0 and 100),
  version integer not null default 1 check(version>0),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id),
  updated_by_name text not null,
  primary key(company_id,station_id,source_date)
);
create index ops_daily_inputs_station_idx on public.ops_performance_daily_inputs(station_id);
create index ops_daily_inputs_actor_idx on public.ops_performance_daily_inputs(updated_by);
alter table public.ops_performance_daily_inputs enable row level security;
revoke all on public.ops_performance_daily_inputs from anon,authenticated;
grant select,insert,update on public.ops_performance_daily_inputs to service_role;

create table public.ops_performance_followups (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  review_id uuid not null references public.ops_performance_reviews(id),
  station_id uuid not null references public.stations(id),
  source_date date not null,
  action_number integer not null check(action_number>0),
  title text not null check(length(trim(title)) between 1 and 2000),
  owner_label text not null check(length(trim(owner_label)) between 1 and 250),
  due_date date not null check(due_date>=source_date),
  status text not null default 'open' check(status in ('open','in_progress','blocked','done')),
  is_resolved boolean generated always as (status='done') stored,
  progress_note text check(length(progress_note)<=2000),
  version integer not null default 1 check(version>0),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id),
  updated_by_name text not null,
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  completed_by uuid references public.profiles(id),
  unique(review_id,action_number)
);
create index ops_followups_station_due_idx on public.ops_performance_followups(company_id,station_id,is_resolved,due_date);
create index ops_followups_station_idx on public.ops_performance_followups(station_id);
create index ops_followups_creator_idx on public.ops_performance_followups(created_by);
create index ops_followups_updater_idx on public.ops_performance_followups(updated_by);
create index ops_followups_completer_idx on public.ops_performance_followups(completed_by);
alter table public.ops_performance_followups enable row level security;
revoke all on public.ops_performance_followups from anon,authenticated;
grant select,insert,update on public.ops_performance_followups to service_role;

create function public.ops_save_review_noon_emd(p_company uuid,p_actor uuid,p_station uuid,p_date date,p_value numeric,p_version integer)
returns void language plpgsql security invoker set search_path=public as $$
declare v_name text; v_saved integer;
begin
  select full_name into v_name from profiles where id=p_actor and company_id=p_company and is_active;
  if not found or not exists(select 1 from stations where id=p_station and company_id=p_company and is_active) then raise exception 'Station access is unavailable.'; end if;
  if p_value is not null and not (p_value between 0 and 100) then raise exception 'Enter EMD between 0 and 100 percent.'; end if;
  insert into ops_performance_daily_inputs(company_id,station_id,source_date,emd_noon_pct,updated_by,updated_by_name)
  values(p_company,p_station,p_date,p_value,p_actor,coalesce(v_name,'Station team'))
  on conflict(company_id,station_id,source_date) do update set emd_noon_pct=excluded.emd_noon_pct,
    version=ops_performance_daily_inputs.version+1,updated_at=clock_timestamp(),updated_by=p_actor,updated_by_name=excluded.updated_by_name
    where ops_performance_daily_inputs.version=p_version
  returning version into v_saved;
  if v_saved is null then raise exception 'EMD was updated by someone else. Refresh to continue.'; end if;
  if p_version<>0 and v_saved=1 then raise exception 'This EMD entry changed. Refresh to continue.'; end if;
end $$;
revoke all on function public.ops_save_review_noon_emd(uuid,uuid,uuid,date,numeric,integer) from public,anon,authenticated;
grant execute on function public.ops_save_review_noon_emd(uuid,uuid,uuid,date,numeric,integer) to service_role;

create function public.ops_save_review_followup(p_company uuid,p_actor uuid,p_station uuid,p_view_date date,p_data jsonb)
returns uuid language plpgsql security invoker set search_path=public as $$
declare v_review ops_performance_reviews; v_action ops_performance_followups; v_id uuid=nullif(p_data->>'id','')::uuid;
  v_name text; v_number integer; v_status text=coalesce(p_data->>'status','open'); v_note text;
begin
  select full_name into v_name from profiles where id=p_actor and company_id=p_company and is_active;
  if not found or not exists(select 1 from stations where id=p_station and company_id=p_company and is_active) then raise exception 'Station access is unavailable.'; end if;
  if v_status not in ('open','in_progress','blocked','done') then raise exception 'Select a valid action status.'; end if;
  if nullif(trim(p_data->>'title'),'') is null or nullif(trim(p_data->>'owner_label'),'') is null or nullif(p_data->>'due_date','') is null then raise exception 'Add the action, owner and ETA.'; end if;
  if v_id is null then
    select * into v_review from ops_performance_reviews where id=(p_data->>'review_id')::uuid and company_id=p_company and station_id=p_station and source_date=p_view_date and review_type='daily_operations' for update;
    if not found then raise exception 'Start this station review before adding an action.'; end if;
    select coalesce(max(action_number),0)+1 into v_number from ops_performance_followups where review_id=v_review.id;
    insert into ops_performance_followups(company_id,review_id,station_id,source_date,action_number,title,owner_label,due_date,created_by,updated_by,updated_by_name)
    values(p_company,v_review.id,p_station,p_view_date,v_number,trim(p_data->>'title'),trim(p_data->>'owner_label'),(p_data->>'due_date')::date,p_actor,p_actor,coalesce(v_name,'Reviewer')) returning id into v_id;
    v_note='Action '||v_number||' added: '||trim(p_data->>'title')||E'\nOwner: '||trim(p_data->>'owner_label')||' · ETA: '||(p_data->>'due_date');
  else
    select * into v_action from ops_performance_followups where id=v_id and company_id=p_company and station_id=p_station and source_date<=p_view_date for update;
    if not found or v_action.version is distinct from (p_data->>'version')::integer then raise exception 'This action changed. Refresh to continue.'; end if;
    update ops_performance_followups set title=trim(p_data->>'title'),owner_label=trim(p_data->>'owner_label'),due_date=(p_data->>'due_date')::date,
      status=v_status,progress_note=nullif(trim(p_data->>'progress_note'),''),version=version+1,updated_at=clock_timestamp(),updated_by=p_actor,updated_by_name=coalesce(v_name,'Reviewer'),
      completed_at=case when v_status='done' then coalesce(completed_at,clock_timestamp()) end,completed_by=case when v_status='done' then coalesce(completed_by,p_actor) end where id=v_id;
    v_review.id=v_action.review_id;
    v_note='Action '||v_action.action_number||' updated to '||replace(v_status,'_',' ')||': '||trim(p_data->>'title')||E'\nOwner: '||trim(p_data->>'owner_label')||' · ETA: '||(p_data->>'due_date')||coalesce(E'\n'||nullif(trim(p_data->>'progress_note'),''),'');
  end if;
  insert into ops_performance_review_updates(company_id,review_id,update_type,note,created_by,author_name,author_role,stage_label)
  values(p_company,v_review.id,'action',v_note,p_actor,coalesce(v_name,'Reviewer'),p_data->>'author_role','Action follow-up');
  return v_id;
end $$;
revoke all on function public.ops_save_review_followup(uuid,uuid,uuid,date,jsonb) from public,anon,authenticated;
grant execute on function public.ops_save_review_followup(uuid,uuid,uuid,date,jsonb) to service_role;

-- Proxy means the review is conducted, not skipped. Preserve the scheduled reviewer.
alter table public.ops_performance_review_steps
  add column proxy_reviewer_user_id uuid references public.profiles(id),
  add column proxy_reviewer_name text,
  add column proxy_reason text,
  add column proxy_started_at timestamptz,
  add constraint ops_review_proxy_evidence check (
    (proxy_reviewer_user_id is null and proxy_reviewer_name is null and proxy_reason is null and proxy_started_at is null)
    or (proxy_reviewer_user_id is not null and proxy_reviewer_name is not null and proxy_reason is not null
      and proxy_started_at is not null and length(trim(proxy_reason)) between 5 and 2000));
create index ops_review_proxy_actor_idx on public.ops_performance_review_steps(proxy_reviewer_user_id) where proxy_reviewer_user_id is not null;

create function public.ops_take_proxy_review(p_company uuid,p_actor uuid,p_review uuid,p_step uuid,p_reason text,p_expected_version timestamptz)
returns void language plpgsql security invoker set search_path=public as $$
declare v_profile profiles; v_role user_roles; v_people_labels text[]; v_actor_role text; v_allowed boolean=false;
  v_review ops_performance_reviews; v_step ops_performance_review_steps;
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
  if p_expected_version is distinct from v_review.updated_at then raise exception 'This review changed. Refresh before taking a proxy review.'; end if;
  select * into v_step from ops_performance_review_steps where id=p_step and company_id=p_company and review_id=p_review for update;
  if not found or v_step.status<>'pending' or v_step.step_order<>v_review.current_step_order then raise exception 'Only the current pending level can be reviewed by proxy.'; end if;
  if v_step.proxy_reviewer_user_id is not null and not v_allowed then raise exception 'This level already has a proxy reviewer. Ask authorised oversight to change cover.'; end if;
  if v_step.reviewer_user_id=p_actor then raise exception 'This is already your review level.'; end if;
  if not v_allowed and not exists(select 1 from ops_performance_review_steps where company_id=p_company and review_id=p_review
    and reviewer_user_id=p_actor and step_order>v_step.step_order and status<>'skipped') then
    raise exception 'Only a higher assigned manager or authorised oversight can cover this review.';
  end if;
  if nullif(trim(p_reason),'') is null or length(trim(p_reason)) not between 5 and 2000 then raise exception 'Explain why the assigned manager cannot conduct this review (5–2,000 characters).'; end if;
  update ops_performance_review_steps set proxy_reviewer_user_id=p_actor,proxy_reviewer_name=coalesce(v_profile.full_name,'Reviewer'),
    proxy_reason=trim(p_reason),proxy_started_at=clock_timestamp(),updated_at=clock_timestamp() where id=p_step;
  update ops_performance_reviews set updated_at=clock_timestamp(),updated_by=p_actor where id=p_review;
  insert into ops_performance_review_updates(company_id,review_id,update_type,note,created_by,author_name,author_role,stage_label)
  values(p_company,p_review,'status','Proxy review for '||v_step.reviewer_name||' · '||v_step.reviewer_role||E'\nReason: '||trim(p_reason),
    p_actor,coalesce(v_profile.full_name,'Reviewer'),coalesce(v_actor_role,v_role.name,'Reviewer'),'Proxy review started');
end $$;
revoke all on function public.ops_take_proxy_review(uuid,uuid,uuid,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.ops_take_proxy_review(uuid,uuid,uuid,uuid,text,timestamptz) to service_role;

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

create function public.ops_progress_review_item(p_company uuid,p_actor uuid,p_station uuid,p_date date,p_item uuid,p_version timestamptz,p_status text,p_note text)
returns void language plpgsql security invoker set search_path=public as $$
declare v_item ops_performance_review_items; v_name text;
begin
  select full_name into v_name from profiles where id=p_actor and company_id=p_company and is_active;
  if not found then raise exception 'Your account is unavailable.'; end if;
  select i.* into v_item from ops_performance_review_items i join ops_performance_reviews r on r.id=i.review_id and r.company_id=i.company_id
    where i.id=p_item and i.company_id=p_company and r.station_id=p_station and r.source_date<=p_date and r.review_type='daily_operations' for update of i;
  if not found or v_item.updated_at is distinct from p_version then raise exception 'This action changed. Refresh to continue.'; end if;
  if p_status is null or p_status not in ('open','in_progress','blocked','done') or nullif(trim(p_note),'') is null or length(p_note)>2000 then raise exception 'Select a status and add a short progress note.'; end if;
  update ops_performance_review_items set status=p_status,updated_by=p_actor,updated_at=clock_timestamp(),
    closed_at=case when p_status='done' then coalesce(closed_at,clock_timestamp()) end,
    closed_by=case when p_status='done' then coalesce(closed_by,p_actor) end where id=p_item;
  insert into ops_performance_review_updates(company_id,review_id,review_item_id,update_type,note,created_by,author_name,stage_label)
    values(p_company,v_item.review_id,p_item,'action',v_item.metric_label||' · '||replace(p_status,'_',' ')||E'\n'||trim(p_note),p_actor,coalesce(v_name,'Reviewer'),'Action follow-up');
end $$;
revoke all on function public.ops_progress_review_item(uuid,uuid,uuid,date,uuid,timestamptz,text,text) from public,anon,authenticated;
grant execute on function public.ops_progress_review_item(uuid,uuid,uuid,date,uuid,timestamptz,text,text) to service_role;

commit;
