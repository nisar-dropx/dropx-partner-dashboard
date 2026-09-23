-- Row-based (not session-advisory) run lock for the minute-tick EDD refresh
-- cron. Supabase RPC calls are stateless over pooled/pgbouncer connections, so
-- pg_advisory_lock/unlock cannot be trusted to hold across the two separate
-- HTTP calls a Node process would need to acquire and release it. A leased
-- row survives connection reuse and expires on its own if a process crashes
-- mid-run, following the same lease pattern already used by
-- ops_review_edd_refresh_jobs.
--
-- Root cause this fixes: the refresh job's internal deadline (~270s) can
-- outlive the 60s cron interval, so overlapping invocations were each
-- spawning their own two claim lanes and contending the same transaction
-- advisory lock inside edd_claim_review_source, tripping statement timeouts.
create table if not exists public.ops_review_edd_refresh_run_lock (
  lock_key text primary key,
  lease_token uuid not null,
  lease_until timestamptz not null
);

create or replace function public.edd_try_acquire_refresh_run(p_token uuid, p_lease_seconds int default 55)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
begin
  insert into public.ops_review_edd_refresh_run_lock (lock_key, lease_token, lease_until)
  values ('opspulse-edd-source-refresh-run', p_token, v_now + make_interval(secs => p_lease_seconds))
  on conflict (lock_key) do update
    set lease_token = excluded.lease_token, lease_until = excluded.lease_until
    where ops_review_edd_refresh_run_lock.lease_until <= v_now;
  return found;
end;
$$;

create or replace function public.edd_release_refresh_run(p_token uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.ops_review_edd_refresh_run_lock
  where lock_key = 'opspulse-edd-source-refresh-run' and lease_token = p_token;
$$;

grant execute on function public.edd_try_acquire_refresh_run(uuid, int) to service_role;
grant execute on function public.edd_release_refresh_run(uuid) to service_role;
