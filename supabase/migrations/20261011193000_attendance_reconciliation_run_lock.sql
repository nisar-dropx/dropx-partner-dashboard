-- One reconciliation batch per company may run at a time. Different tenants
-- remain independent, while scheduled and browser-triggered work for the same
-- company cannot rebuild the same daily rows concurrently. Every request gets
-- a fresh token and releases its lease on exit; expiry is only crash recovery.
create table if not exists public.attendance_reconciliation_run_locks (
  company_id uuid primary key references public.companies(id) on delete cascade,
  lease_token uuid not null,
  owner_user_id uuid not null,
  lease_until timestamptz not null,
  updated_at timestamptz not null default clock_timestamp()
);

alter table public.attendance_reconciliation_run_locks enable row level security;
revoke all on table public.attendance_reconciliation_run_locks from public, anon, authenticated;
grant all on table public.attendance_reconciliation_run_locks to service_role;

create or replace function public.attendance_try_acquire_reconciliation_run(
  p_company_id uuid,
  p_token uuid,
  p_owner_user_id uuid,
  p_lease_seconds integer default 360
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz;
  v_claimed integer := 0;
begin
  if p_company_id is null or p_token is null or p_owner_user_id is null then
    raise exception 'Company, operation and owner are required.' using errcode = '22023';
  end if;
  if p_lease_seconds < 60 or p_lease_seconds > 600 then
    raise exception 'Attendance reconciliation lease must be between 60 and 600 seconds.' using errcode = '22023';
  end if;

  -- Serialize the lease decision with both the canonical assignment RPC and
  -- the row trigger below. A mapping mutation that started first finishes
  -- before the repair can read; a repair that starts first blocks the mutation.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('biometric-enrolment-assignment:' || p_company_id::text, 0)
  );
  -- The advisory lock can wait behind a mapping writer. Start the lease only
  -- after that wait so the caller always receives the full requested window.
  v_now := pg_catalog.clock_timestamp();

  insert into public.attendance_reconciliation_run_locks (
    company_id, lease_token, owner_user_id, lease_until, updated_at
  ) values (
    p_company_id,
    p_token,
    p_owner_user_id,
    v_now + make_interval(secs => p_lease_seconds),
    v_now
  )
  on conflict (company_id) do update
    set lease_token = excluded.lease_token,
        owner_user_id = excluded.owner_user_id,
        lease_until = excluded.lease_until,
        updated_at = excluded.updated_at
    where attendance_reconciliation_run_locks.lease_until <= v_now;
  get diagnostics v_claimed = row_count;
  return v_claimed = 1;
end;
$$;

create or replace function public.attendance_release_reconciliation_run(
  p_company_id uuid,
  p_token uuid,
  p_owner_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
begin
  delete from public.attendance_reconciliation_run_locks as run_lock
  where run_lock.company_id = p_company_id
    and run_lock.lease_token = p_token
    and run_lock.owner_user_id = p_owner_user_id;
  get diagnostics v_deleted = row_count;
  return v_deleted = 1;
end;
$$;

revoke all on function public.attendance_try_acquire_reconciliation_run(uuid,uuid,uuid,integer) from public, anon, authenticated;
revoke all on function public.attendance_release_reconciliation_run(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.attendance_try_acquire_reconciliation_run(uuid,uuid,uuid,integer) to service_role;
grant execute on function public.attendance_release_reconciliation_run(uuid,uuid,uuid) to service_role;

create or replace function public.guard_biometric_enrolment_during_reconciliation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_company uuid;
  v_companies uuid[];
begin
  if tg_op = 'INSERT' then
    v_companies := array[new.company_id];
  elsif tg_op = 'DELETE' then
    v_companies := array[old.company_id];
  else
    select array_agg(distinct company_id order by company_id)
    into v_companies
    from unnest(array[old.company_id, new.company_id]) company_id
    where company_id is not null;
  end if;

  foreach v_company in array coalesce(v_companies, '{}'::uuid[]) loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('biometric-enrolment-assignment:' || v_company::text, 0)
    );
    -- The master profile may already have been committed by an existing
    -- application flow. Wait for the short, per-mapping repair lease rather
    -- than rejecting the mapping sync and leaving those two records divergent.
    while exists (
      select 1
      from public.attendance_reconciliation_run_locks run_lock
      where run_lock.company_id = v_company
        and run_lock.lease_until > pg_catalog.clock_timestamp()
    ) loop
      perform pg_catalog.pg_sleep(0.1);
    end loop;
  end loop;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$;

revoke all on function public.guard_biometric_enrolment_during_reconciliation()
  from public, anon, authenticated;
grant execute on function public.guard_biometric_enrolment_during_reconciliation()
  to service_role;

drop trigger if exists biometric_enrolments_reconciliation_guard on public.biometric_enrolments;
create trigger biometric_enrolments_reconciliation_guard
before insert or update or delete on public.biometric_enrolments
for each row execute function public.guard_biometric_enrolment_during_reconciliation();

-- Existing application flows historically saved the master profile and then
-- synchronized biometric_enrolments in a second database call. Make the
-- ownership-changing columns atomic at the database boundary: a collision or
-- timeout now rolls back the profile write as well, instead of committing a
-- profile whose biometric mapping is stale or missing.
create or replace function public.sync_biometric_enrolment_from_master()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_row jsonb := to_jsonb(new);
begin
  perform *
  from public.replace_biometric_enrolment_assignment(
    (v_row ->> 'company_id')::uuid,
    auth.uid(),
    tg_argv[0],
    (v_row ->> 'id')::uuid,
    nullif(v_row ->> 'location_id', '')::uuid
  );
  return new;
end;
$function$;

revoke all on function public.sync_biometric_enrolment_from_master()
  from public, anon, authenticated;

drop trigger if exists employees_biometric_enrolment_sync on public.employees;
create trigger employees_biometric_enrolment_sync
after insert or update of biometric_id, location_id, is_active, date_of_join on public.employees
for each row execute function public.sync_biometric_enrolment_from_master('employee');

drop trigger if exists workforce_biometric_enrolment_sync on public.workforce;
create trigger workforce_biometric_enrolment_sync
after insert or update of biometric_id, location_id, is_active, date_of_join on public.workforce
for each row execute function public.sync_biometric_enrolment_from_master('field_executive');

drop trigger if exists contractors_biometric_enrolment_sync on public.contractors;
create trigger contractors_biometric_enrolment_sync
after insert or update of biometric_id, location_id, is_active, date_of_join on public.contractors
for each row execute function public.sync_biometric_enrolment_from_master('contractor');

drop trigger if exists vendors_biometric_enrolment_sync on public.vendors;
create trigger vendors_biometric_enrolment_sync
after insert or update of biometric_id, location_id, is_active, date_of_join on public.vendors
for each row execute function public.sync_biometric_enrolment_from_master('vendor');

drop trigger if exists helpers_biometric_enrolment_sync on public.helpers;
create trigger helpers_biometric_enrolment_sync
after insert or update of biometric_id, location_id, is_active, date_of_join on public.helpers
for each row execute function public.sync_biometric_enrolment_from_master('worker');

drop trigger if exists workforce_helpers_biometric_enrolment_sync on public.workforce_helpers;
create trigger workforce_helpers_biometric_enrolment_sync
after insert or update of biometric_id, location_id, is_active, date_of_join on public.workforce_helpers
for each row execute function public.sync_biometric_enrolment_from_master('worker');

drop trigger if exists workforce_pickers_biometric_enrolment_sync on public.workforce_pickers;
create trigger workforce_pickers_biometric_enrolment_sync
after insert or update of biometric_id, location_id, is_active, date_of_join on public.workforce_pickers
for each row execute function public.sync_biometric_enrolment_from_master('worker');

notify pgrst, 'reload schema';
