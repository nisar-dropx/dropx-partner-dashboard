begin;

-- Dark Store reviews use Store Health (qc_store_health_daily). The app already skips
-- Vehicle 1 / noon EMD on complete for that source, but the DB completion/close
-- triggers still required them for every daily_operations review. Align the guards.

create or replace function public.ops_guard_review_vehicle_completion()
returns trigger language plpgsql security invoker set search_path=public as $$
declare v_review ops_performance_reviews;
begin
  if new.status='completed' and old.status is distinct from 'completed' then
    select * into v_review from ops_performance_reviews where id=new.review_id and company_id=new.company_id;
    if found
      and v_review.review_type='daily_operations'
      and coalesce(v_review.source_type,'') is distinct from 'qc_store_health_daily'
    then
      perform public.ops_assert_review_station_inputs(new.company_id,v_review.station_id,v_review.source_date);
    end if;
  end if;
  return new;
end $$;

create or replace function public.ops_guard_review_vehicle_close()
returns trigger language plpgsql security invoker set search_path=public as $$
begin
  if new.status='closed'
    and old.status is distinct from 'closed'
    and new.review_type='daily_operations'
    and coalesce(new.source_type,'') is distinct from 'qc_store_health_daily'
  then
    perform public.ops_assert_review_station_inputs(new.company_id,new.station_id,new.source_date);
  end if;
  return new;
end $$;

commit;
