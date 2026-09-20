begin;

alter table public.ops_performance_reviews add column if not exists routing_version integer not null default 1;
alter table public.ops_performance_review_updates
  add column if not exists author_name text,
  add column if not exists author_role text,
  add column if not exists stage_label text;

update public.ops_performance_review_updates u
set author_name = p.full_name, author_role = r.name
from public.profiles p left join public.user_roles r on r.id=p.role_id
where u.created_by=p.id and u.company_id=p.company_id and u.author_name is null;

create table public.ops_performance_connections (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  station_id uuid not null references public.stations(id),
  service_date date not null,
  label text not null check (length(label) between 1 and 100),
  arrival_at timestamptz not null,
  unloading_at timestamptz,
  clearance_at timestamptz,
  version integer not null default 1,
  created_by uuid references public.profiles(id),
  updated_by uuid references public.profiles(id),
  updated_by_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((arrival_at at time zone 'Asia/Kolkata')::date = service_date),
  check (unloading_at is null or (unloading_at >= arrival_at and unloading_at <= arrival_at + interval '48 hours')),
  check (clearance_at is null or (unloading_at is not null and clearance_at >= unloading_at and clearance_at <= arrival_at + interval '48 hours'))
);
create index ops_performance_connections_station_day_idx on public.ops_performance_connections(company_id,station_id,service_date,arrival_at);
create index ops_performance_connections_station_idx on public.ops_performance_connections(station_id);
create index ops_performance_connections_creator_idx on public.ops_performance_connections(created_by);
create index ops_performance_connections_updater_idx on public.ops_performance_connections(updated_by);
alter table public.ops_performance_connections enable row level security;
revoke all on public.ops_performance_connections from anon, authenticated;
grant select,insert,update,delete on public.ops_performance_connections to service_role;

-- Preserve the original single connection; no historical timing is discarded.
insert into public.ops_performance_connections(company_id,station_id,service_date,label,arrival_at,unloading_at,clearance_at,created_by,updated_by,updated_by_name)
select company_id,station_id,source_date,'Connection 1',
  (source_date + vehicle_arrival_time) at time zone 'Asia/Kolkata',
  case when unloading_complete_time is not null then
    (source_date + unloading_complete_time + case when unloading_complete_time < vehicle_arrival_time then interval '1 day' else interval '0' end) at time zone 'Asia/Kolkata' end,
  case when station_clear_time is not null and unloading_complete_time is not null then
    (source_date + station_clear_time + case when station_clear_time < unloading_complete_time then interval '1 day' else interval '0' end
      + case when unloading_complete_time < vehicle_arrival_time then interval '1 day' else interval '0' end) at time zone 'Asia/Kolkata' end,
  started_by,updated_by,'Previous entry'
from public.ops_performance_reviews where vehicle_arrival_time is not null;

-- Internal transactional entry points. Authentication, station scope and stage permission
-- are validated in the server action; these functions are never callable by browser roles.
create or replace function public.ops_start_manager_review(p_company uuid,p_actor uuid,p_station uuid,p_data jsonb,p_chain jsonb)
returns uuid language plpgsql security invoker set search_path=public as $$
declare v_id uuid; v_step jsonb; v_order integer=0;
begin
  if not exists(select 1 from profiles where id=p_actor and company_id=p_company and is_active) or
     not exists(select 1 from stations where id=p_station and company_id=p_company and is_active) then raise exception 'Station access is unavailable.'; end if;
  if jsonb_array_length(p_chain)=0 then raise exception 'Set up the station reporting line in People first.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_company::text||p_station::text||(p_data->>'source_date'),0));
  select id into v_id from ops_performance_reviews where company_id=p_company and station_id=p_station and source_date=(p_data->>'source_date')::date and review_type='daily_operations';
  if v_id is not null then return v_id; end if;
  insert into ops_performance_reviews(company_id,station_id,station_code,source_date,review_type,source_type,source_batch_id,report_year,report_week,status,started_by,updated_by,routing_version)
  select p_company,p_station,station_code,(p_data->>'source_date')::date,'daily_operations',coalesce(p_data->>'source_type','operational_data'),nullif(p_data->>'source_batch_id','')::uuid,
    extract(year from (p_data->>'source_date')::date)::int,nullif(p_data->>'report_week','')::int,'in_review',p_actor,p_actor,2
  from stations where id=p_station returning id into v_id;
  for v_step in select value from jsonb_array_elements(p_chain) loop
    v_order=v_order+1;
    insert into ops_performance_review_steps(company_id,review_id,step_order,reviewer_user_id,reviewer_name,reviewer_role)
    values(p_company,v_id,v_order,nullif(v_step->>'reviewerUserId','')::uuid,v_step->>'reviewerName',v_step->>'reviewerRole');
  end loop;
  return v_id;
end $$;

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
      update ops_performance_review_steps set status='completed',completed_at=now(),completed_by=p_actor,feedback=coalesce(v_note,feedback),updated_at=now() where id=v_step.id;
      select min(step_order) into v_next from ops_performance_review_steps where review_id=p_review and status='pending';
      update ops_performance_reviews set status=case when v_next is null then 'closed' else 'in_review' end,current_step_order=coalesce(v_next,current_step_order),
        closed_at=case when v_next is null then now() end,closed_by=case when v_next is null then p_actor end,updated_by=p_actor,updated_at=clock_timestamp() where id=p_review;
      v_note=coalesce(v_note,'Reviewed — no additional comments.');
    elsif v_note is null then raise exception 'Enter your comment.';
    end if;
  else raise exception 'Unsupported review action.';
  end if;
  insert into ops_performance_review_updates(company_id,review_id,review_item_id,update_type,note,created_by,author_name,author_role,stage_label)
  values(p_company,p_review,v_item_id,v_type,v_note,p_actor,p_data->>'author_name',p_data->>'author_role',coalesce(v_step.reviewer_role,'Completed review'));
end $$;

create or replace function public.ops_save_review_connection(p_company uuid,p_actor uuid,p_station uuid,p_data jsonb)
returns uuid language plpgsql security invoker set search_path=public as $$
declare v_id uuid=nullif(p_data->>'id','')::uuid;
begin
  if not exists(select 1 from profiles where id=p_actor and company_id=p_company and is_active) or not exists(select 1 from stations where id=p_station and company_id=p_company and is_active) then raise exception 'Station access unavailable.'; end if;
  if v_id is null then
    insert into ops_performance_connections(company_id,station_id,service_date,label,arrival_at,unloading_at,clearance_at,created_by,updated_by,updated_by_name)
    values(p_company,p_station,(p_data->>'service_date')::date,p_data->>'label',(p_data->>'arrival')::timestamptz,nullif(p_data->>'unloading','')::timestamptz,nullif(p_data->>'clearance','')::timestamptz,p_actor,p_actor,p_data->>'author_name') returning id into v_id;
  else
    update ops_performance_connections set label=p_data->>'label',arrival_at=(p_data->>'arrival')::timestamptz,unloading_at=nullif(p_data->>'unloading','')::timestamptz,
      clearance_at=nullif(p_data->>'clearance','')::timestamptz,version=version+1,updated_by=p_actor,updated_by_name=p_data->>'author_name',updated_at=now()
    where id=v_id and company_id=p_company and station_id=p_station and service_date=(p_data->>'service_date')::date and version=(p_data->>'version')::int;
    if not found then raise exception 'This connection was updated by someone else. Refresh and try again.'; end if;
  end if;
  return v_id;
end $$;

create or replace function public.ops_reconcile_manager_review(p_company uuid,p_review uuid,p_chain jsonb)
returns void language plpgsql security invoker set search_path=public as $$
declare v_review ops_performance_reviews; v_step jsonb; v_order integer; v_first integer;
begin
  select * into v_review from ops_performance_reviews where id=p_review and company_id=p_company for update;
  if not found or v_review.routing_version>=2 or v_review.status='closed' or jsonb_array_length(p_chain)=0 then return; end if;
  select coalesce(max(step_order),0) into v_order from ops_performance_review_steps where review_id=p_review;
  update ops_performance_review_steps set status='skipped',updated_at=now() where review_id=p_review and status='pending';
  for v_step in select value from jsonb_array_elements(p_chain) loop
    if exists(select 1 from ops_performance_review_steps where review_id=p_review and status='completed' and reviewer_user_id=nullif(v_step->>'reviewerUserId','')::uuid and reviewer_role=v_step->>'reviewerRole') then continue; end if;
    v_order=v_order+1; v_first=coalesce(v_first,v_order);
    insert into ops_performance_review_steps(company_id,review_id,step_order,reviewer_user_id,reviewer_name,reviewer_role)
    values(p_company,p_review,v_order,nullif(v_step->>'reviewerUserId','')::uuid,v_step->>'reviewerName',v_step->>'reviewerRole');
  end loop;
  update ops_performance_reviews set routing_version=2,current_step_order=coalesce(v_first,current_step_order),status=case when v_first is null then 'closed' else 'in_review' end,
    closed_at=case when v_first is null then now() end,updated_at=now() where id=p_review;
  insert into ops_performance_review_updates(company_id,review_id,update_type,note,author_name,stage_label)
  values(p_company,p_review,'status','Review route updated from People. Stations record connection timings; managers review RCA and actions. Previous entries are preserved.','System','Workflow updated');
end $$;

revoke all on function public.ops_start_manager_review(uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.ops_mutate_manager_review(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.ops_save_review_connection(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.ops_reconcile_manager_review(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.ops_start_manager_review(uuid,uuid,uuid,jsonb,jsonb) to service_role;
grant execute on function public.ops_mutate_manager_review(uuid,uuid,uuid,text,jsonb) to service_role;
grant execute on function public.ops_save_review_connection(uuid,uuid,uuid,jsonb) to service_role;
grant execute on function public.ops_reconcile_manager_review(uuid,uuid,jsonb) to service_role;
commit;
