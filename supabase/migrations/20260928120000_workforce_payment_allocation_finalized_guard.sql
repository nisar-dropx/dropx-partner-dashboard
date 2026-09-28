begin;

alter table public.workforce_payroll_runs
  add column if not exists direct_allocation_snapshot_hash text;

create or replace function public.lock_workforce_payment_allocation_company(
  p_company_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_company_id is null then
    raise exception 'Company is required for direct payment allocation locking.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'workforce-payment-allocation-company:' || p_company_id::text,
    0
  ));
end;
$$;

create or replace function public.workforce_payment_allocation_snapshot_hash(
  p_company_id uuid,
  p_period_start date,
  p_period_end date
)
returns text
language sql
security definer
set search_path = ''
as $$
  select md5(coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', allocation.id::text,
        'workforce_id', allocation.workforce_id::text,
        'station_id', allocation.station_id::text,
        'designation_id', allocation.designation_id::text,
        'payment_method_id', allocation.payment_method_id::text,
        'effective_from', allocation.effective_from,
        'effective_to', allocation.effective_to,
        'status', allocation.status,
        'payment_values', allocation.payment_values,
        'payment_components', allocation.payment_components,
        'updated_at_epoch', extract(epoch from allocation.updated_at)
      )
      order by allocation.id
    )::text,
    '[]'
  ))
  from public.workforce_payment_allocations allocation
  where allocation.company_id = p_company_id
    and daterange(
      allocation.effective_from,
      coalesce(allocation.effective_to, 'infinity'::date),
      '[]'
    ) && daterange(p_period_start, p_period_end, '[]');
$$;

create or replace function public.capture_workforce_direct_allocation_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.calculated_at is null then
    new.direct_allocation_snapshot_hash := null;
  else
    -- Capture under the same lock order used by confirmation so the digest is a
    -- stable material version of the period's allocations.
    perform 1
    from public.workforce workforce
    where workforce.company_id = new.company_id
    order by workforce.id
    for update;

    perform public.lock_workforce_payment_allocation_company(new.company_id);
    lock table public.workforce_payment_allocations in share mode;

    new.direct_allocation_snapshot_hash := public.workforce_payment_allocation_snapshot_hash(
      new.company_id,
      new.period_start,
      new.period_end
    );
  end if;
  return new;
end;
$$;

create or replace function public.guard_finalized_workforce_payment_allocation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_old_range daterange;
  v_new_range daterange;
  v_definition_changed boolean := false;
begin
  if tg_op = 'DELETE' then
    raise exception 'Direct payment allocation history cannot be deleted. Close or cancel it with an effective-dated correction.';
  end if;

  -- Payroll confirmation locks the participating workforce rows before changing
  -- a run to review/approved/paid (workforce_adhoc_payroll_gate). Take the same
  -- row lock before inspecting run status so a concurrent allocation write is
  -- ordered either wholly before or wholly after that confirmation. In the
  -- latter case the status checks below see the committed finalized run.
  if tg_op = 'INSERT' then
    perform 1
    from public.workforce workforce
    where workforce.company_id = new.company_id
      and workforce.id = new.workforce_id
    for update;

    perform public.lock_workforce_payment_allocation_company(new.company_id);
  else
    -- Raw DML can change the allocation identity. Lock both identities in a
    -- deterministic order to keep cross-worker corrections deadlock-safe.
    perform 1
    from public.workforce workforce
    where (workforce.company_id = old.company_id and workforce.id = old.workforce_id)
       or (workforce.company_id = new.company_id and workforce.id = new.workforce_id)
    order by workforce.company_id, workforce.id
    for update;

    -- Workforce rows above serialize cross-company identity corrections, so
    -- acquiring the company locks in UUID order is deterministic as well.
    if old.company_id::text <= new.company_id::text then
      perform public.lock_workforce_payment_allocation_company(old.company_id);
      if new.company_id is distinct from old.company_id then
        perform public.lock_workforce_payment_allocation_company(new.company_id);
      end if;
    else
      perform public.lock_workforce_payment_allocation_company(new.company_id);
      perform public.lock_workforce_payment_allocation_company(old.company_id);
    end if;
  end if;

  -- clock_timestamp(), unlike now(), is not frozen at transaction start. This
  -- records the write after it obtains the company mutex, so confirmation can
  -- reliably detect a transaction that began before calculation but wrote later.
  new.updated_at := clock_timestamp();

  if tg_op = 'INSERT' then
    if new.status <> 'cancelled'
      and exists (
        select 1
        from public.workforce_payroll_runs payroll_run
        where payroll_run.company_id = new.company_id
          and lower(coalesce(payroll_run.status, '')) in ('approved', 'paid')
          and daterange(payroll_run.period_start, payroll_run.period_end, '[]')
            && daterange(new.effective_from, coalesce(new.effective_to, 'infinity'::date), '[]')
      ) then
      raise exception 'Finalized Workforce payroll exists for this period. Start the direct payment allocation after the approved or paid payroll period.';
    end if;
    return new;
  end if;

  v_old_range := daterange(old.effective_from, coalesce(old.effective_to, 'infinity'::date), '[]');

  v_new_range := daterange(new.effective_from, coalesce(new.effective_to, 'infinity'::date), '[]');
  v_definition_changed := row(
    new.company_id,
    new.workforce_id,
    new.station_id,
    new.station_code_snapshot,
    new.designation_id,
    new.designation_code_snapshot,
    new.designation_name_snapshot,
    new.payment_method_id,
    new.payment_values,
    new.payment_components,
    new.effective_from
  ) is distinct from row(
    old.company_id,
    old.workforce_id,
    old.station_id,
    old.station_code_snapshot,
    old.designation_id,
    old.designation_code_snapshot,
    old.designation_name_snapshot,
    old.payment_method_id,
    old.payment_values,
    old.payment_components,
    old.effective_from
  );

  if v_definition_changed
    and (
      (old.status <> 'cancelled' and exists (
        select 1
        from public.workforce_payroll_runs payroll_run
        where payroll_run.company_id = old.company_id
          and lower(coalesce(payroll_run.status, '')) in ('approved', 'paid')
          and daterange(payroll_run.period_start, payroll_run.period_end, '[]') && v_old_range
      ))
      or
      (new.status <> 'cancelled' and exists (
        select 1
        from public.workforce_payroll_runs payroll_run
        where payroll_run.company_id = new.company_id
          and lower(coalesce(payroll_run.status, '')) in ('approved', 'paid')
          and daterange(payroll_run.period_start, payroll_run.period_end, '[]') && v_new_range
      ))
    ) then
    raise exception 'Finalized Workforce payroll uses this direct payment allocation. Create a later effective-dated version instead of changing historical payment terms.';
  end if;

  if exists (
    select 1
    from public.workforce_payroll_runs payroll_run
    where lower(coalesce(payroll_run.status, '')) in ('approved', 'paid')
      and payroll_run.company_id in (old.company_id, new.company_id)
      and (
        case
          when payroll_run.company_id = old.company_id
            and old.status <> 'cancelled'
            and daterange(payroll_run.period_start, payroll_run.period_end, '[]') && v_old_range
          then daterange(payroll_run.period_start, payroll_run.period_end, '[]') * v_old_range
          else 'empty'::daterange
        end
      ) is distinct from (
        case
          when payroll_run.company_id = new.company_id
            and new.status <> 'cancelled'
            and daterange(payroll_run.period_start, payroll_run.period_end, '[]') && v_new_range
          then daterange(payroll_run.period_start, payroll_run.period_end, '[]') * v_new_range
          else 'empty'::daterange
        end
      )
  ) then
    raise exception 'Finalized Workforce payroll uses this allocation period. End or cancel it only after the approved or paid payroll period.';
  end if;

  return new;
end;
$$;

-- Replace the earlier Adhoc DA confirmation gate with a superset that uses one
-- lock order for every source of Workforce pay: company Workforce rows first,
-- the shared company transaction lock second, then the direct-allocation table.
-- A write committed before confirmation is detected by the clock timestamp;
-- a write that starts later waits and is rejected by the finalized-run guard.
create or replace function public.workforce_adhoc_payroll_gate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_direct_allocation_snapshot_hash text;
begin
  if lower(coalesce(new.status, '')) in ('review', 'approved', 'paid')
    and new.status is distinct from old.status then
    if new.calculated_at is null then
      raise exception 'Workforce payroll must be calculated before review, approval or payment. Recalculate this payroll and try again.';
    end if;
    if new.direct_allocation_snapshot_hash is null then
      raise exception 'Direct payment allocations were not captured with this payroll calculation. Return to draft and recalculate before confirmation.';
    end if;

    -- Lock every company workforce identity, not only the rows already present
    -- in payroll items: a new direct allocation may introduce a worker that the
    -- stale calculation did not include.
    perform 1
    from public.workforce workforce
    where workforce.company_id = new.company_id
    order by workforce.id
    for update;

    perform public.lock_workforce_payment_allocation_company(new.company_id);

    -- SHARE conflicts with allocation writes but permits readers. All supported
    -- writers acquire their Workforce row before touching this table, matching
    -- the order above and preventing a lock inversion.
    lock table public.workforce_payment_allocations in share mode;

    v_direct_allocation_snapshot_hash := public.workforce_payment_allocation_snapshot_hash(
      new.company_id,
      new.period_start,
      new.period_end
    );

    if v_direct_allocation_snapshot_hash is distinct from new.direct_allocation_snapshot_hash then
      raise exception 'Direct payment allocations changed after this payroll was calculated. Return to draft and recalculate before confirmation.';
    end if;

    -- Preserve the existing Adhoc DA protection installed by
    -- 20260923143000_adhoc_da_payment_tracking.sql.
    if exists (
      select 1
      from public.workforce_adjustments adjustment
      join public.workforce_payroll_items payroll_item
        on payroll_item.workforce_id = adjustment.workforce_id
       and payroll_item.company_id = adjustment.company_id
      where payroll_item.payroll_run_id = new.id
        and payroll_item.status <> 'excluded'
        and adjustment.external_reference like 'OPS-ADHOC-DA:%'
        and adjustment.status = 'approved'
        and adjustment.payroll_run_id is null
        and adjustment.effective_date between new.period_start and new.period_end
    ) then
      raise exception 'A paid Adhoc DA deduction is missing from this payroll. Return to draft and recalculate before confirmation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists workforce_00_direct_allocation_snapshot_insert
  on public.workforce_payroll_runs;
create trigger workforce_00_direct_allocation_snapshot_insert
before insert
on public.workforce_payroll_runs
for each row execute function public.capture_workforce_direct_allocation_snapshot();

drop trigger if exists workforce_00_direct_allocation_snapshot_calculation
  on public.workforce_payroll_runs;
create trigger workforce_00_direct_allocation_snapshot_calculation
before update of calculated_at, company_id, period_start, period_end
on public.workforce_payroll_runs
for each row execute function public.capture_workforce_direct_allocation_snapshot();

-- Existing finalized runs are already immutable, so recording their current
-- period snapshot is safe. Mutable calculated runs intentionally remain NULL
-- and must be recalculated once before their next confirmation transition.
do $$
declare
  v_company_id uuid;
begin
  perform 1
  from public.workforce workforce
  order by workforce.company_id, workforce.id
  for update;

  for v_company_id in
    select distinct payroll_run.company_id
    from public.workforce_payroll_runs payroll_run
    order by payroll_run.company_id
  loop
    perform public.lock_workforce_payment_allocation_company(v_company_id);
  end loop;

  lock table public.workforce_payment_allocations in share mode;

  update public.workforce_payroll_runs payroll_run
  set direct_allocation_snapshot_hash = case
    when payroll_run.calculated_at is not null
      and lower(coalesce(payroll_run.status, '')) in ('approved', 'paid')
    then public.workforce_payment_allocation_snapshot_hash(
      payroll_run.company_id,
      payroll_run.period_start,
      payroll_run.period_end
    )
    else null
  end;
end;
$$;

drop trigger if exists workforce_payment_allocations_finalized_guard
  on public.workforce_payment_allocations;
create trigger workforce_payment_allocations_finalized_guard
before insert or update or delete
on public.workforce_payment_allocations
for each row execute function public.guard_finalized_workforce_payment_allocation();

drop trigger if exists workforce_adhoc_payroll_gate
  on public.workforce_payroll_runs;
create trigger workforce_adhoc_payroll_gate
before update of status
on public.workforce_payroll_runs
for each row execute function public.workforce_adhoc_payroll_gate();

comment on function public.guard_finalized_workforce_payment_allocation() is
  'Serializes allocation writes with Workforce payroll confirmation and prevents a direct-pay allocation from retroactively changing a company pay period after Workforce marks its payroll approved or paid. Draft and review runs remain correctable.';

comment on function public.lock_workforce_payment_allocation_company(uuid) is
  'Transaction-scoped company mutex shared by direct-allocation writes and Workforce payroll confirmation.';

comment on function public.workforce_payment_allocation_snapshot_hash(uuid, date, date) is
  'Deterministic material hash of direct allocations whose effective ranges overlap one Workforce payroll period.';

comment on function public.capture_workforce_direct_allocation_snapshot() is
  'Captures the period-scoped direct-allocation hash whenever Workforce payroll calculated_at is set or refreshed.';

comment on column public.workforce_payroll_runs.direct_allocation_snapshot_hash is
  'Material direct-allocation version captured by payroll calculation and required unchanged at review, approval and payment.';

comment on function public.workforce_adhoc_payroll_gate() is
  'Serializes Workforce payroll confirmation against direct-allocation writes, requires a fresh calculation, and preserves the Adhoc DA deduction completeness check.';

revoke all on function public.lock_workforce_payment_allocation_company(uuid),
  public.workforce_payment_allocation_snapshot_hash(uuid, date, date),
  public.capture_workforce_direct_allocation_snapshot(),
  public.guard_finalized_workforce_payment_allocation(),
  public.workforce_adhoc_payroll_gate()
  from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
