begin;

-- EMD at 12 p.m. is a required station-day input alongside Vehicle 1.
create or replace function public.ops_assert_review_station_inputs(p_company uuid,p_station uuid,p_date date)
returns void language plpgsql security invoker set search_path=public as $$
begin
  perform public.ops_assert_review_vehicle_details(p_company,p_station,p_date);
  if not exists (
    select 1 from ops_performance_daily_inputs
    where company_id=p_company and station_id=p_station and source_date=p_date
      and emd_noon_pct is not null
  ) then
    raise exception 'Record EMD at 12 p.m. before completing this review.';
  end if;
end $$;
revoke all on function public.ops_assert_review_station_inputs(uuid,uuid,date) from public,anon,authenticated;
grant execute on function public.ops_assert_review_station_inputs(uuid,uuid,date) to service_role;

create or replace function public.ops_guard_review_vehicle_completion()
returns trigger language plpgsql security invoker set search_path=public as $$
declare v_review ops_performance_reviews;
begin
  if new.status='completed' and old.status is distinct from 'completed' then
    select * into v_review from ops_performance_reviews where id=new.review_id and company_id=new.company_id;
    if found and v_review.review_type='daily_operations' then
      perform public.ops_assert_review_station_inputs(new.company_id,v_review.station_id,v_review.source_date);
    end if;
  end if;
  return new;
end $$;

create or replace function public.ops_guard_review_vehicle_close()
returns trigger language plpgsql security invoker set search_path=public as $$
begin
  if new.status='closed' and old.status is distinct from 'closed' and new.review_type='daily_operations' then
    perform public.ops_assert_review_station_inputs(new.company_id,new.station_id,new.source_date);
  end if;
  return new;
end $$;

commit;
