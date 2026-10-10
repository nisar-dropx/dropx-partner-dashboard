begin;

-- Reconstruct only the explicitly selected, still-processing bank instructions
-- from their immutable ledger snapshots. This function is intentionally
-- read-only: a re-download must not create a new payment version, change a
-- payment status, or recalculate a published payout.
create or replace function public.workforce_get_payout_payment_redownload(
  p_company_id uuid,
  p_payment_item_ids uuid[],
  p_period_start date,
  p_period_end date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_item_ids uuid[];
  v_item_count integer;
  v_matching_count integer;
  v_items jsonb;
begin
  if p_company_id is null then
    raise exception 'Company is required.';
  end if;
  if p_period_start is null or p_period_end is null
    or extract(day from p_period_start) <> 1
    or p_period_end <> (p_period_start + interval '1 month - 1 day')::date
  then
    raise exception 'Choose one complete payout month.';
  end if;
  if p_payment_item_ids is null or cardinality(p_payment_item_ids) < 1
    or array_position(p_payment_item_ids, null) is not null
  then
    raise exception 'Select at least one processing payment.';
  end if;

  select array_agg(distinct requested.item_id order by requested.item_id)
  into v_item_ids
  from unnest(p_payment_item_ids) requested(item_id);
  v_item_count := cardinality(v_item_ids);
  if v_item_count <> cardinality(p_payment_item_ids) then
    raise exception 'Each processing payment may be selected only once.';
  end if;

  select count(*)::integer
  into v_matching_count
  from public.workforce_payout_payment_items item
  where item.company_id = p_company_id
    and item.id = any(v_item_ids)
    and item.period_start = p_period_start
    and item.period_end = p_period_end;
  if v_matching_count <> v_item_count then
    raise exception 'Every selected payment must belong to this company and payout month.';
  end if;

  if exists (
    select 1
    from public.workforce_payout_payment_items item
    where item.company_id = p_company_id
      and item.id = any(v_item_ids)
      and item.status <> 'processing'
  ) then
    raise exception 'Every selected payment must still be Payment Processing. Refresh and select again.';
  end if;

  if exists (
    select 1
    from public.workforce_payout_payment_items item
    join public.workforce_payout_payment_batches batch
      on batch.company_id = item.company_id
     and batch.id = item.batch_id
    where item.company_id = p_company_id
      and item.id = any(v_item_ids)
      and (
        batch.status not in ('processing', 'partially_finalized')
        or batch.file_type_snapshot <> 'fedone'
      )
  ) then
    raise exception 'One or more selected bank instructions can no longer be downloaded.';
  end if;

  -- Current station-level instructions have one immutable allocation matching
  -- the item location and amount. Reject old profile-wide/multi-location items
  -- instead of accidentally placing an unselected location in a bank file.
  if exists (
    select 1
    from public.workforce_payout_payment_items item
    left join lateral (
      select
        count(*)::integer as allocation_count,
        count(*) filter (where allocation.station_id = item.location_id_snapshot)::integer as matching_station_count,
        coalesce(sum(allocation.instruction_amount_snapshot), 0::numeric) as allocated_amount
      from public.workforce_payout_payment_allocations allocation
      where allocation.company_id = item.company_id
        and allocation.payment_item_id = item.id
    ) allocation_check on true
    where item.company_id = p_company_id
      and item.id = any(v_item_ids)
      and (
        allocation_check.allocation_count <> 1
        or allocation_check.matching_station_count <> 1
        or allocation_check.allocated_amount <> item.instruction_amount
      )
  ) then
    raise exception 'One or more selected payments use a legacy combined allocation and cannot be safely re-downloaded by row.';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'payment_item_id', item.id,
        'batch_id', item.batch_id,
        'batch_status', batch.status,
        'generated_at', batch.generated_at,
        'period_start', item.period_start,
        'period_end', item.period_end,
        'value_date', batch.value_date,
        'debit_account_no', batch.debit_account_no_snapshot,
        'bank_code', batch.bank_code_snapshot,
        'file_type', batch.file_type_snapshot,
        'reference_no', item.reference_no,
        'instruction_amount', item.instruction_amount,
        'bank_account_no', item.bank_account_no_snapshot,
        'ifsc', item.ifsc_snapshot,
        'beneficiary_name', item.beneficiary_name_snapshot,
        'beneficiary_email', item.beneficiary_email_snapshot,
        'location_id', item.location_id_snapshot,
        'location_code', item.location_code_snapshot,
        'credit_remarks', item.credit_remarks_snapshot,
        'debit_remarks', item.debit_remarks_snapshot
      )
      order by batch.generated_at, batch.id, item.reference_no, item.id
    ),
    '[]'::jsonb
  )
  into v_items
  from public.workforce_payout_payment_items item
  join public.workforce_payout_payment_batches batch
    on batch.company_id = item.company_id
   and batch.id = item.batch_id
  where item.company_id = p_company_id
    and item.id = any(v_item_ids)
    and item.period_start = p_period_start
    and item.period_end = p_period_end
    and item.status = 'processing'
    and batch.status in ('processing', 'partially_finalized');

  if jsonb_array_length(v_items) <> v_item_count then
    raise exception 'The selected processing payments changed while the bank file was prepared. Refresh and try again.';
  end if;

  return jsonb_build_object(
    'payment_count', v_item_count,
    'period_start', p_period_start,
    'period_end', p_period_end,
    'items', v_items
  );
end;
$function$;

revoke all on function public.workforce_get_payout_payment_redownload(uuid, uuid[], date, date)
  from public, anon, authenticated;
grant execute on function public.workforce_get_payout_payment_redownload(uuid, uuid[], date, date)
  to service_role;

comment on function public.workforce_get_payout_payment_redownload(uuid, uuid[], date, date) is
  'Returns immutable FedOne snapshots only for the exact selected processing payment items; performs no payment mutation.';

notify pgrst, 'reload schema';

commit;
