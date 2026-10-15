begin;

-- The original save RPC identifies the allocation to edit from the submitted
-- effective date. That works when a new period starts inside the current one,
-- but an earlier correction cannot find the current row and attempts to insert
-- a second open allocation. Accept the row rendered by the UI so an earlier
-- start-date correction updates that row in place.
-- Remove the pre-concurrency-token draft signature if it was ever applied
-- manually before this migration was finalized. Keeping both overloads would
-- make short PostgREST calls ambiguous.
drop function if exists public.save_workforce_payment_allocation_v3(
  uuid, uuid, uuid, jsonb, date, date, text, uuid, uuid
);

create or replace function public.save_workforce_payment_allocation_v3(
  p_company_id uuid,
  p_workforce_id uuid,
  p_payment_method_id uuid,
  p_payment_values jsonb,
  p_effective_from date,
  p_effective_to date default null,
  p_change_reason text default null,
  p_actor_user_id uuid default null,
  p_allocation_id uuid default null,
  p_expected_updated_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_target public.workforce_payment_allocations%rowtype;
  v_result_id uuid;
begin
  -- Match save_workforce_payment_allocation_v2's outer lock first, followed by
  -- the Workforce row and the per-person advisory lock used by the base save.
  -- Keeping the same order makes the date correction and normal save one
  -- serializable operation without introducing a competing lock path.
  perform pg_advisory_xact_lock(hashtextextended(
    'workforce-payment-basis:' || p_company_id::text,
    0
  ));

  perform 1
  from public.workforce workforce
  where workforce.company_id = p_company_id
    and workforce.id = p_workforce_id
  for update;

  if not found then
    raise exception 'Workforce member does not belong to this company.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    p_company_id::text || ':' || p_workforce_id::text,
    0
  ));

  if p_allocation_id is not null then
    select allocation.*
    into v_target
    from public.workforce_payment_allocations allocation
    where allocation.id = p_allocation_id
      and allocation.company_id = p_company_id
      and allocation.workforce_id = p_workforce_id
      and allocation.status <> 'cancelled'
    for update;

    if not found then
      raise exception 'The direct payment allocation changed. Refresh the page and try again.';
    end if;

    if p_expected_updated_at is null
      or v_target.updated_at is distinct from p_expected_updated_at then
      raise exception 'The direct payment allocation changed. Refresh the page and try again.';
    end if;

    if p_effective_from < v_target.effective_from then
      -- Do not silently erase a complete historical period. A correction may
      -- shorten the immediately preceding period, but crossing one or more
      -- entire periods must be handled as explicit period edits.
      if exists (
        select 1
        from public.workforce_payment_allocations allocation
        where allocation.company_id = p_company_id
          and allocation.workforce_id = p_workforce_id
          and allocation.id <> v_target.id
          and allocation.status <> 'cancelled'
          and allocation.effective_from >= p_effective_from
          and allocation.effective_from < v_target.effective_from
      ) then
        raise exception 'The corrected effective-from date crosses an earlier payment period. Edit the payment periods separately.';
      end if;

      -- If the corrected boundary lands inside the preceding period, retain
      -- that history through the preceding day and hand over from the revised
      -- date. Finalized/bank-processing guards still apply to this update.
      update public.workforce_payment_allocations allocation
      set effective_to = p_effective_from - 1,
          status = 'closed',
          transition_restore_state = null,
          change_reason = concat_ws(
            ' | ',
            nullif(btrim(allocation.change_reason), ''),
            'Automatically shortened after correcting the following direct payment allocation start date.'
          ),
          updated_by = p_actor_user_id,
          updated_at = now()
      where allocation.company_id = p_company_id
        and allocation.workforce_id = p_workforce_id
        and allocation.id <> v_target.id
        and allocation.status <> 'cancelled'
        and allocation.effective_from < p_effective_from
        and (allocation.effective_to is null or allocation.effective_to >= p_effective_from);

      update public.workforce_payment_allocations
      set effective_from = p_effective_from,
          updated_by = p_actor_user_id,
          updated_at = now()
      where id = v_target.id;
    elsif p_effective_from > v_target.effective_from
      and v_target.effective_to is not null
      and p_effective_from > v_target.effective_to then
      raise exception 'The effective-from date is outside this payment period. Refresh the page and edit the applicable period.';
    end if;
  end if;

  -- The existing save remains authoritative for eligibility, payment-method
  -- validation, snapshots, end dates, employment cutoffs and payout locks.
  v_result_id := public.save_workforce_payment_allocation_v2(
    p_company_id,
    p_workforce_id,
    p_payment_method_id,
    p_payment_values,
    p_effective_from,
    p_effective_to,
    p_change_reason,
    p_actor_user_id
  );

  return v_result_id;
end;
$$;

revoke all on function public.save_workforce_payment_allocation_v3(uuid, uuid, uuid, jsonb, date, date, text, uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.save_workforce_payment_allocation_v3(uuid, uuid, uuid, jsonb, date, date, text, uuid, uuid, timestamptz)
  to service_role;

comment on function public.save_workforce_payment_allocation_v3(uuid, uuid, uuid, jsonb, date, date, text, uuid, uuid, timestamptz) is
  'Saves a direct payment allocation by stable row identity, including safe corrections that move the current allocation start date earlier.';

notify pgrst, 'reload schema';

commit;
