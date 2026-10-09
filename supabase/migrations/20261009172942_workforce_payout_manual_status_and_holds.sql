begin;

-- A bank batch remains an immutable envelope, but it must be able to represent
-- every explicitly selected eligible Workforce profile in one user action.
-- The HTTP route retains a byte-size limit and the creator still proves every
-- selected UUID belongs to the company before creating a single instruction.
alter table public.workforce_payout_payment_batches
  drop constraint workforce_payout_payment_batches_selection_check;
alter table public.workforce_payout_payment_batches
  add constraint workforce_payout_payment_batches_selection_check check (
    cardinality(selected_workforce_ids) >= 1
    and array_position(selected_workforce_ids, null) is null
  );

-- Operation IDs make manual lifecycle transitions exactly replayable without
-- weakening the append-only event ledger.
alter table public.workforce_payout_payment_events
  add column operation_id uuid;
create unique index workforce_payout_payment_events_operation_uidx
  on public.workforce_payout_payment_events(company_id, operation_id)
  where operation_id is not null;

-- A hold can exist before any bank instruction. It is therefore recorded as a
-- separate append-only command stream instead of mutating a payment item. Every
-- accepted operation ID is persisted, including no-ops, so a retry always
-- returns its original outcome instead of applying after an inverse transition.
-- The latest event for one Workforce/month determines the current hold state.
create table public.workforce_payout_payment_hold_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  workforce_id uuid not null,
  period_start date not null,
  period_end date not null,
  operation_id uuid not null,
  action text not null,
  state_changed boolean not null,
  remarks text not null,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  constraint workforce_payout_payment_hold_events_workforce_company_fk
    foreign key (company_id, workforce_id)
    references public.workforce(company_id, id)
    on delete restrict,
  constraint workforce_payout_payment_hold_events_operation_unique
    unique (company_id, operation_id),
  constraint workforce_payout_payment_hold_events_period_check check (
    extract(day from period_start) = 1
    and period_end = (period_start + interval '1 month - 1 day')::date
  ),
  constraint workforce_payout_payment_hold_events_action_check check (
    action in ('hold', 'release')
  ),
  constraint workforce_payout_payment_hold_events_remarks_check check (
    nullif(btrim(remarks), '') is not null and length(btrim(remarks)) between 3 and 1000
  )
);

create index workforce_payout_payment_hold_events_latest_idx
  on public.workforce_payout_payment_hold_events(
    company_id, workforce_id, period_start, period_end, created_at desc, id desc
  );
create index workforce_payout_payment_hold_events_actor_idx
  on public.workforce_payout_payment_hold_events(actor_user_id);

alter table public.workforce_payout_payment_hold_events enable row level security;
alter table public.workforce_payout_payment_hold_events force row level security;
revoke all on table public.workforce_payout_payment_hold_events
  from public, anon, authenticated, service_role;
grant select on table public.workforce_payout_payment_hold_events to service_role;
create policy workforce_payout_payment_hold_events_service_select
  on public.workforce_payout_payment_hold_events
  for select to service_role using (true);

create or replace function public.guard_workforce_payout_payment_hold_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if current_setting('app.workforce_payout_payment_mutation', true) is distinct from 'allowed' then
    raise exception 'Workforce payout payment holds may be changed only by the payment lifecycle RPC.';
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'Workforce payout payment hold history is immutable.';
  end if;
  return new;
end
$function$;

create trigger workforce_payout_payment_hold_events_00_append_only
before insert or update or delete on public.workforce_payout_payment_hold_events
for each row execute function public.guard_workforce_payout_payment_hold_event();

-- Manual failure/cancellation is a terminal, audited transition that releases
-- the processing interlock. It does not count as paid, so a later bank file may
-- contain only the still-outstanding amount under the next payment version.
alter table public.workforce_payout_payment_items
  drop constraint workforce_payout_payment_items_status_check,
  drop constraint workforce_payout_payment_items_state_check;
alter table public.workforce_payout_payment_items
  add constraint workforce_payout_payment_items_status_check check (
    status in ('processing', 'paid', 'cancelled', 'failed')
  ),
  add constraint workforce_payout_payment_items_state_check check (
    (
      status = 'processing'
      and bank_response_status is null
      and utr_cin is null
      and response_import_id is null
      and finalized_by is null
      and finalized_at is null
    )
    or (
      status = 'paid'
      and bank_response_status = 'PAID'
      and nullif(btrim(utr_cin), '') is not null
      and response_import_id is not null
      and finalized_by is not null
      and finalized_at is not null
    )
    or (
      status = 'cancelled'
      and (
        (
          bank_response_status = 'CANCELLED'
          and response_import_id is not null
        )
        or (
          bank_response_status = 'MANUAL_CANCELLED'
          and response_import_id is null
          and utr_cin is null
          and nullif(btrim(bank_processing_remarks), '') is not null
        )
      )
      and finalized_by is not null
      and finalized_at is not null
    )
    or (
      status = 'failed'
      and bank_response_status = 'MANUAL_FAILED'
      and response_import_id is null
      and utr_cin is null
      and nullif(btrim(bank_processing_remarks), '') is not null
      and finalized_by is not null
      and finalized_at is not null
    )
  );

create or replace function public.guard_workforce_payout_payment_item_ledger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if current_setting('app.workforce_payout_payment_mutation', true) is distinct from 'allowed' then
    raise exception 'Workforce payout payment items may be changed only by the bank-processing RPCs.';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Workforce payout payment items cannot be deleted.';
  end if;
  if tg_op = 'INSERT' then return new; end if;

  if (to_jsonb(new) - array[
      'status', 'bank_response_status', 'utr_cin', 'bank_processing_remarks',
      'response_import_id', 'finalized_by', 'finalized_at', 'updated_at'
    ]::text[])
    is distinct from
    (to_jsonb(old) - array[
      'status', 'bank_response_status', 'utr_cin', 'bank_processing_remarks',
      'response_import_id', 'finalized_by', 'finalized_at', 'updated_at'
    ]::text[])
  then
    raise exception 'A Workforce payout payment instruction is immutable after generation.';
  end if;
  if old.status <> 'processing' or new.status not in ('paid', 'cancelled', 'failed') then
    raise exception 'A terminal Workforce payout payment instruction is immutable.';
  end if;
  return new;
end
$function$;

-- Remove the former arbitrary 1,000-profile SQL limit from preview and batch
-- creation, and add the two fail-closed eligibility gates shared by both paths.
do $patch$
declare
  v_candidate_definition text;
  v_creator_definition text;
  v_candidate_limit_old text := $old$
  if cardinality(v_ids) > 1000 then
    raise exception 'Preview at most 1000 Workforce IDs at a time.';
  end if;
$old$;
  v_creator_limit_old text := $old$
  if cardinality(v_ids) < 1 or cardinality(v_ids) > 1000 then
    raise exception 'Select between 1 and 1000 Workforce IDs for one bank file.';
  end if;
$old$;
  v_creator_limit_new text := $new$
  if cardinality(v_ids) < 1 then
    raise exception 'Select at least one Workforce ID for the bank file.';
  end if;
$new$;
  v_latest_status_declaration_old text := 'v_history_count integer;';
  v_latest_status_declaration_new text := $new$v_history_count integer;
  v_latest_attempt_status text;$new$;
  v_latest_status_marker text := $marker$
    paid_amount := v_paid;
$marker$;
  v_latest_status_block text := $new$
    select item.status
    into v_latest_attempt_status
    from public.workforce_payout_payment_items item
    where item.company_id = p_company_id
      and item.workforce_id = v_workforce_id
      and item.period_start = p_period_start
      and item.period_end = p_period_end
    order by item.payment_version desc, item.id desc
    limit 1;

    paid_amount := v_paid;
$new$;
  v_payment_status_old text := $old$
    payment_status := case
      when v_paid > 0 and balance_payable = 0 then 'Paid'
      when v_paid > 0 then 'Partially paid'
      else null
    end;
$old$;
  v_payment_status_new text := $new$
    payment_status := case
      when v_paid > 0 and balance_payable = 0 then 'Paid'
      when v_latest_attempt_status = 'failed' then 'Payment Failed'
      when v_latest_attempt_status = 'cancelled' then 'Payment Cancelled'
      when v_paid > 0 then 'Partially paid'
      else null
    end;
$new$;
  v_bank_gate_marker text := $marker$
    if dropx_id is null
$marker$;
  v_bank_gate_block text := $new$
    if not exists (
      select 1
      from public.connect_profile_verifications verification
      where verification.company_id = p_company_id
        and verification.profile_type = 'workforce'
        and verification.account_id = v_workforce_id
        and verification.kind = 'pan_aadhaar'
        and verification.verified = true
    ) then
      available_to_pay := 0;
      payment_status := 'PAN Not Linked';
      eligibility_code := 'pan_not_linked';
      eligibility_message := format(
        'PAN-Aadhaar must be linked for Workforce ID %s before creating its bank payment.',
        coalesce(dropx_id, v_workforce_id::text)
      );
      return next;
      continue;
    end if;

    if coalesce((
      select hold_event.action = 'hold'
      from public.workforce_payout_payment_hold_events hold_event
      where hold_event.company_id = p_company_id
        and hold_event.workforce_id = v_workforce_id
        and hold_event.period_start = p_period_start
        and hold_event.period_end = p_period_end
      order by hold_event.created_at desc, hold_event.id desc
      limit 1
    ), false) then
      available_to_pay := 0;
      payment_status := 'Payment On Hold';
      eligibility_code := 'payment_on_hold';
      eligibility_message := format(
        'Payment is on hold for Workforce ID %s. Release the hold before creating a bank payment.',
        coalesce(dropx_id, v_workforce_id::text)
      );
      return next;
      continue;
    end if;

    if dropx_id is null
$new$;
begin
  -- Dollar-quoted marker text follows the migration file's line endings.
  -- Normalize both the markers and pg_get_functiondef output so this guarded
  -- patch behaves identically from CRLF and LF checkouts.
  v_candidate_limit_old := replace(v_candidate_limit_old, chr(13), '');
  v_creator_limit_old := replace(v_creator_limit_old, chr(13), '');
  v_creator_limit_new := replace(v_creator_limit_new, chr(13), '');
  v_latest_status_declaration_new := replace(v_latest_status_declaration_new, chr(13), '');
  v_latest_status_marker := replace(v_latest_status_marker, chr(13), '');
  v_latest_status_block := replace(v_latest_status_block, chr(13), '');
  v_payment_status_old := replace(v_payment_status_old, chr(13), '');
  v_payment_status_new := replace(v_payment_status_new, chr(13), '');
  v_bank_gate_marker := replace(v_bank_gate_marker, chr(13), '');
  v_bank_gate_block := replace(v_bank_gate_block, chr(13), '');

  select pg_get_functiondef(
    'public.workforce_payout_payment_candidates(uuid,date,date,uuid[])'::regprocedure
  ) into v_candidate_definition;
  select pg_get_functiondef(
    'public.workforce_create_payout_payment_batch(uuid,uuid,uuid,text,uuid,date,date,date,uuid[])'::regprocedure
  ) into v_creator_definition;

  -- Function bodies retain the line endings from the migration that created
  -- them. Normalize CRLF before checking/replacing exact safety markers so the
  -- patch behaves identically on Windows-created and Unix-created databases.
  v_candidate_definition := replace(v_candidate_definition, chr(13), '');
  v_creator_definition := replace(v_creator_definition, chr(13), '');

  if position(v_candidate_limit_old in v_candidate_definition) = 0
    or position(v_creator_limit_old in v_creator_definition) = 0
    or position(v_latest_status_declaration_old in v_candidate_definition) = 0
    or position(v_latest_status_marker in v_candidate_definition) = 0
    or position(v_payment_status_old in v_candidate_definition) = 0
    or position(v_bank_gate_marker in v_candidate_definition) = 0
  then
    raise exception 'Unexpected Workforce bank-payment function structure; lifecycle migration was not applied.';
  end if;

  v_candidate_definition := replace(v_candidate_definition, v_candidate_limit_old, '');
  v_candidate_definition := replace(
    v_candidate_definition,
    v_latest_status_declaration_old,
    v_latest_status_declaration_new
  );
  v_candidate_definition := replace(
    v_candidate_definition,
    v_latest_status_marker,
    v_latest_status_block
  );
  v_candidate_definition := replace(
    v_candidate_definition,
    v_payment_status_old,
    v_payment_status_new
  );
  v_candidate_definition := replace(
    v_candidate_definition,
    v_bank_gate_marker,
    v_bank_gate_block
  );
  execute v_candidate_definition;

  v_creator_definition := replace(
    v_creator_definition,
    v_creator_limit_old,
    v_creator_limit_new
  );
  execute v_creator_definition;
end
$patch$;

create or replace function public.workforce_set_payout_payment_hold(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_operation_id uuid,
  p_workforce_id uuid,
  p_period_start date,
  p_period_end date,
  p_hold boolean,
  p_remarks text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_existing public.workforce_payout_payment_hold_events%rowtype;
  v_current public.workforce_payout_payment_hold_events%rowtype;
  v_action text := case when p_hold then 'hold' else 'release' end;
  v_remarks text := btrim(coalesce(p_remarks, ''));
  v_is_held boolean := false;
begin
  if p_company_id is null or p_actor_user_id is null or p_operation_id is null
    or p_workforce_id is null or p_hold is null
  then
    raise exception 'Company, actor, operation, Workforce profile and hold state are required.';
  end if;
  if p_period_start is null
    or p_period_end is null
    or extract(day from p_period_start) <> 1
    or p_period_end <> (p_period_start + interval '1 month - 1 day')::date
  then
    raise exception 'Payment holds require one exact calendar month.';
  end if;
  if length(v_remarks) < 3 or length(v_remarks) > 1000 then
    raise exception 'Enter a payment hold remark between 3 and 1000 characters.';
  end if;
  if not exists (select 1 from public.companies company where company.id = p_company_id) then
    raise exception 'Company was not found.';
  end if;
  if not exists (select 1 from auth.users actor where actor.id = p_actor_user_id) then
    raise exception 'Payment actor was not found.';
  end if;

  select hold_event.* into v_existing
  from public.workforce_payout_payment_hold_events hold_event
  where hold_event.company_id = p_company_id
    and hold_event.operation_id = p_operation_id;
  if found then
    if v_existing.workforce_id <> p_workforce_id
      or v_existing.period_start <> p_period_start
      or v_existing.period_end <> p_period_end
      or v_existing.action <> v_action
      or v_existing.remarks <> v_remarks
      or v_existing.actor_user_id <> p_actor_user_id
    then
      raise exception 'This payment hold operation ID was already used for a different request.';
    end if;
    return jsonb_build_object(
      'changed', v_existing.state_changed,
      'replayed', true,
      'hold_event_id', v_existing.id,
      'on_hold', v_existing.action = 'hold',
      'remarks', v_existing.remarks
    );
  end if;

  perform 1
  from public.workforce workforce
  where workforce.company_id = p_company_id
    and workforce.id = p_workforce_id
  for update;
  if not found then
    raise exception 'Workforce profile was not found in this company.';
  end if;
  perform public.lock_workforce_payment_allocation_company(p_company_id);

  -- Recheck after taking the canonical lock set so simultaneous retries with
  -- the same operation ID return the already-committed result.
  select hold_event.* into v_existing
  from public.workforce_payout_payment_hold_events hold_event
  where hold_event.company_id = p_company_id
    and hold_event.operation_id = p_operation_id;
  if found then
    if v_existing.workforce_id <> p_workforce_id
      or v_existing.period_start <> p_period_start
      or v_existing.period_end <> p_period_end
      or v_existing.action <> v_action
      or v_existing.remarks <> v_remarks
      or v_existing.actor_user_id <> p_actor_user_id
    then
      raise exception 'This payment hold operation ID was already used for a different request.';
    end if;
    return jsonb_build_object(
      'changed', v_existing.state_changed,
      'replayed', true,
      'hold_event_id', v_existing.id,
      'on_hold', v_existing.action = 'hold',
      'remarks', v_existing.remarks
    );
  end if;

  select hold_event.* into v_current
  from public.workforce_payout_payment_hold_events hold_event
  where hold_event.company_id = p_company_id
    and hold_event.workforce_id = p_workforce_id
    and hold_event.period_start = p_period_start
    and hold_event.period_end = p_period_end
  order by hold_event.created_at desc, hold_event.id desc
  limit 1;
  v_is_held := found and v_current.action = 'hold';

  perform set_config('app.workforce_payout_payment_mutation', 'allowed', true);
  insert into public.workforce_payout_payment_hold_events (
    company_id, workforce_id, period_start, period_end,
    operation_id, action, state_changed, remarks, actor_user_id
  ) values (
    p_company_id, p_workforce_id, p_period_start, p_period_end,
    p_operation_id, v_action, v_is_held is distinct from p_hold, v_remarks, p_actor_user_id
  ) returning * into v_current;

  return jsonb_build_object(
    'changed', v_current.state_changed,
    'replayed', false,
    'hold_event_id', v_current.id,
    'on_hold', p_hold,
    'remarks', v_remarks
  );
end
$function$;

create or replace function public.workforce_transition_payout_payment_item(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_operation_id uuid,
  p_payment_item_id uuid,
  p_outcome text,
  p_remarks text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_item public.workforce_payout_payment_items%rowtype;
  v_existing_event public.workforce_payout_payment_events%rowtype;
  v_outcome text := lower(btrim(coalesce(p_outcome, '')));
  v_remarks text := btrim(coalesce(p_remarks, ''));
  v_event_type text;
  v_bank_status text;
  v_processing_count integer;
  v_terminal_count integer;
  v_batch_status text;
  v_result jsonb;
begin
  if p_company_id is null or p_actor_user_id is null or p_operation_id is null
    or p_payment_item_id is null
  then
    raise exception 'Company, actor, operation and payment item are required.';
  end if;
  if v_outcome not in ('failed', 'cancelled') then
    raise exception 'Manual payment status must be failed or cancelled.';
  end if;
  if length(v_remarks) < 3 or length(v_remarks) > 1000 then
    raise exception 'Enter a payment status remark between 3 and 1000 characters.';
  end if;
  if not exists (select 1 from public.companies company where company.id = p_company_id) then
    raise exception 'Company was not found.';
  end if;
  if not exists (select 1 from auth.users actor where actor.id = p_actor_user_id) then
    raise exception 'Payment actor was not found.';
  end if;

  select payment_event.* into v_existing_event
  from public.workforce_payout_payment_events payment_event
  where payment_event.company_id = p_company_id
    and payment_event.operation_id = p_operation_id;
  if found then
    if v_existing_event.event_data ->> 'payment_item_id' is distinct from p_payment_item_id::text
      or v_existing_event.event_data ->> 'outcome' is distinct from v_outcome
      or v_existing_event.event_data ->> 'remarks' is distinct from v_remarks
      or v_existing_event.actor_user_id <> p_actor_user_id
    then
      raise exception 'This manual payment status operation ID was already used for a different request.';
    end if;
    return v_existing_event.event_data || jsonb_build_object('replayed', true);
  end if;

  select item.* into v_item
  from public.workforce_payout_payment_items item
  where item.company_id = p_company_id
    and item.id = p_payment_item_id;
  if not found then
    raise exception 'Workforce payment instruction was not found.';
  end if;

  perform 1
  from public.workforce workforce
  where workforce.company_id = p_company_id
    and workforce.id = v_item.workforce_id
  for update;
  perform public.lock_workforce_payment_allocation_company(p_company_id);

  -- The first lookup was intentionally lock-free for fast retries. Repeat it
  -- under the canonical lock set to close the simultaneous-retry race.
  select payment_event.* into v_existing_event
  from public.workforce_payout_payment_events payment_event
  where payment_event.company_id = p_company_id
    and payment_event.operation_id = p_operation_id;
  if found then
    if v_existing_event.event_data ->> 'payment_item_id' is distinct from p_payment_item_id::text
      or v_existing_event.event_data ->> 'outcome' is distinct from v_outcome
      or v_existing_event.event_data ->> 'remarks' is distinct from v_remarks
      or v_existing_event.actor_user_id <> p_actor_user_id
    then
      raise exception 'This manual payment status operation ID was already used for a different request.';
    end if;
    return v_existing_event.event_data || jsonb_build_object('replayed', true);
  end if;

  select item.* into v_item
  from public.workforce_payout_payment_items item
  where item.company_id = p_company_id
    and item.id = p_payment_item_id
  for update;
  if v_item.status <> 'processing' then
    raise exception 'Only a Payment Processing instruction can be changed manually.';
  end if;

  v_event_type := case when v_outcome = 'failed'
    then 'payment_failed_manually' else 'payment_cancelled_manually' end;
  v_bank_status := case when v_outcome = 'failed'
    then 'MANUAL_FAILED' else 'MANUAL_CANCELLED' end;

  perform set_config('app.workforce_payout_payment_mutation', 'allowed', true);
  update public.workforce_payout_payment_items item
  set status = v_outcome,
      bank_response_status = v_bank_status,
      utr_cin = null,
      bank_processing_remarks = v_remarks,
      response_import_id = null,
      finalized_by = p_actor_user_id,
      finalized_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where item.id = v_item.id;

  select
    count(*) filter (where item.status = 'processing')::integer,
    count(*) filter (where item.status in ('paid', 'cancelled', 'failed'))::integer
  into v_processing_count, v_terminal_count
  from public.workforce_payout_payment_items item
  where item.batch_id = v_item.batch_id;
  v_batch_status := case
    when v_processing_count = 0 then 'completed'
    when v_terminal_count > 0 then 'partially_finalized'
    else 'processing'
  end;
  update public.workforce_payout_payment_batches batch
  set status = v_batch_status,
      updated_at = clock_timestamp(),
      completed_at = case when v_batch_status = 'completed'
        then coalesce(batch.completed_at, clock_timestamp()) else null end
  where batch.id = v_item.batch_id
    and (
      batch.status <> v_batch_status
      or (v_batch_status = 'completed' and batch.completed_at is null)
    );

  v_result := jsonb_build_object(
    'payment_item_id', v_item.id,
    'batch_id', v_item.batch_id,
    'reference_no', v_item.reference_no,
    'outcome', v_outcome,
    'remarks', v_remarks,
    'batch_status', v_batch_status,
    'replayed', false
  );
  insert into public.workforce_payout_payment_events (
    company_id, batch_id, payment_item_id, operation_id,
    event_type, event_data, actor_user_id
  ) values (
    p_company_id, v_item.batch_id, v_item.id, p_operation_id,
    v_event_type, v_result, p_actor_user_id
  );
  return v_result;
end
$function$;

comment on table public.workforce_payout_payment_hold_events is
  'Append-only hold/release command history for one Workforce payout month, including idempotent no-op outcomes; the latest event is the current state.';
comment on function public.workforce_set_payout_payment_hold(uuid,uuid,uuid,uuid,date,date,boolean,text) is
  'Idempotently records an audited Workforce/month bank-payment hold or release with a mandatory remark.';
comment on function public.workforce_transition_payout_payment_item(uuid,uuid,uuid,uuid,text,text) is
  'Idempotently changes one processing Workforce bank instruction to manually failed or cancelled, preserving its immutable instruction and audit trail.';
comment on function public.workforce_payout_payment_candidates(uuid,date,date,uuid[]) is
  'Canonical bank-payment candidate calculator. Processing, active holds and PAN-Aadhaar-not-linked payouts are excluded; paid amounts reduce later revised delta instructions.';

revoke all on function public.guard_workforce_payout_payment_hold_event()
  from public, anon, authenticated, service_role;
revoke all on function public.workforce_set_payout_payment_hold(
  uuid, uuid, uuid, uuid, date, date, boolean, text
) from public, anon, authenticated;
revoke all on function public.workforce_transition_payout_payment_item(
  uuid, uuid, uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.workforce_set_payout_payment_hold(
  uuid, uuid, uuid, uuid, date, date, boolean, text
) to service_role;
grant execute on function public.workforce_transition_payout_payment_item(
  uuid, uuid, uuid, uuid, text, text
) to service_role;

notify pgrst, 'reload schema';

commit;
