-- Retry eligibility still honors backoff. Among eligible jobs, protect the
-- station with the oldest (or never collected) data before refreshing newer data.
create or replace function public.edd_claim_review_source(p_token uuid)
returns setof public.ops_review_edd_refresh_jobs
language plpgsql security invoker set search_path = '' as $$
declare v_now timestamptz;
begin
  if p_token is null then raise exception 'A lease token is required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('opspulse-edd-source-refresh', 0));
  v_now := clock_timestamp();
  -- A commit may have succeeded even when the HTTP client timed out.
  if exists (select 1 from public.ops_review_edd_refresh_jobs where lease_token = p_token and lease_until > v_now) then
    return query select * from public.ops_review_edd_refresh_jobs where lease_token = p_token and lease_until > v_now;
    return;
  end if;
  insert into public.ops_review_edd_refresh_jobs(station_code, source)
  select c.station_code, feed.source from (
    select station_code from public.edd_station_snapshots
    union select station_code from public.edd_performance_snapshots
  ) c cross join (values ('stock'), ('outcomes')) feed(source)
  where c.station_code is not null and c.station_code <> ''
  on conflict (station_code, source) do nothing;
  if (select count(*) from public.ops_review_edd_refresh_jobs where lease_until > v_now) >= 2 then return; end if;
  return query
  update public.ops_review_edd_refresh_jobs j
  set lease_token = p_token, lease_until = v_now + interval '5 minutes',
      last_attempt_at = v_now, attempts = j.attempts + 1
  where (j.station_code, j.source) = (
    select q.station_code, q.source from public.ops_review_edd_refresh_jobs q
    where q.next_attempt_at <= v_now and (q.lease_until is null or q.lease_until <= v_now)
      and not exists (select 1 from public.ops_review_edd_refresh_jobs other
        where other.station_code = q.station_code and other.lease_until > v_now)
    order by q.source_at asc nulls first, q.last_attempt_at asc nulls first,
      q.next_attempt_at, q.station_code, q.source
    limit 1 for update skip locked
  ) returning j.*;
end;
$$;
revoke all on function public.edd_claim_review_source(uuid) from public, anon, authenticated;
grant execute on function public.edd_claim_review_source(uuid) to service_role;
