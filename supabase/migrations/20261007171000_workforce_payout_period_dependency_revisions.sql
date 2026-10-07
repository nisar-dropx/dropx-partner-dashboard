begin;

-- Attendance and shipment imports are active throughout the day.  A single
-- company-wide revision made an October punch invalidate an otherwise stable
-- September payout calculation.  Keep static/configuration dependencies on
-- the company revision, and version these two dated fact tables by month.
create table public.workforce_payout_period_dependency_revisions (
  company_id uuid not null references public.companies(id) on delete cascade,
  period_month date not null,
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now(),
  primary key (company_id, period_month),
  constraint workforce_payout_period_dependency_month_start_check
    check (period_month = date_trunc('month', period_month)::date)
);

alter table public.workforce_payout_period_dependency_revisions enable row level security;
revoke all on table public.workforce_payout_period_dependency_revisions
  from public, anon, authenticated;
grant select on table public.workforce_payout_period_dependency_revisions
  to service_role;
create policy workforce_payout_period_dependency_revisions_service_role_select
  on public.workforce_payout_period_dependency_revisions
  for select to service_role using (true);

create or replace function public.workforce_bump_payout_period_dependency_revision(
  p_company_id uuid,
  p_period_month date
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_period_month date;
begin
  if p_company_id is null or p_period_month is null then return; end if;
  v_period_month := date_trunc('month', p_period_month)::date;

  -- Use the same company mutex as recovery. A source write either commits its
  -- revision before recovery validates, or waits until recovery has committed.
  perform public.lock_workforce_payment_allocation_company(p_company_id);
  insert into public.workforce_payout_period_dependency_revisions(
    company_id, period_month, revision, updated_at
  ) values (
    p_company_id, v_period_month, 1, clock_timestamp()
  )
  on conflict (company_id, period_month) do update
    set revision = public.workforce_payout_period_dependency_revisions.revision + 1,
        updated_at = clock_timestamp();
end;
$function$;

create or replace function public.workforce_touch_payout_period_dependency_from_new_rows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_change record;
begin
  for v_change in
    select distinct
      row_data.company_id,
      date_trunc('month', coalesce(
        nullif(to_jsonb(row_data)->>'punch_date', '')::date,
        nullif(to_jsonb(row_data)->>'work_date', '')::date
      ))::date as period_month
    from payout_period_new_rows row_data
    where row_data.company_id is not null
      and coalesce(
        nullif(to_jsonb(row_data)->>'punch_date', '')::date,
        nullif(to_jsonb(row_data)->>'work_date', '')::date
      ) is not null
    order by row_data.company_id, period_month
  loop
    perform public.workforce_bump_payout_period_dependency_revision(
      v_change.company_id,
      v_change.period_month
    );
  end loop;
  return null;
end;
$function$;

create or replace function public.workforce_touch_payout_period_dependency_from_old_rows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_change record;
begin
  for v_change in
    select distinct
      row_data.company_id,
      date_trunc('month', coalesce(
        nullif(to_jsonb(row_data)->>'punch_date', '')::date,
        nullif(to_jsonb(row_data)->>'work_date', '')::date
      ))::date as period_month
    from payout_period_old_rows row_data
    where row_data.company_id is not null
      and coalesce(
        nullif(to_jsonb(row_data)->>'punch_date', '')::date,
        nullif(to_jsonb(row_data)->>'work_date', '')::date
      ) is not null
    order by row_data.company_id, period_month
  loop
    perform public.workforce_bump_payout_period_dependency_revision(
      v_change.company_id,
      v_change.period_month
    );
  end loop;
  return null;
end;
$function$;

create or replace function public.workforce_touch_payout_period_dependency_from_changed_rows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_change record;
begin
  for v_change in
    select distinct
      changed.company_id,
      date_trunc('month', changed.dependency_date)::date as period_month
    from (
      select
        row_data.company_id,
        coalesce(
          nullif(to_jsonb(row_data)->>'punch_date', '')::date,
          nullif(to_jsonb(row_data)->>'work_date', '')::date
        ) as dependency_date
      from payout_period_old_rows row_data
      union
      select
        row_data.company_id,
        coalesce(
          nullif(to_jsonb(row_data)->>'punch_date', '')::date,
          nullif(to_jsonb(row_data)->>'work_date', '')::date
        ) as dependency_date
      from payout_period_new_rows row_data
    ) changed
    where changed.company_id is not null
      and changed.dependency_date is not null
    order by changed.company_id, period_month
  loop
    perform public.workforce_bump_payout_period_dependency_revision(
      v_change.company_id,
      v_change.period_month
    );
  end loop;
  return null;
end;
$function$;

do $block$
declare
  v_table text;
begin
  foreach v_table in array array['attendance_daily', 'cps_shipment_daily']
  loop
    -- Keep the existing company-wide TRUNCATE trigger as a conservative
    -- invalidation. Ordinary inserts/updates/deletes use the dated revision.
    execute format(
      'drop trigger if exists workforce_payout_dependency_revision_insert on public.%I',
      v_table
    );
    execute format(
      'drop trigger if exists workforce_payout_dependency_revision_update on public.%I',
      v_table
    );
    execute format(
      'drop trigger if exists workforce_payout_dependency_revision_delete on public.%I',
      v_table
    );

    execute format(
      'drop trigger if exists workforce_payout_period_dependency_revision_insert on public.%I',
      v_table
    );
    execute format(
      'create trigger workforce_payout_period_dependency_revision_insert '
      || 'after insert on public.%I referencing new table as payout_period_new_rows '
      || 'for each statement execute function public.workforce_touch_payout_period_dependency_from_new_rows()',
      v_table
    );
    execute format(
      'drop trigger if exists workforce_payout_period_dependency_revision_update on public.%I',
      v_table
    );
    execute format(
      'create trigger workforce_payout_period_dependency_revision_update '
      || 'after update on public.%I referencing old table as payout_period_old_rows '
      || 'new table as payout_period_new_rows for each statement '
      || 'execute function public.workforce_touch_payout_period_dependency_from_changed_rows()',
      v_table
    );
    execute format(
      'drop trigger if exists workforce_payout_period_dependency_revision_delete on public.%I',
      v_table
    );
    execute format(
      'create trigger workforce_payout_period_dependency_revision_delete '
      || 'after delete on public.%I referencing old table as payout_period_old_rows '
      || 'for each statement execute function public.workforce_touch_payout_period_dependency_from_old_rows()',
      v_table
    );
  end loop;
end;
$block$;

create or replace function public.workforce_advance_recovery_snapshot_hash(
  p_company_id uuid,
  p_period_start date,
  p_period_end date
)
returns text
language sql
security definer
set search_path = ''
as $function$
  with requested_months as (
    select month_value::date as period_month
    from generate_series(
      date_trunc('month', p_period_start)::date,
      date_trunc('month', p_period_end)::date,
      interval '1 month'
    ) month_value
  ), period_material as (
    select coalesce(string_agg(
      requested.period_month::text || '=' || coalesce(revision.revision, 0)::text,
      ',' order by requested.period_month
    ), '') as value
    from requested_months requested
    left join public.workforce_payout_period_dependency_revisions revision
      on revision.company_id = p_company_id
     and revision.period_month = requested.period_month
  )
  select md5(
    p_company_id::text || ':' ||
    p_period_start::text || ':' ||
    p_period_end::text || ':' ||
    (statement_timestamp() at time zone 'Asia/Kolkata')::date::text || ':' ||
    coalesce(company_revision.revision, 0)::text || ':' ||
    period_material.value
  )
  from period_material
  left join public.workforce_payout_dependency_revisions company_revision
    on company_revision.company_id = p_company_id;
$function$;

comment on table public.workforce_payout_period_dependency_revisions is
  'Month-scoped material versions for high-frequency dated payout facts, preventing unrelated months from invalidating advance recovery calculations.';
comment on function public.workforce_advance_recovery_snapshot_hash(uuid, date, date) is
  'Combines company-wide payout configuration state with month-scoped attendance and shipment revisions for a recovery period.';

revoke all on function
  public.workforce_bump_payout_period_dependency_revision(uuid, date),
  public.workforce_touch_payout_period_dependency_from_new_rows(),
  public.workforce_touch_payout_period_dependency_from_old_rows(),
  public.workforce_touch_payout_period_dependency_from_changed_rows(),
  public.workforce_advance_recovery_snapshot_hash(uuid, date, date)
from public, anon, authenticated, service_role;
grant execute on function public.workforce_advance_recovery_snapshot_hash(uuid, date, date)
to service_role;

notify pgrst, 'reload schema';

commit;
