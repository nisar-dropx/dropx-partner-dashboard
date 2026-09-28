begin;

-- Vehicle 1 is rendered as an unsaved default in Review Desk. These database
-- guards make arrival and unloading compulsory before a review stage can be
-- completed, closed by a final bypass, or saved as a vehicle timing record.
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

create or replace function public.ops_guard_review_vehicle_completion()
returns trigger language plpgsql security invoker set search_path=public as $$
declare v_review ops_performance_reviews;
begin
  if new.status='completed' and old.status is distinct from 'completed' then
    select * into v_review from ops_performance_reviews where id=new.review_id and company_id=new.company_id;
    if found and v_review.review_type='daily_operations' then
      perform public.ops_assert_review_vehicle_details(new.company_id,v_review.station_id,v_review.source_date);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists ops_guard_review_vehicle_completion on public.ops_performance_review_steps;
create trigger ops_guard_review_vehicle_completion before update of status on public.ops_performance_review_steps
  for each row execute function public.ops_guard_review_vehicle_completion();

create or replace function public.ops_guard_review_vehicle_close()
returns trigger language plpgsql security invoker set search_path=public as $$
begin
  if new.status='closed' and old.status is distinct from 'closed' and new.review_type='daily_operations' then
    perform public.ops_assert_review_vehicle_details(new.company_id,new.station_id,new.source_date);
  end if;
  return new;
end $$;
drop trigger if exists ops_guard_review_vehicle_close on public.ops_performance_reviews;
create trigger ops_guard_review_vehicle_close before update of status on public.ops_performance_reviews
  for each row execute function public.ops_guard_review_vehicle_close();

create or replace function public.ops_guard_review_connection_details()
returns trigger language plpgsql security invoker set search_path=public as $$
begin
  if new.arrival_at is null or new.unloading_at is null then
    raise exception 'Enter vehicle arrival and unloading times.';
  end if;
  return new;
end $$;
drop trigger if exists ops_guard_review_connection_details on public.ops_performance_connections;
create trigger ops_guard_review_connection_details before insert or update of arrival_at,unloading_at on public.ops_performance_connections
  for each row execute function public.ops_guard_review_connection_details();

commit;
