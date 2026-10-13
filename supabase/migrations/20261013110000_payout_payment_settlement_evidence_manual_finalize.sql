begin;

-- Preserve the exact settlement evidence.  Master bank details may change after
-- payment, so history must never reconstruct a paid transaction from the live
-- Workforce/Helper profile.
alter table public.workforce_payout_payment_items
  add column if not exists settled_amount numeric(14,2),
  add column if not exists response_debit_account_no text,
  add column if not exists response_value_date date,
  add column if not exists response_credit_account_no text,
  add column if not exists response_ifsc text,
  add column if not exists finalization_remarks text;

alter table public.helper_payout_payment_items
  add column if not exists settled_amount numeric(14,2),
  add column if not exists response_debit_account_no text,
  add column if not exists response_value_date date,
  add column if not exists response_credit_account_no text,
  add column if not exists response_ifsc text,
  add column if not exists finalization_remarks text;

-- Existing terminal bank rows predate response snapshots.  Their generated
-- instruction is the best immutable evidence available and is preferable to
-- mutable profile data.
alter table public.workforce_payout_payment_items
  disable trigger workforce_payout_payment_items_00_ledger_guard;
update public.workforce_payout_payment_items item
set settled_amount = case when item.status = 'paid'
      then item.instruction_amount else null end,
    response_debit_account_no = batch.debit_account_no_snapshot,
    response_value_date = batch.value_date,
    response_credit_account_no = item.bank_account_no_snapshot,
    response_ifsc = item.ifsc_snapshot
from public.workforce_payout_payment_batches batch
where batch.company_id = item.company_id
  and batch.id = item.batch_id
  and item.response_import_id is not null
  and item.status in ('paid', 'cancelled');
alter table public.workforce_payout_payment_items
  enable trigger workforce_payout_payment_items_00_ledger_guard;

alter table public.helper_payout_payment_items
  disable trigger helper_payout_payment_items_00_ledger_guard;
update public.helper_payout_payment_items item
set settled_amount = case when item.status = 'paid'
      then item.instruction_amount else null end,
    response_debit_account_no = batch.debit_account_no_snapshot,
    response_value_date = batch.value_date,
    response_credit_account_no = item.bank_account_no_snapshot,
    response_ifsc = item.ifsc_snapshot
from public.helper_payout_payment_batches batch
where batch.company_id = item.company_id
  and batch.id = item.batch_id
  and item.response_import_id is not null
  and item.status in ('paid', 'cancelled');
alter table public.helper_payout_payment_items
  enable trigger helper_payout_payment_items_00_ledger_guard;

alter table public.workforce_payout_payment_items
  add constraint workforce_payout_payment_items_settlement_amount_check check (
    settled_amount is null
    or (status = 'paid' and settled_amount > 0 and settled_amount <= instruction_amount)
  ) not valid;
alter table public.workforce_payout_payment_items
  validate constraint workforce_payout_payment_items_settlement_amount_check;

alter table public.helper_payout_payment_items
  add constraint helper_payout_payment_items_settlement_amount_check check (
    settled_amount is null
    or (status = 'paid' and settled_amount > 0 and settled_amount <= instruction_amount)
  ) not valid;
alter table public.helper_payout_payment_items
  validate constraint helper_payout_payment_items_settlement_amount_check;

-- Imported rows temporarily become paid before the response-import AFTER
-- trigger below copies their enriched evidence.  A deferred constraint trigger
-- validates the final transaction state, so no paid row can commit without the
-- amount and bank evidence.
create or replace function public.validate_payout_payment_settlement_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_item jsonb;
begin
  if tg_table_name = 'helper_payout_payment_items' then
    select to_jsonb(item) into v_item
    from public.helper_payout_payment_items item
    where item.id = new.id;
  else
    select to_jsonb(item) into v_item
    from public.workforce_payout_payment_items item
    where item.id = new.id;
  end if;
  if v_item is null then return null; end if;
  if v_item ->> 'status' = 'paid' and (
    coalesce(v_item ->> 'settled_amount', '') = ''
    or (v_item ->> 'settled_amount')::numeric <= 0
    or (v_item ->> 'settled_amount')::numeric > (v_item ->> 'instruction_amount')::numeric
    or nullif(btrim(coalesce(v_item ->> 'response_debit_account_no', '')), '') is null
    or nullif(btrim(coalesce(v_item ->> 'response_credit_account_no', '')), '') is null
    or nullif(btrim(coalesce(v_item ->> 'response_ifsc', '')), '') is null
    or nullif(v_item ->> 'response_value_date', '') is null
  ) then
    raise exception 'Paid payout instructions require a valid settled amount and immutable bank evidence.';
  end if;
  if v_item ->> 'status' <> 'paid' and nullif(v_item ->> 'settled_amount', '') is not null then
    raise exception 'Only paid payout instructions may carry a settled amount.';
  end if;
  return null;
end
$function$;

drop trigger if exists workforce_payout_payment_items_99_settlement_evidence
  on public.workforce_payout_payment_items;
create constraint trigger workforce_payout_payment_items_99_settlement_evidence
after insert or update on public.workforce_payout_payment_items
deferrable initially deferred
for each row execute function public.validate_payout_payment_settlement_evidence();

drop trigger if exists helper_payout_payment_items_99_settlement_evidence
  on public.helper_payout_payment_items;
create constraint trigger helper_payout_payment_items_99_settlement_evidence
after insert or update on public.helper_payout_payment_items
deferrable initially deferred
for each row execute function public.validate_payout_payment_settlement_evidence();

-- Permit only one processing-to-terminal mutation.  The additional fields are
-- immutable with the rest of the generated instruction once terminal.
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
  if tg_op = 'INSERT' then
    if new.status = 'processing' then
      -- Serialize every privileged insert for this Workforce profile. This
      -- preserves the cross-batch one-processing-instruction invariant even
      -- when the same person has separate station rows.
      perform 1
      from public.workforce workforce
      where workforce.company_id = new.company_id
        and workforce.id = new.workforce_id
      for update;

      if exists (
        select 1
        from public.workforce_payout_payment_items existing
        where existing.company_id = new.company_id
          and existing.workforce_id = new.workforce_id
          and existing.period_start = new.period_start
          and existing.period_end = new.period_end
          and existing.status = 'processing'
          and existing.batch_id <> new.batch_id
      ) then
        raise exception 'A different Workforce bank batch is already processing this profile and month.';
      end if;
    end if;
    return new;
  end if;

  if (to_jsonb(new) - array[
      'status', 'bank_response_status', 'utr_cin', 'bank_processing_remarks',
      'response_import_id', 'finalized_by', 'finalized_at', 'updated_at',
      'settled_amount', 'response_debit_account_no', 'response_value_date',
      'response_credit_account_no', 'response_ifsc', 'finalization_remarks'
    ]::text[])
    is distinct from
    (to_jsonb(old) - array[
      'status', 'bank_response_status', 'utr_cin', 'bank_processing_remarks',
      'response_import_id', 'finalized_by', 'finalized_at', 'updated_at',
      'settled_amount', 'response_debit_account_no', 'response_value_date',
      'response_credit_account_no', 'response_ifsc', 'finalization_remarks'
    ]::text[])
  then
    raise exception 'A Workforce payout payment instruction is immutable after generation.';
  end if;
  if current_setting('app.payout_response_evidence_capture', true) = 'allowed'
    and old.status = new.status and old.status in ('paid', 'cancelled')
  then
    return new;
  end if;
  if old.status <> 'processing' or new.status not in ('paid', 'cancelled', 'failed') then
    raise exception 'A terminal Workforce payout payment instruction is immutable.';
  end if;
  return new;
end
$function$;

create or replace function public.guard_helper_payout_payment_item_ledger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if current_setting('app.helper_payout_payment_mutation', true) is distinct from 'allowed' then
    raise exception 'Helper payout payment items may be changed only by bank-processing RPCs.';
  end if;
  if tg_op = 'DELETE' then raise exception 'Helper payout payment items cannot be deleted.'; end if;
  if tg_op = 'INSERT' then return new; end if;
  if (to_jsonb(new) - array[
      'status','bank_response_status','utr_cin','bank_processing_remarks',
      'response_import_id','finalized_by','finalized_at','updated_at',
      'settled_amount','response_debit_account_no','response_value_date',
      'response_credit_account_no','response_ifsc','finalization_remarks'
    ]::text[]) is distinct from
    (to_jsonb(old) - array[
      'status','bank_response_status','utr_cin','bank_processing_remarks',
      'response_import_id','finalized_by','finalized_at','updated_at',
      'settled_amount','response_debit_account_no','response_value_date',
      'response_credit_account_no','response_ifsc','finalization_remarks'
    ]::text[])
  then raise exception 'A Helper payout payment instruction is immutable after generation.'; end if;
  if current_setting('app.payout_response_evidence_capture', true) = 'allowed'
    and old.status = new.status and old.status in ('paid', 'cancelled')
  then
    return new;
  end if;
  if old.status <> 'processing' or new.status not in ('paid','cancelled','failed') then
    raise exception 'A terminal Helper payout payment instruction is immutable.';
  end if;
  return new;
end
$function$;

-- Manual paid is distinct from a bank-file import and always carries an audit
-- remark.  Imported and manual paid rows share the same immutable evidence and
-- UTR uniqueness rules.
alter table public.workforce_payout_payment_items
  drop constraint workforce_payout_payment_items_state_check;
alter table public.workforce_payout_payment_items
  add constraint workforce_payout_payment_items_state_check check (
    (status = 'processing' and bank_response_status is null and utr_cin is null
      and response_import_id is null and finalized_by is null and finalized_at is null
      and settled_amount is null and response_debit_account_no is null
      and response_value_date is null and response_credit_account_no is null
      and response_ifsc is null and finalization_remarks is null)
    or (status = 'paid' and bank_response_status in ('PAID', 'MANUAL_PAID')
      and nullif(btrim(utr_cin), '') is not null
      and ((bank_response_status = 'PAID' and response_import_id is not null)
        or (bank_response_status = 'MANUAL_PAID' and response_import_id is null
          and nullif(btrim(finalization_remarks), '') is not null))
      and finalized_by is not null and finalized_at is not null)
    or (status = 'cancelled' and finalized_by is not null and finalized_at is not null
      and settled_amount is null
      and ((bank_response_status = 'CANCELLED' and response_import_id is not null)
        or (bank_response_status = 'MANUAL_CANCELLED' and response_import_id is null
          and utr_cin is null and nullif(btrim(bank_processing_remarks), '') is not null)))
    or (status = 'failed' and bank_response_status = 'MANUAL_FAILED'
      and response_import_id is null and utr_cin is null and settled_amount is null
      and nullif(btrim(bank_processing_remarks), '') is not null
      and finalized_by is not null and finalized_at is not null)
  );

alter table public.helper_payout_payment_items
  drop constraint helper_payout_payment_items_state_check;
alter table public.helper_payout_payment_items
  add constraint helper_payout_payment_items_state_check check (
    (status = 'processing' and bank_response_status is null and utr_cin is null
      and response_import_id is null and finalized_by is null and finalized_at is null
      and settled_amount is null and response_debit_account_no is null
      and response_value_date is null and response_credit_account_no is null
      and response_ifsc is null and finalization_remarks is null)
    or (status = 'paid' and bank_response_status in ('PAID', 'MANUAL_PAID')
      and nullif(btrim(utr_cin), '') is not null
      and ((bank_response_status = 'PAID' and response_import_id is not null)
        or (bank_response_status = 'MANUAL_PAID' and response_import_id is null
          and nullif(btrim(finalization_remarks), '') is not null))
      and finalized_by is not null and finalized_at is not null)
    or (status = 'cancelled' and finalized_by is not null and finalized_at is not null
      and settled_amount is null
      and ((bank_response_status = 'CANCELLED' and response_import_id is not null)
        or (bank_response_status = 'MANUAL_CANCELLED' and response_import_id is null
          and utr_cin is null and nullif(btrim(bank_processing_remarks), '') is not null)))
    or (status = 'failed' and bank_response_status = 'MANUAL_FAILED'
      and response_import_id is null and utr_cin is null and settled_amount is null
      and nullif(btrim(bank_processing_remarks), '') is not null
      and finalized_by is not null and finalized_at is not null)
  );

-- Compare the stable, original response fields for file/operation idempotency.
-- Enriching the normalized rows with Debit Account and Value Date must not make
-- a previously imported legacy file look like a different payment response.
create or replace function public.payout_bank_response_core_rows(p_rows jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'row_number', response.value -> 'row_number',
    'reference_no', response.value -> 'reference_no',
    'credit_account', response.value -> 'credit_account',
    'ifsc', response.value -> 'ifsc',
    'debit_amount_paise', response.value -> 'debit_amount_paise',
    'status', response.value -> 'status',
    'utr_cin', response.value -> 'utr_cin',
    'remarks', response.value -> 'remarks'
  ) order by response.ordinality), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb))
    with ordinality response(value, ordinality);
$function$;

-- A response imported before Debit Account and Value Date were retained has
-- already made its payment item terminal.  Re-uploading that exact file takes
-- an idempotent early-return path, so the AFTER INSERT evidence trigger cannot
-- run again.  These private helpers fill only the missing/legacy response
-- evidence from the newly parsed payload.  They independently require an exact
-- match of every originally stored response field and never create a payment,
-- change a terminal state, change settled_amount, or add an event.
create or replace function public.enrich_workforce_payout_response_evidence_on_replay(
  p_company_id uuid,
  p_response_import_id uuid,
  p_rows jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_import public.workforce_payout_payment_response_imports%rowtype;
  v_row jsonb;
  v_reference text;
  v_status text;
  v_utr_normalized text;
  v_remarks text;
  v_linked boolean;
  v_updated integer;
  v_previous_mutation text := current_setting('app.workforce_payout_payment_mutation', true);
  v_previous_capture text := current_setting('app.payout_response_evidence_capture', true);
begin
  if p_company_id is null or p_response_import_id is null
    or p_rows is null or jsonb_typeof(p_rows) <> 'array'
  then
    raise exception 'Company, response import and normalized response rows are required for Workforce evidence replay.';
  end if;

  select imported.* into v_import
  from public.workforce_payout_payment_response_imports imported
  where imported.company_id = p_company_id
    and imported.id = p_response_import_id
  for update;
  if not found then
    raise exception 'The Workforce bank response import was not found for evidence replay.';
  end if;
  if public.payout_bank_response_core_rows(v_import.normalized_rows)
      is distinct from public.payout_bank_response_core_rows(p_rows)
  then
    raise exception 'Workforce response evidence replay requires an exact stored core-row match.';
  end if;

  perform set_config('app.workforce_payout_payment_mutation', 'allowed', true);
  perform set_config('app.payout_response_evidence_capture', 'allowed', true);
  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    v_reference := public.workforce_payout_bank_reference_canonical(v_row ->> 'reference_no');
    v_status := upper(btrim(coalesce(v_row ->> 'status', '')));
    if v_status = 'CANCELED' then v_status := 'CANCELLED'; end if;
    v_utr_normalized := regexp_replace(
      upper(btrim(coalesce(v_row ->> 'utr_cin', ''))), '[^A-Z0-9]', '', 'g'
    );
    v_remarks := btrim(coalesce(v_row ->> 'remarks', ''));

    select exists (
      select 1
      from public.workforce_payout_payment_items item
      where item.company_id = p_company_id
        and item.response_import_id = p_response_import_id
        and item.reference_no = v_reference
    ) into v_linked;

    update public.workforce_payout_payment_items item
    set response_debit_account_no = coalesce(
          nullif(public.workforce_payout_bank_account_canonical(v_row ->> 'debit_account'), ''),
          item.response_debit_account_no
        ),
        response_value_date = case
          when coalesce(v_row ->> 'value_date', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
            then (v_row ->> 'value_date')::date
          else item.response_value_date
        end,
        response_credit_account_no = coalesce(
          nullif(public.workforce_payout_bank_account_canonical(v_row ->> 'credit_account'), ''),
          item.response_credit_account_no
        ),
        response_ifsc = coalesce(
          nullif(public.workforce_payout_bank_ifsc_canonical(v_row ->> 'ifsc'), ''),
          item.response_ifsc
        ),
        updated_at = clock_timestamp()
    where item.company_id = p_company_id
      and item.response_import_id = p_response_import_id
      and item.reference_no = v_reference
      and item.status in ('paid', 'cancelled')
      and item.bank_response_status = v_status
      and regexp_replace(
        upper(btrim(coalesce(item.utr_cin, ''))), '[^A-Z0-9]', '', 'g'
      ) = v_utr_normalized
      and btrim(coalesce(item.bank_processing_remarks, '')) = v_remarks
      and coalesce(v_row ->> 'debit_amount_paise', '') ~ '^[1-9][0-9]*$'
      and round(item.instruction_amount * 100, 0)
        = (v_row ->> 'debit_amount_paise')::numeric;
    get diagnostics v_updated = row_count;

    if v_linked and v_updated <> 1 then
      raise exception 'The Workforce terminal item no longer matches its stored response evidence.';
    end if;
  end loop;
  perform set_config(
    'app.workforce_payout_payment_mutation', coalesce(v_previous_mutation, ''), true
  );
  perform set_config(
    'app.payout_response_evidence_capture', coalesce(v_previous_capture, ''), true
  );
end
$function$;

create or replace function public.enrich_helper_payout_response_evidence_on_replay(
  p_company_id uuid,
  p_response_import_id uuid,
  p_rows jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_import public.helper_payout_payment_response_imports%rowtype;
  v_row jsonb;
  v_reference text;
  v_status text;
  v_utr_normalized text;
  v_remarks text;
  v_linked boolean;
  v_updated integer;
  v_previous_mutation text := current_setting('app.helper_payout_payment_mutation', true);
  v_previous_capture text := current_setting('app.payout_response_evidence_capture', true);
begin
  if p_company_id is null or p_response_import_id is null
    or p_rows is null or jsonb_typeof(p_rows) <> 'array'
  then
    raise exception 'Company, response import and normalized response rows are required for Helper evidence replay.';
  end if;

  select imported.* into v_import
  from public.helper_payout_payment_response_imports imported
  where imported.company_id = p_company_id
    and imported.id = p_response_import_id
  for update;
  if not found then
    raise exception 'The Helper bank response import was not found for evidence replay.';
  end if;
  if public.payout_bank_response_core_rows(v_import.normalized_rows)
      is distinct from public.payout_bank_response_core_rows(p_rows)
  then
    raise exception 'Helper response evidence replay requires an exact stored core-row match.';
  end if;

  perform set_config('app.helper_payout_payment_mutation', 'allowed', true);
  perform set_config('app.payout_response_evidence_capture', 'allowed', true);
  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    v_reference := public.workforce_payout_bank_reference_canonical(v_row ->> 'reference_no');
    v_status := upper(btrim(coalesce(v_row ->> 'status', '')));
    if v_status = 'CANCELED' then v_status := 'CANCELLED'; end if;
    v_utr_normalized := regexp_replace(
      upper(btrim(coalesce(v_row ->> 'utr_cin', ''))), '[^A-Z0-9]', '', 'g'
    );
    v_remarks := btrim(coalesce(v_row ->> 'remarks', ''));

    select exists (
      select 1
      from public.helper_payout_payment_items item
      where item.company_id = p_company_id
        and item.response_import_id = p_response_import_id
        and item.reference_no = v_reference
    ) into v_linked;

    update public.helper_payout_payment_items item
    set response_debit_account_no = coalesce(
          nullif(public.workforce_payout_bank_account_canonical(v_row ->> 'debit_account'), ''),
          item.response_debit_account_no
        ),
        response_value_date = case
          when coalesce(v_row ->> 'value_date', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
            then (v_row ->> 'value_date')::date
          else item.response_value_date
        end,
        response_credit_account_no = coalesce(
          nullif(public.workforce_payout_bank_account_canonical(v_row ->> 'credit_account'), ''),
          item.response_credit_account_no
        ),
        response_ifsc = coalesce(
          nullif(public.workforce_payout_bank_ifsc_canonical(v_row ->> 'ifsc'), ''),
          item.response_ifsc
        ),
        updated_at = clock_timestamp()
    where item.company_id = p_company_id
      and item.response_import_id = p_response_import_id
      and item.reference_no = v_reference
      and item.status in ('paid', 'cancelled')
      and item.bank_response_status = v_status
      and regexp_replace(
        upper(btrim(coalesce(item.utr_cin, ''))), '[^A-Z0-9]', '', 'g'
      ) = v_utr_normalized
      and btrim(coalesce(item.bank_processing_remarks, '')) = v_remarks
      and coalesce(v_row ->> 'debit_amount_paise', '') ~ '^[1-9][0-9]*$'
      and round(item.instruction_amount * 100, 0)
        = (v_row ->> 'debit_amount_paise')::numeric;
    get diagnostics v_updated = row_count;

    if v_linked and v_updated <> 1 then
      raise exception 'The Helper terminal item no longer matches its stored response evidence.';
    end if;
  end loop;
  perform set_config(
    'app.helper_payout_payment_mutation', coalesce(v_previous_mutation, ''), true
  );
  perform set_config(
    'app.payout_response_evidence_capture', coalesce(v_previous_capture, ''), true
  );
end
$function$;

do $patch_idempotency$
declare
  v_signature regprocedure;
  v_definition text;
  v_old constant text := 'v_existing.normalized_rows is distinct from p_rows';
  v_new constant text := 'public.payout_bank_response_core_rows(v_existing.normalized_rows) is distinct from public.payout_bank_response_core_rows(p_rows)';
begin
  foreach v_signature in array array[
    'public.workforce_finalize_payout_payment_response(uuid,uuid,uuid,text,text,jsonb)'::regprocedure,
    'public.helper_finalize_payout_payment_response(uuid,uuid,uuid,text,text,jsonb)'::regprocedure
  ] loop
    select pg_get_functiondef(v_signature) into v_definition;
    if position(v_old in v_definition) = 0 then
      raise exception 'Unexpected payout response idempotency structure for %.', v_signature;
    end if;
    execute replace(v_definition, v_old, v_new);
  end loop;
end
$patch_idempotency$;

-- The bank response is the settlement evidence.  Do not reject it because a
-- credit account or IFSC differs from the generated snapshot; retain the actual
-- response values below.  The reference, positive exact imported amount and UTR
-- remain the transaction controls.  Manual partial finalization has its own
-- amount ceiling.
do $patch_response_bank_details$
declare
  v_signature regprocedure;
  v_definition text;
  v_patched text;
begin
  v_signature :=
    'public.workforce_finalize_payout_payment_response(uuid,uuid,uuid,text,text,jsonb)'::regprocedure;
  select pg_get_functiondef(v_signature) into v_definition;
  v_patched := replace(v_definition,
    'OR (v_account <> public.workforce_payout_bank_account_canonical(v_item.bank_account_no_snapshot))', '');
  v_patched := replace(v_patched,
    'OR (v_ifsc <> public.workforce_payout_bank_ifsc_canonical(v_item.ifsc_snapshot))', '');
  v_patched := replace(v_patched,
    'or v_account <> public.workforce_payout_bank_account_canonical(v_item.bank_account_no_snapshot)', '');
  v_patched := replace(v_patched,
    'or v_ifsc <> public.workforce_payout_bank_ifsc_canonical(v_item.ifsc_snapshot)', '');
  if v_patched is not distinct from v_definition then
    raise exception 'Unexpected Workforce response bank-detail validation structure.';
  end if;
  execute v_patched;

  v_signature :=
    'public.helper_finalize_payout_payment_response(uuid,uuid,uuid,text,text,jsonb)'::regprocedure;
  select pg_get_functiondef(v_signature) into v_definition;
  v_patched := replace(v_definition,
    'OR (v_account <> public.workforce_payout_bank_account_canonical(v_item.bank_account_no_snapshot))', '');
  v_patched := replace(v_patched,
    'OR (v_ifsc <> public.workforce_payout_bank_ifsc_canonical(v_item.ifsc_snapshot))', '');
  v_patched := replace(v_patched,
    'or v_account <> public.workforce_payout_bank_account_canonical(v_item.bank_account_no_snapshot)', '');
  v_patched := replace(v_patched,
    'or v_ifsc <> public.workforce_payout_bank_ifsc_canonical(v_item.ifsc_snapshot)', '');
  if v_patched is not distinct from v_definition then
    raise exception 'Unexpected Helper response bank-detail validation structure.';
  end if;
  execute v_patched;
end
$patch_response_bank_details$;

-- All four replay exits in each finalizer (operation/file identity, before and
-- after locking) must enrich legacy evidence before returning the original
-- immutable result snapshot.  Requiring the expected count makes a future
-- upstream finalizer rewrite fail this migration closed instead of silently
-- restoring the historical gap.
do $patch_response_evidence_replay$
declare
  v_signature regprocedure;
  v_definition text;
  v_marker constant text := 'return v_existing.result_snapshot';
  v_replacement text;
  v_occurrences integer;
begin
  v_signature :=
    'public.workforce_finalize_payout_payment_response(uuid,uuid,uuid,text,text,jsonb)'::regprocedure;
  select pg_get_functiondef(v_signature) into v_definition;
  v_occurrences := (
    length(v_definition) - length(replace(v_definition, v_marker, ''))
  ) / length(v_marker);
  if v_occurrences <> 4 then
    raise exception 'Unexpected Workforce response replay-return structure (% exits).', v_occurrences;
  end if;
  v_replacement :=
    'perform public.enrich_workforce_payout_response_evidence_on_replay('
    || 'p_company_id, v_existing.id, p_rows);' || chr(10)
    || '    ' || v_marker;
  execute replace(v_definition, v_marker, v_replacement);

  v_signature :=
    'public.helper_finalize_payout_payment_response(uuid,uuid,uuid,text,text,jsonb)'::regprocedure;
  select pg_get_functiondef(v_signature) into v_definition;
  v_occurrences := (
    length(v_definition) - length(replace(v_definition, v_marker, ''))
  ) / length(v_marker);
  if v_occurrences <> 4 then
    raise exception 'Unexpected Helper response replay-return structure (% exits).', v_occurrences;
  end if;
  v_replacement :=
    'perform public.enrich_helper_payout_response_evidence_on_replay('
    || 'p_company_id, v_existing.id, p_rows);' || chr(10)
    || '    ' || v_marker;
  execute replace(v_definition, v_marker, v_replacement);
end
$patch_response_evidence_replay$;

create or replace function public.capture_workforce_payout_response_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_row jsonb;
  v_reference text;
  v_previous_capture text := current_setting('app.payout_response_evidence_capture', true);
begin
  perform set_config('app.workforce_payout_payment_mutation', 'allowed', true);
  perform set_config('app.payout_response_evidence_capture', 'allowed', true);
  for v_row in select value from jsonb_array_elements(new.normalized_rows)
  loop
    v_reference := public.workforce_payout_bank_reference_canonical(v_row ->> 'reference_no');
    update public.workforce_payout_payment_items item
    set settled_amount = case when item.status = 'paid'
          then round((v_row ->> 'debit_amount_paise')::numeric / 100, 2)
          else null end,
        response_debit_account_no = coalesce(
          nullif(public.workforce_payout_bank_account_canonical(v_row ->> 'debit_account'), ''),
          batch.debit_account_no_snapshot
        ),
        response_value_date = case
          when coalesce(v_row ->> 'value_date', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
            then (v_row ->> 'value_date')::date
          else batch.value_date
        end,
        response_credit_account_no = coalesce(
          nullif(public.workforce_payout_bank_account_canonical(v_row ->> 'credit_account'), ''),
          item.bank_account_no_snapshot
        ),
        response_ifsc = coalesce(
          nullif(public.workforce_payout_bank_ifsc_canonical(v_row ->> 'ifsc'), ''),
          item.ifsc_snapshot
        ),
        updated_at = clock_timestamp()
    from public.workforce_payout_payment_batches batch
    where item.company_id = new.company_id
      and item.response_import_id = new.id
      and item.reference_no = v_reference
      and batch.company_id = item.company_id
      and batch.id = item.batch_id;
  end loop;
  perform set_config('app.payout_response_evidence_capture', coalesce(v_previous_capture, ''), true);
  return new;
end
$function$;

create or replace function public.capture_helper_payout_response_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_row jsonb;
  v_reference text;
  v_previous_capture text := current_setting('app.payout_response_evidence_capture', true);
begin
  perform set_config('app.helper_payout_payment_mutation', 'allowed', true);
  perform set_config('app.payout_response_evidence_capture', 'allowed', true);
  for v_row in select value from jsonb_array_elements(new.normalized_rows)
  loop
    v_reference := public.workforce_payout_bank_reference_canonical(v_row ->> 'reference_no');
    update public.helper_payout_payment_items item
    set settled_amount = case when item.status = 'paid'
          then round((v_row ->> 'debit_amount_paise')::numeric / 100, 2)
          else null end,
        response_debit_account_no = coalesce(
          nullif(public.workforce_payout_bank_account_canonical(v_row ->> 'debit_account'), ''),
          batch.debit_account_no_snapshot
        ),
        response_value_date = case
          when coalesce(v_row ->> 'value_date', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
            then (v_row ->> 'value_date')::date
          else batch.value_date
        end,
        response_credit_account_no = coalesce(
          nullif(public.workforce_payout_bank_account_canonical(v_row ->> 'credit_account'), ''),
          item.bank_account_no_snapshot
        ),
        response_ifsc = coalesce(
          nullif(public.workforce_payout_bank_ifsc_canonical(v_row ->> 'ifsc'), ''),
          item.ifsc_snapshot
        ),
        updated_at = clock_timestamp()
    from public.helper_payout_payment_batches batch
    where item.company_id = new.company_id
      and item.response_import_id = new.id
      and item.reference_no = v_reference
      and batch.company_id = item.company_id
      and batch.id = item.batch_id;
  end loop;
  perform set_config('app.payout_response_evidence_capture', coalesce(v_previous_capture, ''), true);
  return new;
end
$function$;

drop trigger if exists workforce_payout_payment_response_90_capture_evidence
  on public.workforce_payout_payment_response_imports;
create trigger workforce_payout_payment_response_90_capture_evidence
after insert on public.workforce_payout_payment_response_imports
for each row execute function public.capture_workforce_payout_response_evidence();

drop trigger if exists helper_payout_payment_response_90_capture_evidence
  on public.helper_payout_payment_response_imports;
create trigger helper_payout_payment_response_90_capture_evidence
after insert on public.helper_payout_payment_response_imports
for each row execute function public.capture_helper_payout_response_evidence();

-- Allocate an actual partial settlement over immutable Workforce publication
-- allocations using cumulative rounding.  The parts always add back to the
-- exact item-level settled amount, including the final paise.
create or replace view public.workforce_payout_effective_paid_allocations
with (security_invoker = true)
as
with paid_allocation_basis as (
  select
    allocation.company_id,
    allocation.id,
    allocation.payment_item_id,
    allocation.publication_id,
    allocation.station_id,
    allocation.instruction_amount_snapshot,
    item.batch_id,
    item.workforce_id as original_workforce_id,
    item.period_start,
    item.period_end,
    item.instruction_amount as original_instruction_amount,
    item.settled_amount,
    item.status,
    item.reference_no,
    item.utr_cin,
    item.bank_account_no_snapshot,
    item.ifsc_snapshot,
    item.location_id_snapshot,
    item.location_code_snapshot,
    item.bank_processing_remarks,
    item.finalization_remarks,
    item.response_debit_account_no,
    item.response_value_date,
    item.response_credit_account_no,
    item.response_ifsc,
    item.payment_version,
    item.created_at,
    item.finalized_at,
    sum(allocation.instruction_amount_snapshot) over (
      partition by allocation.company_id, allocation.payment_item_id
    ) as allocation_total,
    sum(allocation.instruction_amount_snapshot) over (
      partition by allocation.company_id, allocation.payment_item_id
      order by allocation.id rows between unbounded preceding and current row
    ) as allocation_cumulative,
    coalesce(sum(allocation.instruction_amount_snapshot) over (
      partition by allocation.company_id, allocation.payment_item_id
      order by allocation.id rows between unbounded preceding and 1 preceding
    ), 0) as allocation_previous
  from public.workforce_payout_payment_allocations allocation
  join public.workforce_payout_payment_items item
    on item.company_id = allocation.company_id
   and item.id = allocation.payment_item_id
  where item.status = 'paid'
), paid_allocations as (
  select basis.*,
    case when basis.allocation_total > 0 then
      round(basis.settled_amount * basis.allocation_cumulative / basis.allocation_total, 2)
      - round(basis.settled_amount * basis.allocation_previous / basis.allocation_total, 2)
    else 0 end::numeric(14,2) as settled_amount_snapshot
  from paid_allocation_basis basis
)
select
  allocation.company_id,
  allocation.id as payment_allocation_id,
  allocation.payment_item_id,
  allocation.batch_id,
  allocation.original_workforce_id,
  allocation.original_workforce_id as credited_workforce_id,
  allocation.publication_id,
  allocation.station_id,
  allocation.period_start,
  allocation.period_end,
  allocation.instruction_amount_snapshot,
  allocation.original_instruction_amount,
  allocation.status,
  allocation.reference_no,
  allocation.utr_cin,
  allocation.bank_account_no_snapshot,
  allocation.location_id_snapshot,
  allocation.location_code_snapshot,
  allocation.bank_processing_remarks,
  allocation.payment_version,
  allocation.created_at,
  allocation.finalized_at,
  false as was_transferred,
  allocation.settled_amount_snapshot,
  allocation.response_debit_account_no,
  allocation.response_value_date,
  allocation.response_credit_account_no,
  allocation.response_ifsc,
  allocation.ifsc_snapshot,
  allocation.finalization_remarks
from paid_allocations allocation
where allocation.settled_amount_snapshot > 0
  and not exists (
  select 1
  from public.workforce_payout_payment_credit_transfers transfer
  where transfer.company_id = allocation.company_id
    and transfer.payment_allocation_id = allocation.id
)

union all

select
  allocation.company_id,
  allocation.id as payment_allocation_id,
  allocation.payment_item_id,
  allocation.batch_id,
  allocation.original_workforce_id,
  transfer.destination_workforce_id as credited_workforce_id,
  allocation.publication_id,
  allocation.station_id,
  allocation.period_start,
  allocation.period_end,
  allocation.instruction_amount_snapshot,
  allocation.original_instruction_amount,
  allocation.status,
  allocation.reference_no,
  allocation.utr_cin,
  allocation.bank_account_no_snapshot,
  allocation.location_id_snapshot,
  allocation.location_code_snapshot,
  allocation.bank_processing_remarks,
  allocation.payment_version,
  allocation.created_at,
  allocation.finalized_at,
  true as was_transferred,
  allocation.settled_amount_snapshot,
  allocation.response_debit_account_no,
  allocation.response_value_date,
  allocation.response_credit_account_no,
  allocation.response_ifsc,
  allocation.ifsc_snapshot,
  allocation.finalization_remarks
from paid_allocations allocation
join public.workforce_payout_payment_credit_transfers transfer
  on transfer.company_id = allocation.company_id
 and transfer.payment_allocation_id = allocation.id
where allocation.settled_amount_snapshot > 0
  and not exists (
  select 1
  from public.workforce_payout_payment_credit_transfers later
  where later.company_id = transfer.company_id
    and later.payment_allocation_id = transfer.payment_allocation_id
    and later.sequence_no > transfer.sequence_no
);

revoke all on public.workforce_payout_effective_paid_allocations
  from public, anon, authenticated, service_role;
grant select on public.workforce_payout_effective_paid_allocations to service_role;

-- Every live calculator and transfer flow must use actual settled value, never
-- the original instruction value, when a payment was manually finalized short.
do $patch_paid_totals$
declare
  v_signature regprocedure;
  v_definition text;
  v_patched text;
begin
  foreach v_signature in array array[
    'public.workforce_payout_payment_candidates(uuid,date,date,uuid[])'::regprocedure,
    'public.workforce_payout_payment_row_candidates(uuid,date,date,jsonb)'::regprocedure,
    'public.workforce_preview_payout_payment_rows(uuid,date,date,jsonb)'::regprocedure,
    'public.workforce_mapping_paid_history_preview(uuid,uuid,uuid,date)'::regprocedure,
    'public.workforce_replace_joining_mapping_with_payment_decision(uuid,uuid,uuid,uuid,text,jsonb,uuid[],text,text,text,uuid)'::regprocedure
  ] loop
    select pg_get_functiondef(v_signature) into v_definition;
    v_patched := replace(v_definition,
      'sum(item.instruction_amount) FILTER (WHERE (item.status = ''paid''::text))',
      'sum(item.settled_amount) FILTER (WHERE (item.status = ''paid''::text))');
    v_patched := replace(v_patched,
      'sum(item.instruction_amount) filter (where item.status = ''paid'')',
      'sum(item.settled_amount) filter (where item.status = ''paid'')');
    v_patched := replace(v_patched,
      'effective.instruction_amount_snapshot', 'effective.settled_amount_snapshot');
    v_patched := replace(v_patched,
      'paid.instruction_amount_snapshot', 'paid.settled_amount_snapshot');
    if v_patched is not distinct from v_definition then
      raise exception 'No paid-total expression was patched for %.', v_signature;
    end if;
    execute v_patched;
  end loop;

  v_signature := 'public.helper_payout_payment_row_candidates(uuid,date,date,jsonb)'::regprocedure;
  select pg_get_functiondef(v_signature) into v_definition;
  v_patched := replace(v_definition,
    'sum(item.instruction_amount) FILTER (WHERE (item.status = ''paid''::text))',
    'sum(item.settled_amount) FILTER (WHERE (item.status = ''paid''::text))');
  v_patched := replace(v_patched,
    'sum(item.instruction_amount) filter (where item.status = ''paid'')',
    'sum(item.settled_amount) filter (where item.status = ''paid'')');
  if v_patched is not distinct from v_definition then
    raise exception 'No Helper paid-total expression was patched.';
  end if;
  execute v_patched;
end
$patch_paid_totals$;

create or replace function public.workforce_finalize_payout_payment_item_manually(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_operation_id uuid,
  p_payment_item_id uuid,
  p_paid_amount numeric,
  p_debit_account_no text,
  p_credit_account_no text,
  p_credit_ifsc text,
  p_value_date date,
  p_utr_cin text,
  p_bank_remarks text,
  p_remarks text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_item public.workforce_payout_payment_items%rowtype;
  v_existing public.workforce_payout_payment_events%rowtype;
  v_paid numeric(14,2) := round(coalesce(p_paid_amount, 0), 2);
  v_debit text := public.workforce_payout_bank_account_canonical(p_debit_account_no);
  v_credit text := public.workforce_payout_bank_account_canonical(p_credit_account_no);
  v_ifsc text := public.workforce_payout_bank_ifsc_canonical(p_credit_ifsc);
  v_utr text := btrim(coalesce(p_utr_cin, ''));
  v_utr_normalized text;
  v_bank_remarks text := btrim(coalesce(p_bank_remarks, ''));
  v_remarks text := btrim(coalesce(p_remarks, ''));
  v_processing integer;
  v_terminal integer;
  v_batch_status text;
  v_result jsonb;
begin
  if p_company_id is null or p_actor_user_id is null or p_operation_id is null
    or p_payment_item_id is null or p_paid_amount is null or p_value_date is null
  then raise exception 'Company, actor, operation, payment item, amount and value date are required.'; end if;
  if p_paid_amount <> v_paid or v_paid <= 0 then
    raise exception 'Paid amount must be positive with no more than two decimal places.';
  end if;
  if v_debit = '' or length(v_debit) > 100 or v_credit = '' or length(v_credit) > 100
    or v_ifsc = '' or length(v_ifsc) > 50
  then raise exception 'Debit account, credit account and credit IFSC are required.'; end if;
  v_utr_normalized := regexp_replace(upper(v_utr), '[^A-Z0-9]', '', 'g');
  if v_utr_normalized in ('', '0', 'NA', 'NIL', 'NONE', 'NULL', 'NOTAVAILABLE', 'NOTAPPLICABLE')
    or length(v_utr) > 120
  then raise exception 'Enter a meaningful UTR/CIN.'; end if;
  if length(v_bank_remarks) < 3 or length(v_bank_remarks) > 1000
    or length(v_remarks) < 3 or length(v_remarks) > 1000
  then raise exception 'Bank remarks and finalization remarks must each contain 3 to 1000 characters.'; end if;
  if not exists (select 1 from public.companies company where company.id = p_company_id) then
    raise exception 'Company was not found.';
  end if;
  if not exists (select 1 from auth.users actor where actor.id = p_actor_user_id) then
    raise exception 'Payment actor was not found.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'workforce-payout-manual-finalize:' || p_company_id::text || ':' || p_operation_id::text, 0
  ));
  select event.* into v_existing
  from public.workforce_payout_payment_events event
  where event.company_id = p_company_id and event.operation_id = p_operation_id;
  if found then
    if v_existing.event_type <> 'payment_paid_manually'
      or v_existing.event_data ->> 'payment_item_id' is distinct from p_payment_item_id::text
      or (v_existing.event_data ->> 'paid_amount')::numeric is distinct from v_paid
      or v_existing.event_data ->> 'debit_account_no' is distinct from v_debit
      or v_existing.event_data ->> 'credit_account_no' is distinct from v_credit
      or v_existing.event_data ->> 'credit_ifsc' is distinct from v_ifsc
      or (v_existing.event_data ->> 'value_date')::date is distinct from p_value_date
      or v_existing.event_data ->> 'utr_cin' is distinct from v_utr
      or v_existing.event_data ->> 'bank_remarks' is distinct from v_bank_remarks
      or v_existing.event_data ->> 'remarks' is distinct from v_remarks
      or v_existing.actor_user_id <> p_actor_user_id
    then raise exception 'This manual finalization operation ID was already used for a different request.'; end if;
    return v_existing.event_data || jsonb_build_object('replayed', true);
  end if;

  select item.* into v_item
  from public.workforce_payout_payment_items item
  where item.company_id = p_company_id and item.id = p_payment_item_id;
  if not found then raise exception 'Workforce payment instruction was not found.'; end if;
  perform 1 from public.workforce workforce
  where workforce.company_id = p_company_id and workforce.id = v_item.workforce_id for update;
  perform public.lock_workforce_payment_allocation_company(p_company_id);
  select item.* into v_item
  from public.workforce_payout_payment_items item
  where item.company_id = p_company_id and item.id = p_payment_item_id for update;
  if v_item.status <> 'processing' then
    raise exception 'Only a Payment Processing instruction can be finalized manually.';
  end if;
  if v_paid > v_item.instruction_amount then
    raise exception 'Paid amount cannot exceed the processing instruction amount of %.', v_item.instruction_amount;
  end if;

  perform set_config('app.workforce_payout_payment_mutation', 'allowed', true);
  update public.workforce_payout_payment_items item
  set status = 'paid', bank_response_status = 'MANUAL_PAID',
      settled_amount = v_paid, utr_cin = v_utr,
      bank_processing_remarks = v_bank_remarks, finalization_remarks = v_remarks,
      response_debit_account_no = v_debit, response_value_date = p_value_date,
      response_credit_account_no = v_credit, response_ifsc = v_ifsc,
      response_import_id = null, finalized_by = p_actor_user_id,
      finalized_at = clock_timestamp(), updated_at = clock_timestamp()
  where item.id = v_item.id;

  select count(*) filter (where item.status = 'processing')::integer,
    count(*) filter (where item.status in ('paid','cancelled','failed'))::integer
  into v_processing, v_terminal
  from public.workforce_payout_payment_items item where item.batch_id = v_item.batch_id;
  v_batch_status := case when v_processing = 0 then 'completed'
    when v_terminal > 0 then 'partially_finalized' else 'processing' end;
  update public.workforce_payout_payment_batches batch
  set status = v_batch_status, updated_at = clock_timestamp(),
      completed_at = case when v_batch_status = 'completed'
        then coalesce(batch.completed_at, clock_timestamp()) else null end
  where batch.id = v_item.batch_id;

  v_result := jsonb_build_object(
    'payment_item_id', v_item.id, 'batch_id', v_item.batch_id,
    'reference_no', v_item.reference_no, 'outcome',
      case when v_paid < v_item.instruction_amount then 'partially_paid' else 'paid' end,
    'paid_amount', v_paid, 'instruction_amount', v_item.instruction_amount,
    'balance_remaining', round(v_item.instruction_amount - v_paid, 2),
    'debit_account_no', v_debit, 'credit_account_no', v_credit,
    'credit_ifsc', v_ifsc, 'value_date', p_value_date,
    'utr_cin', v_utr, 'bank_remarks', v_bank_remarks, 'remarks', v_remarks,
    'batch_status', v_batch_status, 'replayed', false
  );
  insert into public.workforce_payout_payment_events(
    company_id, batch_id, payment_item_id, operation_id,
    event_type, event_data, actor_user_id
  ) values (
    p_company_id, v_item.batch_id, v_item.id, p_operation_id,
    'payment_paid_manually', v_result, p_actor_user_id
  );
  return v_result;
end
$function$;

create or replace function public.helper_finalize_payout_payment_item_manually(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_operation_id uuid,
  p_payment_item_id uuid,
  p_paid_amount numeric,
  p_debit_account_no text,
  p_credit_account_no text,
  p_credit_ifsc text,
  p_value_date date,
  p_utr_cin text,
  p_bank_remarks text,
  p_remarks text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_item public.helper_payout_payment_items%rowtype;
  v_existing public.helper_payout_payment_events%rowtype;
  v_paid numeric(14,2) := round(coalesce(p_paid_amount, 0), 2);
  v_debit text := public.workforce_payout_bank_account_canonical(p_debit_account_no);
  v_credit text := public.workforce_payout_bank_account_canonical(p_credit_account_no);
  v_ifsc text := public.workforce_payout_bank_ifsc_canonical(p_credit_ifsc);
  v_utr text := btrim(coalesce(p_utr_cin, ''));
  v_utr_normalized text;
  v_bank_remarks text := btrim(coalesce(p_bank_remarks, ''));
  v_remarks text := btrim(coalesce(p_remarks, ''));
  v_processing integer;
  v_terminal integer;
  v_batch_status text;
  v_result jsonb;
begin
  if p_company_id is null or p_actor_user_id is null or p_operation_id is null
    or p_payment_item_id is null or p_paid_amount is null or p_value_date is null
  then raise exception 'Company, actor, operation, payment item, amount and value date are required.'; end if;
  if p_paid_amount <> v_paid or v_paid <= 0 then
    raise exception 'Paid amount must be positive with no more than two decimal places.';
  end if;
  if v_debit = '' or length(v_debit) > 100 or v_credit = '' or length(v_credit) > 100
    or v_ifsc = '' or length(v_ifsc) > 50
  then raise exception 'Debit account, credit account and credit IFSC are required.'; end if;
  v_utr_normalized := regexp_replace(upper(v_utr), '[^A-Z0-9]', '', 'g');
  if v_utr_normalized in ('', '0', 'NA', 'NIL', 'NONE', 'NULL', 'NOTAVAILABLE', 'NOTAPPLICABLE')
    or length(v_utr) > 120
  then raise exception 'Enter a meaningful UTR/CIN.'; end if;
  if length(v_bank_remarks) < 3 or length(v_bank_remarks) > 1000
    or length(v_remarks) < 3 or length(v_remarks) > 1000
  then raise exception 'Bank remarks and finalization remarks must each contain 3 to 1000 characters.'; end if;
  if not exists (select 1 from public.companies company where company.id = p_company_id) then
    raise exception 'Company was not found.';
  end if;
  if not exists (select 1 from auth.users actor where actor.id = p_actor_user_id) then
    raise exception 'Payment actor was not found.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'helper-payout-manual-finalize:' || p_company_id::text || ':' || p_operation_id::text, 0
  ));
  select event.* into v_existing
  from public.helper_payout_payment_events event
  where event.company_id = p_company_id and event.operation_id = p_operation_id;
  if found then
    if v_existing.event_type <> 'payment_paid_manually'
      or v_existing.event_data ->> 'payment_item_id' is distinct from p_payment_item_id::text
      or (v_existing.event_data ->> 'paid_amount')::numeric is distinct from v_paid
      or v_existing.event_data ->> 'debit_account_no' is distinct from v_debit
      or v_existing.event_data ->> 'credit_account_no' is distinct from v_credit
      or v_existing.event_data ->> 'credit_ifsc' is distinct from v_ifsc
      or (v_existing.event_data ->> 'value_date')::date is distinct from p_value_date
      or v_existing.event_data ->> 'utr_cin' is distinct from v_utr
      or v_existing.event_data ->> 'bank_remarks' is distinct from v_bank_remarks
      or v_existing.event_data ->> 'remarks' is distinct from v_remarks
      or v_existing.actor_user_id <> p_actor_user_id
    then raise exception 'This manual finalization operation ID was already used for a different request.'; end if;
    return v_existing.event_data || jsonb_build_object('replayed', true);
  end if;

  select item.* into v_item from public.helper_payout_payment_items item
  where item.company_id = p_company_id and item.id = p_payment_item_id;
  if not found then raise exception 'Helper payment instruction was not found.'; end if;
  perform 1 from public.helpers helper
  where helper.company_id = p_company_id and helper.id = v_item.helper_id for update;
  perform 1 from public.helper_payout_payment_batches batch
  where batch.company_id = p_company_id and batch.id = v_item.batch_id for update;
  select item.* into v_item from public.helper_payout_payment_items item
  where item.company_id = p_company_id and item.id = p_payment_item_id for update;
  if v_item.status <> 'processing' then
    raise exception 'Only a Payment Processing instruction can be finalized manually.';
  end if;
  if v_paid > v_item.instruction_amount then
    raise exception 'Paid amount cannot exceed the processing instruction amount of %.', v_item.instruction_amount;
  end if;

  perform set_config('app.helper_payout_payment_mutation', 'allowed', true);
  update public.helper_payout_payment_items item
  set status = 'paid', bank_response_status = 'MANUAL_PAID',
      settled_amount = v_paid, utr_cin = v_utr,
      bank_processing_remarks = v_bank_remarks, finalization_remarks = v_remarks,
      response_debit_account_no = v_debit, response_value_date = p_value_date,
      response_credit_account_no = v_credit, response_ifsc = v_ifsc,
      response_import_id = null, finalized_by = p_actor_user_id,
      finalized_at = clock_timestamp(), updated_at = clock_timestamp()
  where item.id = v_item.id;

  select count(*) filter (where item.status = 'processing')::integer,
    count(*) filter (where item.status in ('paid','cancelled','failed'))::integer
  into v_processing, v_terminal
  from public.helper_payout_payment_items item where item.batch_id = v_item.batch_id;
  v_batch_status := case when v_processing = 0 then 'completed'
    when v_terminal > 0 then 'partially_finalized' else 'processing' end;
  update public.helper_payout_payment_batches batch
  set status = v_batch_status, updated_at = clock_timestamp(),
      completed_at = case when v_batch_status = 'completed'
        then coalesce(batch.completed_at, clock_timestamp()) else null end
  where batch.id = v_item.batch_id;

  v_result := jsonb_build_object(
    'payment_item_id', v_item.id, 'batch_id', v_item.batch_id,
    'reference_no', v_item.reference_no, 'outcome',
      case when v_paid < v_item.instruction_amount then 'partially_paid' else 'paid' end,
    'paid_amount', v_paid, 'instruction_amount', v_item.instruction_amount,
    'balance_remaining', round(v_item.instruction_amount - v_paid, 2),
    'debit_account_no', v_debit, 'credit_account_no', v_credit,
    'credit_ifsc', v_ifsc, 'value_date', p_value_date,
    'utr_cin', v_utr, 'bank_remarks', v_bank_remarks, 'remarks', v_remarks,
    'batch_status', v_batch_status, 'replayed', false
  );
  insert into public.helper_payout_payment_events(
    company_id, batch_id, payment_item_id, operation_id,
    event_type, event_data, actor_user_id
  ) values (
    p_company_id, v_item.batch_id, v_item.id, p_operation_id,
    'payment_paid_manually', v_result, p_actor_user_id
  );
  return v_result;
end
$function$;

comment on column public.workforce_payout_payment_items.settled_amount is
  'Actual amount confirmed paid. It can be lower than the generated instruction for a manual partial settlement.';
comment on column public.workforce_payout_payment_items.response_credit_account_no is
  'Immutable credit account recorded for the actual paid transaction; never reconstructed from the live profile.';
comment on column public.helper_payout_payment_items.settled_amount is
  'Actual amount confirmed paid. It can be lower than the generated instruction for a manual partial settlement.';
comment on column public.helper_payout_payment_items.response_credit_account_no is
  'Immutable credit account recorded for the actual paid transaction; never reconstructed from the live profile.';
comment on function public.workforce_finalize_payout_payment_item_manually(
  uuid,uuid,uuid,uuid,numeric,text,text,text,date,text,text,text
) is 'Idempotently finalizes one processing Workforce instruction for an operator-entered full or partial paid amount with immutable bank evidence.';
comment on function public.helper_finalize_payout_payment_item_manually(
  uuid,uuid,uuid,uuid,numeric,text,text,text,date,text,text,text
) is 'Idempotently finalizes one processing Helper instruction for an operator-entered full or partial paid amount with immutable bank evidence.';
comment on function public.enrich_workforce_payout_response_evidence_on_replay(
  uuid,uuid,jsonb
) is 'Private idempotent enrichment of a terminal Workforce item from an exact-core legacy response replay; never records a second settlement.';
comment on function public.enrich_helper_payout_response_evidence_on_replay(
  uuid,uuid,jsonb
) is 'Private idempotent enrichment of a terminal Helper item from an exact-core legacy response replay; never records a second settlement.';

revoke all on function public.validate_payout_payment_settlement_evidence()
  from public, anon, authenticated, service_role;
revoke all on function public.payout_bank_response_core_rows(jsonb)
  from public, anon, authenticated;
revoke all on function public.enrich_workforce_payout_response_evidence_on_replay(
  uuid,uuid,jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.enrich_helper_payout_response_evidence_on_replay(
  uuid,uuid,jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.capture_workforce_payout_response_evidence()
  from public, anon, authenticated, service_role;
revoke all on function public.capture_helper_payout_response_evidence()
  from public, anon, authenticated, service_role;
revoke all on function public.workforce_finalize_payout_payment_item_manually(
  uuid,uuid,uuid,uuid,numeric,text,text,text,date,text,text,text
) from public, anon, authenticated;
revoke all on function public.helper_finalize_payout_payment_item_manually(
  uuid,uuid,uuid,uuid,numeric,text,text,text,date,text,text,text
) from public, anon, authenticated;

grant execute on function public.workforce_finalize_payout_payment_item_manually(
  uuid,uuid,uuid,uuid,numeric,text,text,text,date,text,text,text
) to service_role;
grant execute on function public.helper_finalize_payout_payment_item_manually(
  uuid,uuid,uuid,uuid,numeric,text,text,text,date,text,text,text
) to service_role;

notify pgrst, 'reload schema';

commit;
