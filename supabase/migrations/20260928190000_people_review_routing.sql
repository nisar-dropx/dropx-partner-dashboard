begin;
set local lock_timeout = '5s';
alter table public.ops_performance_reviews add column if not exists routing_error text;
alter table public.ops_performance_review_steps
  add column if not exists routing_source text,
  add column if not exists routing_person_id uuid,
  add column if not exists routing_assignment_id uuid,
  add column if not exists routing_designation_id uuid,
  add column if not exists route_superseded_at timestamptz;

create table if not exists public.ops_review_route_changes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  review_id uuid not null references public.ops_performance_reviews(id),
  changed_at timestamptz not null default clock_timestamp(),
  source text not null default 'People mapping sync',
  previous_route jsonb not null,
  new_route jsonb not null,
  routing_error text
);
alter table public.ops_review_route_changes enable row level security;
revoke all on public.ops_review_route_changes from public, anon, authenticated;
grant select, insert on public.ops_review_route_changes to service_role;
create index if not exists ops_review_route_changes_review on public.ops_review_route_changes(company_id,review_id,changed_at);

-- Only the server can supply a route, resolved from effective People records. The row lock
-- serializes sync with approval, bypass and proxy operations; closed history is immutable.
create or replace function public.ops_sync_people_review_route(p_company uuid,p_review uuid,p_chain jsonb,p_error text default null)
returns void language plpgsql security invoker set search_path=public as $$
declare
  v_review ops_performance_reviews; v_old jsonb; v_next jsonb='[]'; v_step jsonb;
  v_order integer; v_first integer; v_existing ops_performance_review_steps; v_error text=p_error;
  v_before text; v_after text;
begin
  select * into v_review from ops_performance_reviews where id=p_review and company_id=p_company for update;
  if not found then raise exception 'Review unavailable.'; end if;
  if v_review.status='closed' then return; end if;
  if jsonb_typeof(p_chain) is distinct from 'array' then raise exception 'Invalid People route.'; end if;
  if v_error is null and jsonb_array_length(p_chain)=0 then v_error='No eligible review manager is mapped in People.'; end if;
  select coalesce(jsonb_agg(to_jsonb(s) order by step_order),'[]') into v_old
    from ops_performance_review_steps s where company_id=p_company and review_id=p_review and status='pending';
  if v_error is null then
    for v_step in select value from jsonb_array_elements(p_chain) loop
      if v_step->>'routingSource' is distinct from 'people' or nullif(v_step->>'personId','') is null or
        nullif(v_step->>'assignmentId','') is null or nullif(v_step->>'designationId','') is null or
        not exists(select 1 from profiles where company_id=p_company and id=(v_step->>'reviewerUserId')::uuid and is_active) then
        raise exception 'Invalid People reviewer account.';
      end if;
      -- A completed approval or explicit bypass belongs to the historical stage, even if its holder changes.
      if exists(select 1 from ops_performance_review_steps s where s.company_id=p_company and s.review_id=p_review
        and (s.status='completed' or (s.status='skipped' and s.bypassed_at is not null)) and s.route_superseded_at is null
        and (s.routing_designation_id=(v_step->>'designationId')::uuid or
          (s.routing_designation_id is null and lower(trim(s.reviewer_role))=lower(trim(v_step->>'reviewerRole'))))) then continue; end if;
      v_next=v_next||jsonb_build_array(v_step);
    end loop;
    if jsonb_array_length(v_next)=0 then
      v_error='People mapping removed the remaining review levels. Oversight must resolve the route; the review was not automatically closed.';
    end if;
  end if;
  if v_error is not null then
    if v_review.routing_error is not distinct from v_error then return; end if;
    update ops_performance_reviews set routing_error=v_error,updated_at=clock_timestamp() where id=p_review;
    insert into ops_review_route_changes(company_id,review_id,previous_route,new_route,routing_error) values(p_company,p_review,v_old,p_chain,v_error);
    insert into ops_performance_review_updates(company_id,review_id,update_type,note,author_name,stage_label)
      values(p_company,p_review,'status','People routing needs attention: '||v_error,'System','People routing');
    return;
  end if;
  -- Compare identity and labels in order. An unchanged refresh preserves IDs, proxy grants and timestamps.
  if (select coalesce(jsonb_agg(jsonb_build_array(x->>'reviewer_user_id',x->>'reviewer_name',x->>'reviewer_role') order by ord),'[]') from jsonb_array_elements(v_old) with ordinality a(x,ord)) =
     (select coalesce(jsonb_agg(jsonb_build_array(x->>'reviewerUserId',x->>'reviewerName',x->>'reviewerRole') order by ord),'[]') from jsonb_array_elements(v_next) with ordinality a(x,ord)) then
    for v_step in select value from jsonb_array_elements(v_next) loop
      update ops_performance_review_steps set routing_source='people',routing_person_id=(v_step->>'personId')::uuid,
        routing_assignment_id=(v_step->>'assignmentId')::uuid,routing_designation_id=(v_step->>'designationId')::uuid
        where company_id=p_company and review_id=p_review and status='pending' and reviewer_user_id=(v_step->>'reviewerUserId')::uuid
        and (routing_source is distinct from 'people' or routing_assignment_id is distinct from (v_step->>'assignmentId')::uuid or routing_designation_id is distinct from (v_step->>'designationId')::uuid);
    end loop;
    if v_review.routing_error is null then return; end if;
    update ops_performance_reviews set routing_error=null,routing_version=3,updated_at=clock_timestamp() where id=p_review;
  else
    select coalesce(max(step_order),0) into v_order from ops_performance_review_steps where review_id=p_review;
    update ops_performance_review_steps set status='skipped',route_superseded_at=clock_timestamp(),updated_at=clock_timestamp()
      where company_id=p_company and review_id=p_review and status='pending';
    for v_step in select value from jsonb_array_elements(v_next) loop
      v_order=v_order+1; v_first=coalesce(v_first,v_order);
      -- A proxy is retained only for exactly the same underlying person/account and designation.
      select * into v_existing from jsonb_populate_recordset(null::ops_performance_review_steps,v_old) s
        where s.reviewer_user_id=(v_step->>'reviewerUserId')::uuid and s.reviewer_role=v_step->>'reviewerRole'
        and (s.routing_person_id is null or s.routing_person_id=(v_step->>'personId')::uuid) limit 1;
      insert into ops_performance_review_steps(company_id,review_id,step_order,reviewer_user_id,reviewer_name,reviewer_role,
        routing_source,routing_person_id,routing_assignment_id,routing_designation_id,
        proxy_reviewer_user_id,proxy_reviewer_name,proxy_reason,proxy_started_at)
      values(p_company,p_review,v_order,(v_step->>'reviewerUserId')::uuid,v_step->>'reviewerName',v_step->>'reviewerRole',
        'people',(v_step->>'personId')::uuid,(v_step->>'assignmentId')::uuid,(v_step->>'designationId')::uuid,
        v_existing.proxy_reviewer_user_id,v_existing.proxy_reviewer_name,v_existing.proxy_reason,v_existing.proxy_started_at);
    end loop;
    update ops_performance_reviews set routing_error=null,routing_version=3,current_step_order=coalesce(v_first,current_step_order),updated_at=clock_timestamp() where id=p_review;
  end if;
  select string_agg(x->>'reviewer_name'||' ('||(x->>'reviewer_role')||')',' → ' order by ord) into v_before from jsonb_array_elements(v_old) with ordinality a(x,ord);
  select string_agg(x->>'reviewerName'||' ('||(x->>'reviewerRole')||')',' → ' order by ord) into v_after from jsonb_array_elements(v_next) with ordinality a(x,ord);
  insert into ops_review_route_changes(company_id,review_id,previous_route,new_route) values(p_company,p_review,v_old,v_next);
  insert into ops_performance_review_updates(company_id,review_id,update_type,note,author_name,stage_label)
    values(p_company,p_review,'status','Pending route refreshed from People. Previous: '||coalesce(v_before,'None')||'. Current: '||coalesce(v_after,'None')||'. Completed reviews and explicit skips are preserved.','System','People routing');
end $$;
revoke all on function public.ops_sync_people_review_route(uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.ops_sync_people_review_route(uuid,uuid,jsonb,text) to service_role;

create or replace function public.ops_sync_people_review_routes(p_company uuid,p_routes jsonb)
returns void language plpgsql security invoker set search_path=public as $$
declare route jsonb;
begin
  if jsonb_typeof(p_routes) is distinct from 'array' or jsonb_array_length(p_routes)>100 then raise exception 'Invalid route batch.'; end if;
  for route in select value from jsonb_array_elements(p_routes) order by value->>'reviewId' loop
    perform ops_sync_people_review_route(p_company,(route->>'reviewId')::uuid,route->'chain',route->>'error');
  end loop;
end $$;
revoke all on function public.ops_sync_people_review_routes(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.ops_sync_people_review_routes(uuid,jsonb) to service_role;

create or replace function public.ops_guard_review_routing() returns trigger language plpgsql set search_path=public as $$
begin
  if new.status='completed' and old.status is distinct from 'completed' then
    if exists(select 1 from ops_performance_reviews where id=new.review_id and routing_error is not null) then
      raise exception 'Resolve the People reporting mapping before completing this review.';
    end if;
    if old.route_superseded_at is not null then raise exception 'This review assignment changed. Refresh and try again.'; end if;
  end if;
  return new;
end $$;
create trigger ops_guard_review_routing before update on public.ops_performance_review_steps for each row execute function public.ops_guard_review_routing();
create or replace function public.ops_start_people_review(p_company uuid,p_actor uuid,p_station uuid,p_data jsonb,p_chain jsonb)
returns uuid language plpgsql security invoker set search_path=public as $$
declare v_id uuid; v_step jsonb; v_order integer=0;
begin
  if not exists(select 1 from profiles where id=p_actor and company_id=p_company and is_active) or
     not exists(select 1 from stations where id=p_station and company_id=p_company and is_active) then raise exception 'Station access is unavailable.'; end if;
  if jsonb_typeof(p_chain) is distinct from 'array' or jsonb_array_length(p_chain) not between 1 and 64 then raise exception 'Set up the station reporting line in People first.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_company::text||p_station::text||(p_data->>'source_date'),0));
  select id into v_id from ops_performance_reviews where company_id=p_company and station_id=p_station and source_date=(p_data->>'source_date')::date and review_type='daily_operations';
  if v_id is not null then perform ops_sync_people_review_route(p_company,v_id,p_chain,null); return v_id; end if;
  insert into ops_performance_reviews(company_id,station_id,station_code,source_date,review_type,source_type,source_batch_id,report_year,report_week,status,started_by,updated_by,routing_version)
  select p_company,p_station,station_code,(p_data->>'source_date')::date,'daily_operations',coalesce(p_data->>'source_type','operational_data'),nullif(p_data->>'source_batch_id','')::uuid,
    extract(year from (p_data->>'source_date')::date)::int,nullif(p_data->>'report_week','')::int,'in_review',p_actor,p_actor,3
  from stations where id=p_station returning id into v_id;
  for v_step in select value from jsonb_array_elements(p_chain) loop
    if v_step->>'routingSource' is distinct from 'people' or nullif(v_step->>'personId','') is null or nullif(v_step->>'assignmentId','') is null or nullif(v_step->>'designationId','') is null or not exists(select 1 from profiles where id=(v_step->>'reviewerUserId')::uuid and company_id=p_company and is_active) then raise exception 'Invalid People reviewer.'; end if;
    v_order=v_order+1;
    insert into ops_performance_review_steps(company_id,review_id,step_order,reviewer_user_id,reviewer_name,reviewer_role,routing_source,routing_person_id,routing_assignment_id,routing_designation_id)
    values(p_company,v_id,v_order,nullif(v_step->>'reviewerUserId','')::uuid,v_step->>'reviewerName',v_step->>'reviewerRole','people',(v_step->>'personId')::uuid,(v_step->>'assignmentId')::uuid,(v_step->>'designationId')::uuid);
  end loop;
  return v_id;
end $$;


revoke all on function public.ops_start_people_review(uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.ops_start_people_review(uuid,uuid,uuid,jsonb,jsonb) to service_role;
-- Forward full route-change evidence into the existing admin Request Tracker when installed.
do $$ begin
  if to_regprocedure('public.request_tracker_capture()') is not null then
    execute 'create trigger request_tracker_people_route after insert on public.ops_review_route_changes for each row execute function public.request_tracker_capture(''ops_review'',''review_id'')';
  end if;
end $$;
notify pgrst, 'reload schema';
commit;
