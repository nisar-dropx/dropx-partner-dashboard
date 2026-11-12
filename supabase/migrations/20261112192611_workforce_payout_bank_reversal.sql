begin;

alter table public.workforce_payout_payment_items
  add column reversal_operation_id uuid,
  add column reversed_by uuid references auth.users(id),
  add column reversed_at timestamptz,
  add column reversal_reason text,
  add column reversed_amount numeric(14,2),
  add constraint workforce_payment_reversal_evidence_check check (
    (reversal_operation_id is null and reversed_by is null and reversed_at is null
      and reversal_reason is null and reversed_amount is null)
    or (reversal_operation_id is not null and reversed_by is not null and reversed_at is not null
      and reversal_reason is not null and length(btrim(reversal_reason)) between 3 and 1000
      and reversed_amount is not null and reversed_amount > 0 and reversed_amount <= instruction_amount
      and status = 'cancelled' and settled_amount is null)
  );

create unique index workforce_payment_reversal_operation_idx
  on public.workforce_payout_payment_items(company_id, reversal_operation_id)
  where reversal_operation_id is not null;

-- The ledger's existing cancelled state excludes this instruction from payable
-- credit totals. Reversal evidence distinguishes it from ordinary cancellation.
do $migration$
declare
  state_expression text;
  definition text;
  anchor constant text := '  if (to_jsonb(new) - array[';
  reversal_guard constant text := $guard$  if tg_op = 'UPDATE' and old.status = 'paid'
    and new.status = 'cancelled' and old.reversal_operation_id is null
    and new.reversal_operation_id is not null
    and current_setting('app.workforce_payout_reversal', true) = old.id::text
    and new.reversed_amount is not distinct from old.settled_amount
    and (to_jsonb(new) - array['status','settled_amount','updated_at',
      'reversal_operation_id','reversed_by','reversed_at','reversal_reason','reversed_amount'])
      is not distinct from
      (to_jsonb(old) - array['status','settled_amount','updated_at',
      'reversal_operation_id','reversed_by','reversed_at','reversal_reason','reversed_amount'])
  then
    return new;
  end if;
$guard$;
begin
  select pg_get_expr(conbin, conrelid) into strict state_expression
  from pg_constraint
  where conrelid = 'public.workforce_payout_payment_items'::regclass
    and conname = 'workforce_payout_payment_items_state_check';
  alter table public.workforce_payout_payment_items
    drop constraint workforce_payout_payment_items_state_check;
  execute 'alter table public.workforce_payout_payment_items add constraint '
    || 'workforce_payout_payment_items_state_check check ((' || state_expression
    || ') or (reversal_operation_id is not null and status = ''cancelled'' '
    || 'and bank_response_status in (''PAID'', ''MANUAL_PAID'') and utr_cin is not null '
    || 'and finalized_by is not null and finalized_at is not null))';

  definition := pg_get_functiondef('public.guard_workforce_payout_payment_item_ledger()'::regprocedure);
  if strpos(definition, anchor) = 0 then
    raise exception 'Unexpected Workforce payment ledger guard.';
  end if;
  execute replace(definition, anchor, reversal_guard || anchor);
end;
$migration$;

create function public.workforce_reverse_payout_payment_item(
  p_company_id uuid, p_actor_user_id uuid, p_operation_id uuid,
  p_payment_item_id uuid, p_reason text
) returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare
  item public.workforce_payout_payment_items;
  reason text := btrim(coalesce(p_reason, ''));
  previous_mutation text := current_setting('app.workforce_payout_payment_mutation', true);
  previous_reversal text := current_setting('app.workforce_payout_reversal', true);
begin
  if p_company_id is null or p_actor_user_id is null or p_operation_id is null
    or length(reason) not between 3 and 1000 then
    raise exception 'A reversal reason between 3 and 1000 characters is required.';
  end if;
  select * into item from public.workforce_payout_payment_items
  where company_id = p_company_id and id = p_payment_item_id;
  if not found then raise exception 'Payment instruction not found.'; end if;
  perform 1 from public.workforce where company_id = p_company_id and id = item.workforce_id for update;
  perform public.lock_workforce_payment_allocation_company(p_company_id);
  select * into strict item from public.workforce_payout_payment_items
  where company_id = p_company_id and id = p_payment_item_id for update;
  if item.reversal_operation_id = p_operation_id and item.reversed_by = p_actor_user_id
    and item.reversal_reason = reason then
    return jsonb_build_object('status', 'reversed', 'replayed', true);
  end if;
  if item.status <> 'paid' or item.settled_amount is null then
    raise exception 'Only a paid bank instruction can be marked reversed.';
  end if;
  if exists (
    select 1 from public.workforce_payout_payment_credit_transfers transfer
    where transfer.company_id = p_company_id and transfer.payment_item_id = item.id
  ) then
    raise exception 'This paid credit has a transfer history. Reconcile the credit transfer before reversing it.';
  end if;
  if exists (
    select 1 from public.workforce_payout_payment_items other
    where other.company_id = p_company_id and other.workforce_id = item.workforce_id
      and other.period_start = item.period_start and other.period_end = item.period_end
      and other.status = 'processing'
  ) then
    raise exception 'A bank payment is still processing for this payout month.';
  end if;
  if exists (
    select 1 from public.pay_advance_deductions deduction
    where deduction.company_id = p_company_id and deduction.target_kind = 'workforce'
      and deduction.target_key = item.workforce_id::text || ':' || item.period_start::text
      and deduction.status = 'confirmed'
  ) then
    raise exception 'This payout has a confirmed advance recovery. Reconcile it before recording a bank reversal.';
  end if;

  perform set_config('app.workforce_payout_payment_mutation', 'allowed', true);
  perform set_config('app.workforce_payout_reversal', item.id::text, true);
  update public.workforce_payout_payment_items
  set status = 'cancelled', settled_amount = null, reversed_amount = item.settled_amount,
      reversal_operation_id = p_operation_id, reversed_by = p_actor_user_id,
      reversed_at = clock_timestamp(), reversal_reason = reason, updated_at = clock_timestamp()
  where company_id = p_company_id and id = item.id;
  perform set_config('app.workforce_payout_reversal', coalesce(previous_reversal, ''), true);
  perform set_config('app.workforce_payout_payment_mutation', coalesce(previous_mutation, ''), true);
  return jsonb_build_object('status', 'reversed', 'replayed', false);
end;
$function$;

revoke all on function public.workforce_reverse_payout_payment_item(uuid,uuid,uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.workforce_reverse_payout_payment_item(uuid,uuid,uuid,uuid,text)
  to service_role;

notify pgrst, 'reload schema';
commit;
