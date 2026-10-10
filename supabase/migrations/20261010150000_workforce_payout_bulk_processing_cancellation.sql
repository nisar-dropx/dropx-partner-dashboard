begin;

-- Cancel any number of explicitly selected, location-scoped processing
-- instructions as one audited, all-or-nothing Finance action. Validation,
-- ledger updates, audit events and distinct-batch recomputation are set based
-- so a large selection has constant statement count.
create or replace function public.workforce_cancel_payout_payment_items(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_operation_id uuid,
  p_payment_item_ids uuid[],
  p_period_start date,
  p_period_end date,
  p_remarks text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_item_ids uuid[];
  v_item_count integer;
  v_matching_count integer;
  v_remarks text := btrim(coalesce(p_remarks, ''));
  v_existing public.workforce_payout_payment_events%rowtype;
  v_first_item public.workforce_payout_payment_items%rowtype;
  v_batch_ids uuid[];
  v_now timestamptz;
  v_item_results jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  if p_company_id is null or p_actor_user_id is null or p_operation_id is null then
    raise exception 'Company, actor and operation are required.';
  end if;
  if p_period_start is null or p_period_end is null
    or extract(day from p_period_start) <> 1
    or p_period_end <> (p_period_start + interval '1 month - 1 day')::date
  then
    raise exception 'Choose one complete payout month.';
  end if;
  if length(v_remarks) < 3 or length(v_remarks) > 1000 then
    raise exception 'Enter a payment cancellation remark between 3 and 1000 characters.';
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

  if not exists (select 1 from public.companies company where company.id = p_company_id) then
    raise exception 'Company was not found.';
  end if;
  if not exists (select 1 from auth.users actor where actor.id = p_actor_user_id) then
    raise exception 'Payment actor was not found.';
  end if;

  select payment_event.* into v_existing
  from public.workforce_payout_payment_events payment_event
  where payment_event.company_id = p_company_id
    and payment_event.operation_id = p_operation_id;
  if found then
    if v_existing.event_type <> 'payment_cancelled_bulk'
      or v_existing.event_data -> 'payment_item_ids' is distinct from to_jsonb(v_item_ids)
      or v_existing.event_data ->> 'period_start' is distinct from p_period_start::text
      or v_existing.event_data ->> 'period_end' is distinct from p_period_end::text
      or v_existing.event_data ->> 'remarks' is distinct from v_remarks
      or v_existing.actor_user_id <> p_actor_user_id
    then
      raise exception 'This bulk payment cancellation operation ID was already used for a different request.';
    end if;
    return v_existing.event_data || jsonb_build_object('replayed', true);
  end if;

  select count(*)::integer into v_matching_count
  from public.workforce_payout_payment_items item
  where item.company_id = p_company_id
    and item.id = any(v_item_ids)
    and item.period_start = p_period_start
    and item.period_end = p_period_end;
  if v_matching_count <> v_item_count then
    raise exception 'Every selected payment must belong to this company and payout month.';
  end if;

  -- Match the canonical lock order used by the single-item transition. Locking
  -- all Workforce subjects first prevents two overlapping bulk selections from
  -- deadlocking when their submitted item order differs.
  perform 1
  from public.workforce workforce
  where workforce.company_id = p_company_id
    and workforce.id in (
      select item.workforce_id
      from public.workforce_payout_payment_items item
      where item.company_id = p_company_id
        and item.id = any(v_item_ids)
    )
  order by workforce.id
  for update;
  perform public.lock_workforce_payment_allocation_company(p_company_id);

  -- A concurrent replay waits on the same Workforce locks, then observes the
  -- completed aggregate event instead of applying a second cancellation.
  select payment_event.* into v_existing
  from public.workforce_payout_payment_events payment_event
  where payment_event.company_id = p_company_id
    and payment_event.operation_id = p_operation_id;
  if found then
    if v_existing.event_type <> 'payment_cancelled_bulk'
      or v_existing.event_data -> 'payment_item_ids' is distinct from to_jsonb(v_item_ids)
      or v_existing.event_data ->> 'period_start' is distinct from p_period_start::text
      or v_existing.event_data ->> 'period_end' is distinct from p_period_end::text
      or v_existing.event_data ->> 'remarks' is distinct from v_remarks
      or v_existing.actor_user_id <> p_actor_user_id
    then
      raise exception 'This bulk payment cancellation operation ID was already used for a different request.';
    end if;
    return v_existing.event_data || jsonb_build_object('replayed', true);
  end if;

  perform 1
  from public.workforce_payout_payment_items item
  where item.company_id = p_company_id
    and item.id = any(v_item_ids)
  order by item.id
  for update;

  select count(*)::integer into v_matching_count
  from public.workforce_payout_payment_items item
  where item.company_id = p_company_id
    and item.id = any(v_item_ids)
    and item.period_start = p_period_start
    and item.period_end = p_period_end
    and item.status = 'processing';
  if v_matching_count <> v_item_count then
    raise exception 'Every selected payment must still be Payment Processing. No payments were cancelled.';
  end if;

  -- Older profile-wide bank files may have one instruction allocated across
  -- several location rows. A row-level bulk action must never cancel that
  -- combined instruction. Only an instruction backed by one exact allocation
  -- for its immutable location and full instruction amount is eligible.
  select count(*)::integer into v_matching_count
  from (
    select item.id
    from public.workforce_payout_payment_items item
    join public.workforce_payout_payment_allocations allocation
      on allocation.company_id = item.company_id
     and allocation.payment_item_id = item.id
    where item.company_id = p_company_id
      and item.id = any(v_item_ids)
    group by item.id, item.location_id_snapshot, item.instruction_amount
    having count(*) = 1
      and bool_and(allocation.station_id = item.location_id_snapshot)
      and sum(allocation.instruction_amount_snapshot) = item.instruction_amount
  ) exact_location_instruction;
  if v_matching_count <> v_item_count then
    raise exception 'Every selected payment must be one exact location instruction. Legacy combined instructions cannot be bulk-cancelled. No payments were cancelled.';
  end if;

  select item.* into v_first_item
  from public.workforce_payout_payment_items item
  where item.company_id = p_company_id
    and item.id = any(v_item_ids)
  order by item.id
  limit 1;

  select array_agg(distinct item.batch_id order by item.batch_id)
  into v_batch_ids
  from public.workforce_payout_payment_items item
  where item.company_id = p_company_id
    and item.id = any(v_item_ids);

  v_now := clock_timestamp();
  perform set_config('app.workforce_payout_payment_mutation', 'allowed', true);

  update public.workforce_payout_payment_items item
  set status = 'cancelled',
      bank_response_status = 'MANUAL_CANCELLED',
      utr_cin = null,
      bank_processing_remarks = v_remarks,
      response_import_id = null,
      finalized_by = p_actor_user_id,
      finalized_at = v_now,
      updated_at = v_now
  where item.company_id = p_company_id
    and item.id = any(v_item_ids)
    and item.status = 'processing';

  -- Recompute every affected batch exactly once after all selected items have
  -- reached their terminal state.
  with batch_counts as (
    select
      item.batch_id,
      count(*) filter (where item.status = 'processing')::integer as processing_count,
      count(*) filter (where item.status in ('paid', 'cancelled', 'failed'))::integer as terminal_count
    from public.workforce_payout_payment_items item
    where item.company_id = p_company_id
      and item.batch_id = any(v_batch_ids)
    group by item.batch_id
  ), batch_states as (
    select
      batch_count.batch_id,
      case
        when batch_count.processing_count = 0 then 'completed'
        when batch_count.terminal_count > 0 then 'partially_finalized'
        else 'processing'
      end as next_status
    from batch_counts batch_count
  )
  update public.workforce_payout_payment_batches batch
  set status = batch_state.next_status,
      updated_at = v_now,
      completed_at = case
        when batch_state.next_status = 'completed'
          then coalesce(batch.completed_at, v_now)
        else null
      end
  from batch_states batch_state
  where batch.company_id = p_company_id
    and batch.id = batch_state.batch_id;

  -- Retain the same per-instruction audit trail as the single-item command,
  -- using deterministic child operation IDs derived from the bulk operation.
  insert into public.workforce_payout_payment_events (
    company_id, batch_id, payment_item_id, operation_id,
    event_type, event_data, actor_user_id
  )
  select
    p_company_id,
    item.batch_id,
    item.id,
    (
      substr(md5(p_operation_id::text || ':' || item.id::text), 1, 8) || '-'
      || substr(md5(p_operation_id::text || ':' || item.id::text), 9, 4) || '-'
      || substr(md5(p_operation_id::text || ':' || item.id::text), 13, 4) || '-'
      || substr(md5(p_operation_id::text || ':' || item.id::text), 17, 4) || '-'
      || substr(md5(p_operation_id::text || ':' || item.id::text), 21, 12)
    )::uuid,
    'payment_cancelled_manually',
    jsonb_build_object(
      'payment_item_id', item.id,
      'batch_id', item.batch_id,
      'reference_no', item.reference_no,
      'outcome', 'cancelled',
      'remarks', v_remarks,
      'batch_status', batch.status,
      'replayed', false
    ),
    p_actor_user_id
  from public.workforce_payout_payment_items item
  join public.workforce_payout_payment_batches batch
    on batch.company_id = item.company_id
   and batch.id = item.batch_id
  where item.company_id = p_company_id
    and item.id = any(v_item_ids)
  order by item.id;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'payment_item_id', item.id,
      'batch_id', item.batch_id,
      'reference_no', item.reference_no,
      'outcome', 'cancelled',
      'remarks', v_remarks,
      'batch_status', batch.status,
      'replayed', false
    ) order by item.id
  ), '[]'::jsonb)
  into v_item_results
  from public.workforce_payout_payment_items item
  join public.workforce_payout_payment_batches batch
    on batch.company_id = item.company_id
   and batch.id = item.batch_id
  where item.company_id = p_company_id
    and item.id = any(v_item_ids);

  v_result := jsonb_build_object(
    'payment_item_ids', to_jsonb(v_item_ids),
    'period_start', p_period_start,
    'period_end', p_period_end,
    'remarks', v_remarks,
    'cancelled', v_item_count,
    'items', v_item_results,
    'replayed', false
  );
  insert into public.workforce_payout_payment_events (
    company_id, batch_id, payment_item_id, operation_id,
    event_type, event_data, actor_user_id
  ) values (
    p_company_id, v_first_item.batch_id, v_first_item.id, p_operation_id,
    'payment_cancelled_bulk', v_result, p_actor_user_id
  );
  return v_result;
end
$function$;

comment on function public.workforce_cancel_payout_payment_items(
  uuid, uuid, uuid, uuid[], date, date, text
) is
  'Atomically cancels exact location-scoped processing Workforce bank instructions with one mandatory remark, using set-based ledger updates and per-item audit events.';

revoke all on function public.workforce_cancel_payout_payment_items(
  uuid, uuid, uuid, uuid[], date, date, text
) from public, anon, authenticated;
grant execute on function public.workforce_cancel_payout_payment_items(
  uuid, uuid, uuid, uuid[], date, date, text
) to service_role;

notify pgrst, 'reload schema';

commit;
