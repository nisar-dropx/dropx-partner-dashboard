begin;

-- Retain historical clearance values for audit, but no longer edit or validate
-- this retired field against current arrival/unloading corrections.
alter table public.ops_performance_connections
  drop constraint if exists ops_performance_connections_check2;
comment on column public.ops_performance_connections.clearance_at is
  'Legacy manual vehicle clearance. Retained for audit only; use station EDD history for clearance.';

create or replace function public.ops_save_review_connection(p_company uuid,p_actor uuid,p_station uuid,p_data jsonb)
returns uuid language plpgsql security invoker set search_path=public as $$
declare v_id uuid=nullif(p_data->>'id','')::uuid;
begin
  if not exists(select 1 from profiles where id=p_actor and company_id=p_company and is_active)
    or not exists(select 1 from stations where id=p_station and company_id=p_company and is_active)
    then raise exception 'Station access unavailable.'; end if;
  if v_id is null then
    insert into ops_performance_connections(company_id,station_id,service_date,label,arrival_at,unloading_at,created_by,updated_by,updated_by_name)
    values(p_company,p_station,(p_data->>'service_date')::date,p_data->>'label',(p_data->>'arrival')::timestamptz,nullif(p_data->>'unloading','')::timestamptz,p_actor,p_actor,p_data->>'author_name') returning id into v_id;
  else
    update ops_performance_connections set label=p_data->>'label',arrival_at=(p_data->>'arrival')::timestamptz,unloading_at=nullif(p_data->>'unloading','')::timestamptz,
      version=version+1,updated_by=p_actor,updated_by_name=p_data->>'author_name',updated_at=now()
    where id=v_id and company_id=p_company and station_id=p_station and service_date=(p_data->>'service_date')::date and version=(p_data->>'version')::int;
    if not found then raise exception 'This connection was updated by someone else. Refresh and try again.'; end if;
  end if;
  return v_id;
end $$;

revoke all on function public.ops_save_review_connection(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.ops_save_review_connection(uuid,uuid,uuid,jsonb) to service_role;
commit;
