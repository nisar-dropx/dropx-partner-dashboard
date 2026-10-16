-- Keep immutable bank-instruction allocations for provenance checks, but use
-- the amount actually settled by the bank when calculating a paid station's
-- balance and lifecycle status.  The settlement-evidence migration corrected
-- profile totals and read-only history, but the station candidate still used
-- instruction_amount_snapshot for its paid amount.
do $patch_workforce_partial_settlement_station_balance$
declare
  v_signature regprocedure :=
    'public.workforce_payout_payment_row_candidates(uuid,date,date,jsonb)'::regprocedure;
  v_definition text;
  v_old text;
  v_new text;
begin
  select replace(pg_get_functiondef(v_signature), chr(13), '')
  into v_definition;

  -- A migration is normally applied once.  This marker also makes a replay
  -- safe after an interrupted deployment that already replaced the function.
  if position('as paid_settled_amount_snapshot' in v_definition) > 0 then
    return;
  end if;

  -- Paid history owns two different values: the immutable instruction total
  -- used to validate its allocation rows, and the actual settled total used
  -- for accounting.  Restore the former here; the latter is added below.
  v_old := replace($old$
        round(sum(effective.settled_amount_snapshot), 2) as instruction_amount
$old$, chr(13), '');
  v_new := replace($new$
        round(sum(effective.instruction_amount_snapshot), 2) as instruction_amount
$new$, chr(13), '');
  if position(v_old in v_definition) = 0 then
    raise exception 'Unexpected Workforce paid history-item structure; partial settlement accounting was not installed.';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  -- Resolve the effective settled allocation through the current paid-credit
  -- owner.  This preserves payment-history transfers as well as ordinary paid
  -- rows, while processing rows continue to use their immutable instruction.
  v_old := replace($old$
        allocation.instruction_amount_snapshot,
        current_station.station_id as current_station_id,
$old$, chr(13), '');
  v_new := replace($new$
        allocation.instruction_amount_snapshot,
        case when history_item.status = 'paid' then coalesce((
          select effective.settled_amount_snapshot
          from public.workforce_payout_effective_paid_allocations effective
          where effective.company_id = allocation.company_id
            and effective.payment_allocation_id = allocation.id
            and effective.credited_workforce_id = v_workforce_id
        ), 0) else 0 end::numeric(14,2) as paid_settled_amount_snapshot,
        current_station.station_id as current_station_id,
$new$, chr(13), '');
  if position(v_old in v_definition) = 0 then
    raise exception 'Unexpected Workforce allocation-row structure; partial settlement accounting was not installed.';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  -- A station's paid value is its actual settlement.  Processing remains the
  -- original instruction and item integrity below still checks the immutable
  -- allocation snapshots against the immutable item instruction.
  v_old := replace($old$
        round(coalesce(sum(allocation_row.instruction_amount_snapshot) filter (
          where allocation_row.status = 'paid'
            and allocation_row.station_id = current_station.station_id
        ), 0), 2) as paid_amount,
$old$, chr(13), '');
  v_new := replace($new$
        round(coalesce(sum(allocation_row.paid_settled_amount_snapshot) filter (
          where allocation_row.status = 'paid'
            and allocation_row.station_id = current_station.station_id
        ), 0), 2) as paid_amount,
$new$, chr(13), '');
  if position(v_old in v_definition) = 0 then
    raise exception 'Unexpected Workforce station paid-total structure; partial settlement accounting was not installed.';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := replace($old$
        and round(coalesce((select sum(allocation_row.instruction_amount_snapshot)
          from allocation_rows allocation_row where allocation_row.status = 'paid'), 0), 2)
          = round(v_profile_paid, 2)
$old$, chr(13), '');
  v_new := replace($new$
        and round(coalesce((select sum(allocation_row.paid_settled_amount_snapshot)
          from allocation_rows allocation_row where allocation_row.status = 'paid'), 0), 2)
          = round(v_profile_paid, 2)
$new$, chr(13), '');
  if position(v_old in v_definition) = 0 then
    raise exception 'Unexpected Workforce paid reconciliation structure; partial settlement accounting was not installed.';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  execute v_definition;

  -- Fail the migration if a future function shape silently bypasses either
  -- half of the invariant: instruction for integrity, settlement for payment.
  select replace(pg_get_functiondef(v_signature), chr(13), '')
  into v_definition;
  if position('round(sum(effective.instruction_amount_snapshot), 2) as instruction_amount' in v_definition) = 0
    or position('as paid_settled_amount_snapshot' in v_definition) = 0
    or position('sum(allocation_row.paid_settled_amount_snapshot) filter (' in v_definition) = 0
    or position('sum(allocation_row.instruction_amount_snapshot) filter (' in v_definition) = 0
  then
    raise exception 'Workforce partial settlement accounting invariant was not installed completely.';
  end if;
end
$patch_workforce_partial_settlement_station_balance$;

comment on function public.workforce_payout_payment_row_candidates(uuid, date, date, jsonb) is
  'Canonical station-row payment candidate calculator. Immutable instruction allocations validate provenance; actual settled allocations drive paid totals, balances and payment status.';

notify pgrst, 'reload schema';
