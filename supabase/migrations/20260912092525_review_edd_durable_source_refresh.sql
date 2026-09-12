-- Service-only, resumable refresh work. No customer data or shared Amazon login
-- credentials are stored here. A failed feed never discards the other feed.
create table public.ops_review_edd_refresh_jobs (
  station_code text not null,
  source text not null check (source in ('stock', 'outcomes')),
  next_attempt_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  source_at timestamptz,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text check (last_error in ('login_busy','upstream_502','timeout','stale_response','upstream_error')),
  lease_token uuid,
  lease_until timestamptz,
  primary key (station_code, source),
  check ((lease_token is null) = (lease_until is null))
);
create index ops_review_edd_refresh_due_idx on public.ops_review_edd_refresh_jobs(next_attempt_at);
alter table public.ops_review_edd_refresh_jobs enable row level security;
revoke all on public.ops_review_edd_refresh_jobs from public, anon, authenticated;
grant select, insert, update on public.ops_review_edd_refresh_jobs to service_role;
comment on table public.ops_review_edd_refresh_jobs is 'Persistent stock/outcome refresh jobs for every tracked EDD station. Retries never have a terminal discard state. Not an as-of checkpoint or proof of live data.';

create function public.edd_claim_review_source(p_token uuid)
returns setof public.ops_review_edd_refresh_jobs
language plpgsql security invoker set search_path = '' as $$
declare v_now timestamptz := clock_timestamp();
begin
  if p_token is null then raise exception 'A lease token is required'; end if;
  -- Serialise only this short claim transaction, never the upstream HTTP call.
  -- This enforces TWO GLOBAL lanes even across overlapping cron invocations.
  perform pg_advisory_xact_lock(hashtextextended('opspulse-edd-source-refresh', 0));
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
  set lease_token = p_token, lease_until = v_now + interval '4 minutes',
      last_attempt_at = v_now, attempts = j.attempts + 1
  where (j.station_code, j.source) = (
    select q.station_code, q.source from public.ops_review_edd_refresh_jobs q
    where q.next_attempt_at <= v_now and (q.lease_until is null or q.lease_until <= v_now)
      -- Never race stock and outcomes for the same station/session.
      and not exists (select 1 from public.ops_review_edd_refresh_jobs other
        where other.station_code = q.station_code and other.lease_until > v_now)
    order by q.next_attempt_at, q.last_attempt_at nulls first, q.station_code, q.source
    limit 1 for update skip locked
  ) returning j.*;
end;
$$;

create function public.edd_finish_review_source(p_station_code text, p_source text, p_token uuid, p_source_at timestamptz, p_error text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_now timestamptz := clock_timestamp(); v_count integer;
begin
  if p_error is null and (p_source_at is null or p_source_at > v_now or p_source_at < v_now - interval '15 minutes') then
    raise exception 'A fresh source timestamp is required';
  end if;
  update public.ops_review_edd_refresh_jobs j set
    source_at = case when p_error is null then p_source_at else j.source_at end,
    last_success_at = case when p_error is null then v_now else j.last_success_at end,
    consecutive_failures = case when p_error is null then 0 else j.consecutive_failures + 1 end,
    last_error = p_error, lease_token = null, lease_until = null,
    -- Normal work is due every 15 minutes; only failed work uses the minute
    -- recovery tick. Capped backoff prevents upstream outages being hammered.
    next_attempt_at = case when p_error is null then v_now + interval '15 minutes'
      else v_now + make_interval(secs => least(300, 60 * (1 << least(j.consecutive_failures, 3)))) end
  where j.station_code = p_station_code and j.source = p_source and j.lease_token = p_token
    and j.lease_until > v_now;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;
revoke all on function public.edd_claim_review_source(uuid) from public, anon, authenticated;
revoke all on function public.edd_finish_review_source(text,text,uuid,timestamptz,text) from public, anon, authenticated;
grant execute on function public.edd_claim_review_source(uuid) to service_role;
grant execute on function public.edd_finish_review_source(text,text,uuid,timestamptz,text) to service_role;
