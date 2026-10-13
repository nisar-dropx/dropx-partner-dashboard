begin;

-- One bulk command is an immutable, exactly replayable envelope.  The
-- canonical sorted profile array makes selection order irrelevant while still
-- rejecting a retry that changes any material input.
create table public.workforce_payout_payment_hold_operations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  operation_id uuid not null,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  period_start date not null,
  period_end date not null,
  action text not null,
  remarks text not null,
  selected_workforce_ids uuid[] not null,
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint workforce_payout_payment_hold_operations_company_operation_unique
    unique (company_id, operation_id),
  constraint workforce_payout_payment_hold_operations_company_id_unique
    unique (company_id, id),
  constraint workforce_payout_payment_hold_operations_period_check check (
    extract(day from period_start) = 1
    and period_end = (period_start + interval '1 month - 1 day')::date
  ),
  constraint workforce_payout_payment_hold_operations_action_check check (
    action in ('hold', 'release')
  ),
  constraint workforce_payout_payment_hold_operations_remarks_check check (
    nullif(btrim(remarks), '') is not null and length(btrim(remarks)) between 3 and 1000
  ),
  constraint workforce_payout_payment_hold_operations_selection_check check (
    cardinality(selected_workforce_ids) >= 1
    and array_position(selected_workforce_ids, null) is null
  ),
  constraint workforce_payout_payment_hold_operations_result_check check (
    jsonb_typeof(result) = 'object'
  )
);

create index workforce_payout_payment_hold_operations_actor_idx
  on public.workforce_payout_payment_hold_operations(actor_user_id, created_at desc);

alter table public.workforce_payout_payment_hold_operations enable row level security;
alter table public.workforce_payout_payment_hold_operations force row level security;
revoke all on table public.workforce_payout_payment_hold_operations
  from public, anon, authenticated, service_role;
grant select on table public.workforce_payout_payment_hold_operations to service_role;
create policy workforce_payout_payment_hold_operations_service_select
  on public.workforce_payout_payment_hold_operations
  for select to service_role using (true);

-- Keep every item-level state transition in the existing append-only hold
-- stream.  These columns link all item events to the immutable bulk command;
-- the deferred foreign key allows the item events and their final aggregate
-- result to be committed atomically without an intermediate mutable command.
alter table public.workforce_payout_payment_hold_events
  add column bulk_operation_id uuid,
  add column bulk_item_index integer,
  add constraint workforce_payout_payment_hold_events_bulk_pair_check check (
    (bulk_operation_id is null and bulk_item_index is null)
    or (bulk_operation_id is not null and bulk_item_index >= 1)
  ),
  add constraint workforce_payout_payment_hold_events_bulk_operation_fk
    foreign key (company_id, bulk_operation_id)
    references public.workforce_payout_payment_hold_operations(company_id, id)
    on delete restrict
    deferrable initially deferred;

create unique index workforce_payout_payment_hold_events_bulk_item_uidx
  on public.workforce_payout_payment_hold_events(bulk_operation_id, bulk_item_index)
  where bulk_operation_id is not null;
create unique index workforce_payout_payment_hold_events_bulk_workforce_uidx
  on public.workforce_payout_payment_hold_events(bulk_operation_id, workforce_id)
  where bulk_operation_id is not null;

-- Reuse the same append-only mutation boundary as individual hold events.
create trigger workforce_payout_payment_hold_operations_00_append_only
before insert or update or delete on public.workforce_payout_payment_hold_operations
for each row execute function public.guard_workforce_payout_payment_hold_event();

create or replace function public.workforce_set_payout_payment_holds(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_operation_id uuid,
  p_workforce_ids uuid[],
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
  v_existing public.workforce_payout_payment_hold_operations%rowtype;
  v_ids uuid[];
  v_action text := case when p_hold then 'hold' else 'release' end;
  v_remarks text := btrim(coalesce(p_remarks, ''));
  v_bulk_operation_id uuid := gen_random_uuid();
  v_workforce_id uuid;
  v_current_action text;
  v_is_held boolean;
  v_changed boolean;
  v_event_id uuid;
  v_event_operation_id uuid;
  v_item_index integer := 0;
  v_locked_count integer := 0;
  v_changed_count integer := 0;
  v_unchanged_count integer := 0;
  v_processing_ids uuid[];
  v_items jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  if p_company_id is null or p_actor_user_id is null or p_operation_id is null
    or p_workforce_ids is null or p_hold is null
  then
    raise exception 'Company, actor, operation, Workforce profiles and hold state are required.';
  end if;
  if cardinality(p_workforce_ids) < 1 then
    raise exception 'Select at least one Workforce payout to hold or release.';
  end if;
  if array_position(p_workforce_ids, null) is not null then
    raise exception 'Every selected Workforce payout requires a valid Workforce profile.';
  end if;
  if cardinality(p_workforce_ids) <> (
    select count(distinct selected.workforce_id)::integer
    from unnest(p_workforce_ids) selected(workforce_id)
  ) then
    raise exception 'The same Workforce payout was selected more than once.';
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

  select array_agg(selected.workforce_id order by selected.workforce_id)
  into v_ids
  from unnest(p_workforce_ids) selected(workforce_id);

  if not exists (select 1 from public.companies company where company.id = p_company_id) then
    raise exception 'Company was not found.';
  end if;
  if not exists (select 1 from auth.users actor where actor.id = p_actor_user_id) then
    raise exception 'Payment actor was not found.';
  end if;

  -- A completed command is a fast replay only when every material input is
  -- identical.  Operation IDs can never be repurposed for another selection.
  select operation.* into v_existing
  from public.workforce_payout_payment_hold_operations operation
  where operation.company_id = p_company_id
    and operation.operation_id = p_operation_id;
  if found then
    if v_existing.actor_user_id <> p_actor_user_id
      or v_existing.period_start <> p_period_start
      or v_existing.period_end <> p_period_end
      or v_existing.action <> v_action
      or v_existing.remarks <> v_remarks
      or v_existing.selected_workforce_ids <> v_ids
    then
      raise exception 'This bulk payment hold operation ID was already used for a different request.';
    end if;
    return v_existing.result || jsonb_build_object('replayed', true);
  end if;

  -- Match bank generation's canonical lock order: profile rows in UUID order,
  -- then the company-wide payout allocation lock.  This serializes bank-file
  -- creation, individual holds, and bulk holds without deadlocks or partial
  -- application.
  perform 1
  from public.workforce workforce
  where workforce.company_id = p_company_id
    and workforce.id = any(v_ids)
  order by workforce.id
  for update;
  get diagnostics v_locked_count = row_count;
  if v_locked_count <> cardinality(v_ids) then
    raise exception 'One or more selected Workforce profiles are unavailable in this company.';
  end if;
  perform public.lock_workforce_payment_allocation_company(p_company_id);

  -- Close the simultaneous-retry race after the canonical locks are held.
  select operation.* into v_existing
  from public.workforce_payout_payment_hold_operations operation
  where operation.company_id = p_company_id
    and operation.operation_id = p_operation_id;
  if found then
    if v_existing.actor_user_id <> p_actor_user_id
      or v_existing.period_start <> p_period_start
      or v_existing.period_end <> p_period_end
      or v_existing.action <> v_action
      or v_existing.remarks <> v_remarks
      or v_existing.selected_workforce_ids <> v_ids
    then
      raise exception 'This bulk payment hold operation ID was already used for a different request.';
    end if;
    return v_existing.result || jsonb_build_object('replayed', true);
  end if;

  -- Payment Processing is an immutable bank instruction.  Fail the complete
  -- bulk command before writing any event if even one selected profile is in
  -- flight.  Paid, cancelled and failed instructions remain holdable because
  -- a later payout correction may create a new outstanding balance.
  select array_agg(distinct item.workforce_id order by item.workforce_id)
  into v_processing_ids
  from public.workforce_payout_payment_items item
  where item.company_id = p_company_id
    and item.workforce_id = any(v_ids)
    and item.period_start = p_period_start
    and item.period_end = p_period_end
    and item.status = 'processing';
  if cardinality(v_processing_ids) > 0 then
    raise exception 'Payment Processing is active for one or more selected Workforce payouts. No holds were changed.';
  end if;

  perform set_config('app.workforce_payout_payment_mutation', 'allowed', true);
  foreach v_workforce_id in array v_ids
  loop
    v_item_index := v_item_index + 1;
    v_current_action := null;
    select hold_event.action into v_current_action
    from public.workforce_payout_payment_hold_events hold_event
    where hold_event.company_id = p_company_id
      and hold_event.workforce_id = v_workforce_id
      and hold_event.period_start = p_period_start
      and hold_event.period_end = p_period_end
    order by hold_event.created_at desc, hold_event.id desc
    limit 1;
    v_is_held := found and v_current_action = 'hold';
    v_changed := v_is_held is distinct from p_hold;
    if v_changed then
      v_changed_count := v_changed_count + 1;
    else
      v_unchanged_count := v_unchanged_count + 1;
    end if;

    v_event_id := gen_random_uuid();
    v_event_operation_id := gen_random_uuid();
    insert into public.workforce_payout_payment_hold_events (
      id, company_id, workforce_id, period_start, period_end,
      operation_id, action, state_changed, remarks, actor_user_id,
      bulk_operation_id, bulk_item_index
    ) values (
      v_event_id, p_company_id, v_workforce_id, p_period_start, p_period_end,
      v_event_operation_id, v_action, v_changed, v_remarks, p_actor_user_id,
      v_bulk_operation_id, v_item_index
    );

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'workforce_id', v_workforce_id,
      'hold_event_id', v_event_id,
      'changed', v_changed,
      'on_hold', p_hold
    ));
  end loop;

  v_result := jsonb_build_object(
    'operation_id', p_operation_id,
    'hold_operation_id', v_bulk_operation_id,
    'selected_count', cardinality(v_ids),
    'changed_count', v_changed_count,
    'unchanged_count', v_unchanged_count,
    'on_hold', p_hold,
    'remarks', v_remarks,
    'items', v_items,
    'replayed', false
  );

  insert into public.workforce_payout_payment_hold_operations (
    id, company_id, operation_id, actor_user_id,
    period_start, period_end, action, remarks,
    selected_workforce_ids, result
  ) values (
    v_bulk_operation_id, p_company_id, p_operation_id, p_actor_user_id,
    p_period_start, p_period_end, v_action, v_remarks,
    v_ids, v_result
  );

  return v_result;
end
$function$;

-- The bank candidate calculators are the authoritative exclusion point used
-- by both preview and batch creation.  Preserve their existing hold gate and
-- standardize the externally visible status to the requested exact label.
do $standardize_workforce_hold_status$
declare
  v_signature regprocedure;
  v_definition text;
  v_old text := '''Payment On Hold''';
  v_new text := '''On Hold''';
  v_old_count integer;
  v_new_count integer;
  v_hold_start integer;
  v_hold_end integer;
  v_no_balance_start integer;
  v_hold_block text;
  v_legacy_signature regprocedure :=
    'public.workforce_payout_payment_candidates(uuid,date,date,uuid[])'::regprocedure;
  v_signatures regprocedure[] := array[
    'public.workforce_payout_payment_candidates(uuid,date,date,uuid[])'::regprocedure,
    'public.workforce_payout_payment_row_candidates(uuid,date,date,jsonb)'::regprocedure
  ];
begin
  foreach v_signature in array v_signatures
  loop
    select replace(
      pg_catalog.pg_get_functiondef(v_signature), E'\r\n', E'\n'
    ) into v_definition;
    if position('from public.workforce_payout_payment_hold_events hold_event' in v_definition) = 0
      or position('eligibility_code := ''payment_on_hold'';' in v_definition) = 0
      or position('available_to_pay := 0;' in v_definition) = 0
    then
      raise exception 'Authoritative Workforce hold exclusion is missing from %.',
        v_signature::text;
    end if;

    -- The legacy profile preview historically returned no_positive_balance
    -- before consulting the hold stream.  Move only its existing guarded hold
    -- block ahead of that zero-balance return so a hold placed at zero is
    -- visible immediately and remains authoritative when later edits make the
    -- balance positive.  The station-row calculator already has this order.
    if v_signature = v_legacy_signature then
      v_hold_start := position(
        E'    if coalesce((\n      select hold_event.action = ''hold''' in v_definition
      );
      v_hold_end := position(E'    if dropx_id is null' in v_definition);
      v_no_balance_start := position(E'    if available_to_pay <= 0 then' in v_definition);
      if v_hold_start <= 0 or v_hold_end <= v_hold_start or v_no_balance_start <= 0 then
        raise exception 'Unexpected legacy Workforce hold/no-balance structure in %.',
          v_signature::text;
      end if;
      if v_hold_start > v_no_balance_start then
        v_hold_block := substring(
          v_definition from v_hold_start for v_hold_end - v_hold_start
        );
        v_definition := substring(v_definition from 1 for v_hold_start - 1)
          || substring(v_definition from v_hold_end);
        v_no_balance_start := position(
          E'    if available_to_pay <= 0 then' in v_definition
        );
        v_definition := substring(v_definition from 1 for v_no_balance_start - 1)
          || v_hold_block
          || substring(v_definition from v_no_balance_start);
      end if;
    end if;

    v_old_count := (length(v_definition) - length(replace(v_definition, v_old, '')))
      / length(v_old);
    v_new_count := (length(v_definition) - length(replace(v_definition, v_new, '')))
      / length(v_new);
    if v_old_count = 1 then
      v_definition := replace(v_definition, v_old, v_new);
      execute v_definition;
    elsif v_old_count <> 0 or v_new_count <> 1 then
      raise exception 'Unexpected Workforce hold status label in % (old %, new %).',
        v_signature::text, v_old_count, v_new_count;
    end if;
  end loop;
end
$standardize_workforce_hold_status$;

comment on table public.workforce_payout_payment_hold_operations is
  'Immutable exactly replayable bulk hold/release commands; each command links to durable item events in canonical Workforce-ID order.';
comment on column public.workforce_payout_payment_hold_events.bulk_operation_id is
  'Bulk command that atomically created this item-level hold or release event; null for individual commands.';
comment on function public.workforce_set_payout_payment_holds(
  uuid, uuid, uuid, uuid[], date, date, boolean, text
) is
  'Atomically and idempotently holds or releases an unlimited selected set of Workforce payout profiles for one exact month. Processing payments fail the whole command.';

revoke all on function public.workforce_set_payout_payment_holds(
  uuid, uuid, uuid, uuid[], date, date, boolean, text
) from public, anon, authenticated;
grant execute on function public.workforce_set_payout_payment_holds(
  uuid, uuid, uuid, uuid[], date, date, boolean, text
) to service_role;

notify pgrst, 'reload schema';

commit;
