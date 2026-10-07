begin;

create table public.workforce_advance_import_batches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  file_name text not null,
  file_sha256 text not null,
  row_count integer not null default 0 check (row_count >= 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint workforce_advance_import_batches_hash_check
    check (file_sha256 ~ '^[0-9a-f]{64}$'),
  constraint workforce_advance_import_batches_company_hash_unique
    unique (company_id, file_sha256),
  constraint workforce_advance_import_batches_company_id_unique
    unique (company_id, id)
);

create table public.workforce_advances (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  workforce_id uuid not null,
  station_id uuid not null,
  advance_number text not null,
  advance_date date not null,
  amount numeric(18,2) not null check (amount > 0),
  payment_mode text not null default 'other'
    check (payment_mode in ('bank_transfer', 'upi', 'cash', 'other')),
  payment_reference text,
  external_reference text,
  remark text,
  source_type text not null default 'manual'
    check (source_type in ('manual', 'bulk_import')),
  source_batch_id uuid,
  source_row_number integer,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workforce_advances_company_id_unique unique (company_id, id),
  constraint workforce_advances_number_unique unique (company_id, advance_number),
  constraint workforce_advances_workforce_company_fk
    foreign key (company_id, workforce_id)
    references public.workforce(company_id, id)
    on delete restrict,
  constraint workforce_advances_station_company_fk
    foreign key (company_id, station_id)
    references public.stations(company_id, id)
    on delete restrict,
  constraint workforce_advances_batch_company_fk
    foreign key (company_id, source_batch_id)
    references public.workforce_advance_import_batches(company_id, id)
    on delete restrict,
  constraint workforce_advances_source_shape_check check (
    (source_type = 'manual' and source_batch_id is null and source_row_number is null)
    or
    (source_type = 'bulk_import' and source_batch_id is not null and source_row_number > 0)
  )
);

create unique index workforce_advances_external_reference_uidx
  on public.workforce_advances(company_id, lower(btrim(external_reference)))
  where external_reference is not null and btrim(external_reference) <> '';
create unique index workforce_advances_batch_row_uidx
  on public.workforce_advances(source_batch_id, source_row_number)
  where source_batch_id is not null;
create index workforce_advances_company_station_date_idx
  on public.workforce_advances(company_id, station_id, advance_date desc, id);
create index workforce_advances_company_workforce_date_idx
  on public.workforce_advances(company_id, workforce_id, advance_date, id);
create index workforce_advance_import_batches_created_by_idx
  on public.workforce_advance_import_batches(created_by)
  where created_by is not null;
create index workforce_advances_created_by_idx
  on public.workforce_advances(created_by)
  where created_by is not null;
create index workforce_advances_updated_by_idx
  on public.workforce_advances(updated_by)
  where updated_by is not null;

alter table public.workforce_payout_deduction_values
  alter column source_batch_id drop not null,
  alter column source_row_id drop not null,
  drop constraint workforce_payout_deduction_values_source_check;

alter table public.workforce_payout_deduction_values
  add constraint workforce_payout_deduction_values_source_check
    check (source_type in ('bulk_import', 'advance_register')),
  add constraint workforce_payout_deduction_values_source_shape_check
    check (
      (source_type = 'bulk_import' and source_batch_id is not null and source_row_id is not null)
      or
      (source_type = 'advance_register' and source_batch_id is null and source_row_id is null)
    );

-- Preserve any previously used manual ADVANCE head as a normal legacy head.
-- Reusing that head for register-controlled deductions would make its existing
-- bulk-import rows impossible to edit and would mix them with advance balances.
do $migrate_legacy_advance_heads$
declare
  v_head record;
  v_legacy_code text;
begin
  for v_head in
    select head.id, head.company_id
    from public.workforce_deduction_heads head
    where upper(btrim(head.code)) = 'ADVANCE'
      and exists (
        select 1
        from public.workforce_payout_deduction_values value
        where value.company_id = head.company_id
          and value.deduction_head_id = head.id
      )
  loop
    v_legacy_code := 'LEGACY_ADVANCE_' || upper(substr(replace(v_head.id::text, '-', ''), 1, 8));
    update public.workforce_deduction_heads
    set code = v_legacy_code,
        name = 'Legacy Advance',
        description = 'Manual advance deductions retained from before the Workforce Advance Register.',
        is_system = false,
        updated_at = now()
    where id = v_head.id and company_id = v_head.company_id;
  end loop;
end;
$migrate_legacy_advance_heads$;

insert into public.workforce_deduction_heads(
  company_id, code, name, description, calculation_type, default_value,
  percentage_without_pan, workforce_category_codes, applies_to_all, is_system, is_active
)
select
  company.id, 'ADVANCE', 'Advance',
  'Workforce advance recovery controlled by the Workforce Advance Register.',
  'manual', 0, 0, '{}'::text[], false, true, true
from public.companies company
on conflict (company_id, code) do update set
  name = excluded.name,
  description = excluded.description,
  calculation_type = 'manual',
  applies_to_all = false,
  is_system = true,
  is_active = true,
  updated_at = now();

create or replace function public.seed_workforce_advance_deduction_head()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into public.workforce_deduction_heads(
    company_id, code, name, description, calculation_type, default_value,
    percentage_without_pan, workforce_category_codes, applies_to_all, is_system, is_active
  ) values (
    new.id, 'ADVANCE', 'Advance',
    'Workforce advance recovery controlled by the Workforce Advance Register.',
    'manual', 0, 0, '{}'::text[], false, true, true
  ) on conflict (company_id, code) do nothing;
  return new;
end;
$function$;

create trigger companies_seed_workforce_advance_deduction_head
after insert on public.companies
for each row execute function public.seed_workforce_advance_deduction_head();

create or replace function public.guard_workforce_advance_deduction_head()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if upper(btrim(old.code)) <> 'ADVANCE' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'ADVANCE is managed by the Workforce Advance Register and cannot be deleted.';
  end if;
  if upper(btrim(new.code)) <> 'ADVANCE'
    or new.calculation_type <> 'manual'
    or new.is_system is distinct from true
    or new.is_active is distinct from true
    or new.applies_to_all is distinct from false
  then
    raise exception 'ADVANCE is managed by the Workforce Advance Register and its calculation settings cannot be changed.';
  end if;
  return new;
end;
$function$;

create trigger workforce_deduction_heads_00_advance_guard
before update or delete on public.workforce_deduction_heads
for each row execute function public.guard_workforce_advance_deduction_head();

create table public.workforce_advance_recoveries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  advance_id uuid not null,
  workforce_id uuid not null,
  station_id uuid not null,
  period_start date not null,
  period_end date not null,
  amount numeric(18,2) not null check (amount > 0),
  recovery_type text not null default 'payout'
    check (recovery_type in ('payout', 'opening_balance')),
  status text not null default 'deducted'
    check (status in ('deducted', 'reversed')),
  deduction_value_id uuid references public.workforce_payout_deduction_values(id) on delete set null,
  idempotency_key text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  reversed_by uuid references auth.users(id) on delete set null,
  reversed_at timestamptz,
  reversal_reason text,
  constraint workforce_advance_recoveries_period_check check (period_end >= period_start),
  constraint workforce_advance_recoveries_advance_company_fk
    foreign key (company_id, advance_id)
    references public.workforce_advances(company_id, id)
    on delete restrict,
  constraint workforce_advance_recoveries_workforce_company_fk
    foreign key (company_id, workforce_id)
    references public.workforce(company_id, id)
    on delete restrict,
  constraint workforce_advance_recoveries_station_company_fk
    foreign key (company_id, station_id)
    references public.stations(company_id, id)
    on delete restrict,
  constraint workforce_advance_recoveries_reversal_shape_check check (
    (status = 'deducted' and reversed_at is null and reversed_by is null)
    or
    (status = 'reversed' and reversed_at is not null)
  )
);

create index workforce_advance_recoveries_company_advance_idx
  on public.workforce_advance_recoveries(company_id, advance_id, status);
create index workforce_advance_recoveries_company_period_idx
  on public.workforce_advance_recoveries(company_id, period_start, period_end, workforce_id, station_id);
create index workforce_advance_recoveries_deduction_value_idx
  on public.workforce_advance_recoveries(deduction_value_id)
  where deduction_value_id is not null;
create unique index workforce_advance_recoveries_active_period_uidx
  on public.workforce_advance_recoveries(advance_id, recovery_type, period_start, period_end)
  where status = 'deducted';
create unique index workforce_advance_recoveries_active_idempotency_uidx
  on public.workforce_advance_recoveries(company_id, idempotency_key)
  where status = 'deducted';
create index workforce_advance_recoveries_created_by_idx
  on public.workforce_advance_recoveries(created_by)
  where created_by is not null;
create index workforce_advance_recoveries_reversed_by_idx
  on public.workforce_advance_recoveries(reversed_by)
  where reversed_by is not null;

create or replace function public.prepare_workforce_advance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_recovered numeric(18,2);
begin
  if new.advance_number is null or btrim(new.advance_number) = '' then
    new.advance_number := 'WA-' || to_char(new.advance_date, 'YYYYMMDD') || '-' || upper(substr(replace(new.id::text, '-', ''), 1, 8));
  else
    new.advance_number := upper(btrim(new.advance_number));
  end if;
  new.payment_reference := nullif(btrim(new.payment_reference), '');
  new.external_reference := nullif(btrim(new.external_reference), '');
  new.remark := nullif(btrim(new.remark), '');

  perform 1
  from public.workforce workforce
  where workforce.company_id = new.company_id
    and workforce.id = new.workforce_id
    and workforce.location_id = new.station_id
    and workforce.deleted_at is null
    and workforce.migration_state is distinct from 'reclassified'
  for update;
  if not found then
    raise exception 'Advance location must be the canonical Workforce member''s current location.';
  end if;

  if tg_op = 'UPDATE' and new.amount is distinct from old.amount then
    select coalesce(sum(recovery.amount) filter (where recovery.status = 'deducted'), 0)
    into v_recovered
    from public.workforce_advance_recoveries recovery
    where recovery.company_id = old.company_id
      and recovery.advance_id = old.id;
    if new.amount < v_recovered then
      raise exception 'Advance amount cannot be lower than the amount already deducted.';
    end if;
  end if;

  new.updated_at := clock_timestamp();
  return new;
end;
$function$;

create trigger workforce_advances_00_prepare
before insert or update on public.workforce_advances
for each row execute function public.prepare_workforce_advance();

create or replace function public.prepare_workforce_payout_deduction_value()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_head public.workforce_deduction_heads%rowtype;
begin
  select head.*
  into v_head
  from public.workforce_deduction_heads head
  where head.company_id = new.company_id
    and head.id = new.deduction_head_id
    and head.is_active = true
    and head.calculation_type = 'manual'
    and (
      (
        coalesce(nullif(new.source_type, ''), 'bulk_import') = 'advance_register'
        and head.is_system = true
        and upper(btrim(head.code)) = 'ADVANCE'
      )
      or
      (
        coalesce(nullif(new.source_type, ''), 'bulk_import') = 'bulk_import'
        and head.is_system = false
      )
    );

  if not found then
    raise exception 'Deduction head must be an active manual-entry head that is not system-managed in this company.';
  end if;
  if new.effective_from is null or new.effective_to is null or new.effective_to < new.effective_from then
    raise exception 'A valid deduction period is required.';
  end if;
  if new.amount is null or new.amount < 0 then
    raise exception 'Deduction amount must be zero or greater.';
  end if;
  if new.station_id is null or not exists (
    select 1 from public.stations station
    where station.company_id = new.company_id and station.id = new.station_id
  ) then
    raise exception 'Deduction location must belong to this company.';
  end if;
  if not public.workforce_additional_payment_location_is_authorized(
    new.company_id,
    new.workforce_id,
    new.station_id,
    new.effective_from,
    new.effective_to
  ) then
    raise exception 'Deduction location must be the Workforce current location or an overlapping historical payment location.';
  end if;

  new.source_type := coalesce(nullif(new.source_type, ''), 'bulk_import');
  if new.source_type = 'advance_register' and upper(btrim(v_head.code)) <> 'ADVANCE' then
    raise exception 'Workforce advance recovery must use the ADVANCE deduction head.';
  end if;
  if new.source_type = 'bulk_import' and upper(btrim(v_head.code)) = 'ADVANCE' then
    raise exception 'ADVANCE is controlled by the Workforce Advance Register and cannot be bulk uploaded as a manual deduction.';
  end if;

  new.head_code_snapshot := v_head.code;
  new.head_name_snapshot := v_head.name;
  new.import_metadata := coalesce(new.import_metadata, '{}'::jsonb);
  new.updated_at := clock_timestamp();
  return new;
end;
$function$;

create or replace function public.guard_workforce_advance_payout_import_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.input_type = 'DEDUCTION'
    and new.deduction_head_id is not null
    and exists (
      select 1
      from public.workforce_deduction_heads head
      where head.company_id = new.company_id
        and head.id = new.deduction_head_id
        and upper(btrim(head.code)) = 'ADVANCE'
    ) then
    raise exception 'ADVANCE is controlled by the Workforce Advance Register and cannot be bulk uploaded or cleared as a manual deduction.';
  end if;
  return new;
end;
$function$;

create trigger workforce_payout_import_rows_00_advance_guard
before insert or update on public.workforce_payout_import_rows
for each row execute function public.guard_workforce_advance_payout_import_row();

create or replace function public.workforce_apply_advance_import(
  p_company_id uuid,
  p_file_name text,
  p_file_sha256 text,
  p_rows jsonb,
  p_actor_user_id uuid,
  p_allowed_location_ids uuid[] default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_batch_id uuid;
  v_row jsonb;
  v_row_number integer;
  v_workforce_id uuid;
  v_station_id uuid;
  v_advance_date date;
  v_amount numeric(18,2);
  v_payment_mode text;
begin
  if p_company_id is null or p_actor_user_id is null then
    raise exception 'Company and actor are required.';
  end if;
  if p_file_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'A valid workbook fingerprint is required.';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'At least one advance row is required.';
  end if;
  if jsonb_array_length(p_rows) > 10000 then
    raise exception 'Import at most 10000 advances at a time.';
  end if;

  select batch.id into v_batch_id
  from public.workforce_advance_import_batches batch
  where batch.company_id = p_company_id
    and batch.file_sha256 = p_file_sha256;
  if found then return v_batch_id; end if;

  insert into public.workforce_advance_import_batches(
    company_id, file_name, file_sha256, row_count, created_by
  ) values (
    p_company_id, left(coalesce(nullif(btrim(p_file_name), ''), 'workforce-advances.xlsx'), 240),
    p_file_sha256, jsonb_array_length(p_rows), p_actor_user_id
  ) returning id into v_batch_id;

  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    v_row_number := nullif(v_row->>'row_number', '')::integer;
    v_workforce_id := nullif(v_row->>'workforce_id', '')::uuid;
    v_station_id := nullif(v_row->>'station_id', '')::uuid;
    v_advance_date := nullif(v_row->>'advance_date', '')::date;
    v_amount := nullif(v_row->>'amount', '')::numeric;
    v_payment_mode := coalesce(nullif(v_row->>'payment_mode', ''), 'other');

    if v_row_number is null or v_row_number < 2 then
      raise exception 'Every imported row requires its Excel row number.';
    end if;
    if v_station_id is null or not exists (
      select 1 from public.stations station
      where station.company_id = p_company_id and station.id = v_station_id
    ) then
      raise exception 'Row % does not identify a company location.', v_row_number;
    end if;
    if p_allowed_location_ids is not null and not (v_station_id = any(p_allowed_location_ids)) then
      raise exception 'Row % is outside the importing user''s location scope.', v_row_number;
    end if;
    perform 1
    from public.workforce workforce
    where workforce.company_id = p_company_id
      and workforce.id = v_workforce_id
      and workforce.location_id = v_station_id
      and workforce.deleted_at is null
      and workforce.migration_state is distinct from 'reclassified'
    for update;
    if not found then
      raise exception 'Row % does not identify a canonical Workforce member at its current location.', v_row_number;
    end if;
    if v_advance_date is null or v_amount is null or v_amount <= 0 then
      raise exception 'Row % requires a valid advance date and positive amount.', v_row_number;
    end if;

    insert into public.workforce_advances(
      company_id, workforce_id, station_id, advance_number, advance_date,
      amount, payment_mode, payment_reference, external_reference, remark,
      source_type, source_batch_id, source_row_number, created_by, updated_by
    ) values (
      p_company_id, v_workforce_id, v_station_id,
      'WA-' || to_char(v_advance_date, 'YYYYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
      v_advance_date, v_amount, v_payment_mode,
      nullif(v_row->>'payment_reference', ''), nullif(v_row->>'external_reference', ''),
      nullif(v_row->>'remark', ''), 'bulk_import', v_batch_id, v_row_number,
      p_actor_user_id, p_actor_user_id
    );
  end loop;

  return v_batch_id;
exception
  when unique_violation then
    if v_batch_id is not null then
      select batch.id into v_batch_id
      from public.workforce_advance_import_batches batch
      where batch.company_id = p_company_id and batch.file_sha256 = p_file_sha256;
      if found then return v_batch_id; end if;
    end if;
    raise;
end;
$function$;

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
  select md5(jsonb_build_object(
    'payout_inputs', public.workforce_payout_input_snapshot_hash(
      p_company_id, p_period_start, p_period_end
    ),
    'direct_allocations', public.workforce_payment_allocation_snapshot_hash(
      p_company_id, p_period_start, p_period_end
    ),
    'payment_policy', public.workforce_payment_policy_snapshot_hash(
      p_company_id, p_period_start, p_period_end
    ),
    'provider_mappings', (
      select md5(coalesce(jsonb_agg(
        jsonb_build_object(
          'id', mapping.id::text,
          'provider_member_id', mapping.provider_member_id,
          'station_id', mapping.station_id::text,
          'provider_id', mapping.provider_id::text,
          'workforce_id', mapping.workforce_id::text,
          'contractor_id', mapping.contractor_id::text,
          'employee_id', mapping.employee_id::text,
          'field_executive_id', mapping.field_executive_id::text,
          'payment_method_id', mapping.payment_method_id::text,
          'payment_values', mapping.payment_values,
          'production_threshold_config', mapping.production_threshold_config,
          'effective_from', mapping.effective_from,
          'effective_to', mapping.effective_to,
          'status', mapping.status
        ) order by mapping.id
      )::text, '[]'))
      from public.field_executive_provider_mappings mapping
      where mapping.company_id = p_company_id
        and mapping.status in ('active', 'closed')
        and mapping.effective_from <= p_period_end
        and (
          mapping.effective_to is null
          or mapping.effective_to >= date_trunc('month', p_period_start)::date
        )
    )
  )::text);
$function$;

create or replace function public.workforce_apply_advance_recoveries(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_period_start date,
  p_period_end date,
  p_items jsonb,
  p_allowed_location_ids uuid[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_head public.workforce_deduction_heads%rowtype;
  v_item jsonb;
  v_workforce_id uuid;
  v_station_id uuid;
  v_max_amount numeric(18,2);
  v_remaining_cap numeric(18,2);
  v_recovered numeric(18,2);
  v_take numeric(18,2);
  v_deduction_value_id uuid;
  v_existing_source text;
  v_expected_snapshot_hash text;
  v_current_snapshot_hash text;
  v_advance record;
  v_results jsonb := '[]'::jsonb;
begin
  if p_company_id is null or p_actor_user_id is null then
    raise exception 'Company and actor are required.';
  end if;
  if p_period_start is null or p_period_end is null or p_period_end < p_period_start then
    raise exception 'A valid payout period is required.';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Select at least one Workforce payout.';
  end if;
  if jsonb_array_length(p_items) > 1000 then
    raise exception 'Apply advances to at most 1000 payouts at a time.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_items) item
    group by lower(item->>'workforce_id')
    having count(*) > 1
  ) then
    raise exception 'A Workforce member can be selected only once per recovery batch.';
  end if;

  v_expected_snapshot_hash := nullif(p_items->0->>'snapshot_hash', '');
  if v_expected_snapshot_hash is null or exists (
    select 1 from jsonb_array_elements(p_items) item
    where nullif(item->>'snapshot_hash', '') is distinct from v_expected_snapshot_hash
  ) then
    raise exception 'The payout calculation snapshot is missing or inconsistent. Refresh the page and try again.';
  end if;

  perform 1
  from public.workforce workforce
  where workforce.company_id = p_company_id
    and workforce.id in (
      select (item->>'workforce_id')::uuid
      from jsonb_array_elements(p_items) item
    )
  order by workforce.id
  for update;
  perform public.lock_workforce_payment_allocation_company(p_company_id);
  v_current_snapshot_hash := public.workforce_advance_recovery_snapshot_hash(
    p_company_id,
    p_period_start,
    p_period_end
  );
  if v_current_snapshot_hash is distinct from v_expected_snapshot_hash then
    raise exception 'Payout inputs changed while advances were being prepared. Refresh the page and try again.';
  end if;

  select head.* into v_head
  from public.workforce_deduction_heads head
  where head.company_id = p_company_id
    and upper(btrim(head.code)) = 'ADVANCE'
    and head.is_active = true
    and head.calculation_type = 'manual'
    and head.is_system = true;
  if not found then
    raise exception 'The system-managed ADVANCE deduction head is unavailable.';
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_workforce_id := nullif(v_item->>'workforce_id', '')::uuid;
    v_station_id := nullif(v_item->>'station_id', '')::uuid;
    v_max_amount := round(coalesce(nullif(v_item->>'max_amount', '')::numeric, 0), 2);

    if v_workforce_id is null or v_station_id is null or v_max_amount < 0 then
      raise exception 'Every recovery item requires Workforce, location, and a non-negative available amount.';
    end if;
    perform 1 from public.workforce workforce
    where workforce.company_id = p_company_id
      and workforce.id = v_workforce_id
      and workforce.deleted_at is null
      and workforce.migration_state is distinct from 'reclassified'
    for update;
    if not found then raise exception 'A selected Workforce member no longer exists.'; end if;
    if not exists (
      select 1 from public.stations station
      where station.company_id = p_company_id and station.id = v_station_id
    ) then
      raise exception 'A selected payout location no longer exists.';
    end if;
    if p_allowed_location_ids is not null and not (v_station_id = any(p_allowed_location_ids)) then
      raise exception 'A selected payout is outside your location scope.';
    end if;
    if not public.workforce_additional_payment_location_is_authorized(
      p_company_id, v_workforce_id, v_station_id, p_period_start, p_period_end
    ) then
      raise exception 'The selected payout location is not valid for this Workforce member and period.';
    end if;

    select value.source_type into v_existing_source
    from public.workforce_payout_deduction_values value
    where value.company_id = p_company_id
      and value.deduction_head_id = v_head.id
      and value.workforce_id = v_workforce_id
      and value.effective_from = p_period_start
      and value.effective_to = p_period_end
    for update;
    if found and v_existing_source <> 'advance_register' then
      raise exception 'The ADVANCE deduction for this Workforce member and period was created outside the advance register and cannot be replaced.';
    end if;

    update public.workforce_advance_recoveries recovery
    set status = 'reversed',
        reversed_by = p_actor_user_id,
        reversed_at = clock_timestamp(),
        reversal_reason = 'Recalculated for the same Workforce payout period'
    where recovery.company_id = p_company_id
      and recovery.workforce_id = v_workforce_id
      and recovery.recovery_type = 'payout'
      and recovery.period_start = p_period_start
      and recovery.period_end = p_period_end
      and recovery.status = 'deducted';

    perform 1
    from public.workforce_advances advance
    where advance.company_id = p_company_id
      and advance.workforce_id = v_workforce_id
      and advance.advance_date <= p_period_end
    order by advance.advance_date, advance.id
    for update;

    v_remaining_cap := v_max_amount;
    v_recovered := 0;
    for v_advance in
      select advance.id, advance.amount - coalesce((
        select sum(recovery.amount)
        from public.workforce_advance_recoveries recovery
        where recovery.company_id = p_company_id
          and recovery.advance_id = advance.id
          and recovery.status = 'deducted'
      ), 0) as pending_amount
      from public.workforce_advances advance
      where advance.company_id = p_company_id
        and advance.workforce_id = v_workforce_id
        and advance.advance_date <= p_period_end
      order by advance.advance_date, advance.created_at, advance.id
    loop
      exit when v_remaining_cap <= 0;
      v_take := least(greatest(v_advance.pending_amount, 0), v_remaining_cap);
      if v_take > 0 then
        insert into public.workforce_advance_recoveries(
          company_id, advance_id, workforce_id, station_id,
          period_start, period_end, amount, recovery_type, status,
          idempotency_key, created_by
        ) values (
          p_company_id, v_advance.id, v_workforce_id, v_station_id,
          p_period_start, p_period_end, v_take, 'payout', 'deducted',
          v_advance.id::text || ':' || p_period_start::text || ':' || p_period_end::text,
          p_actor_user_id
        );
        v_recovered := v_recovered + v_take;
        v_remaining_cap := v_remaining_cap - v_take;
      end if;
    end loop;

    if v_recovered > 0 then
      insert into public.workforce_payout_deduction_values(
        company_id, deduction_head_id, workforce_id, station_id,
        head_code_snapshot, head_name_snapshot, effective_from, effective_to,
        amount, source_type, source_batch_id, source_row_id, import_metadata,
        created_by, updated_by
      ) values (
        p_company_id, v_head.id, v_workforce_id, v_station_id,
        v_head.code, v_head.name, p_period_start, p_period_end,
        v_recovered, 'advance_register', null, null,
        jsonb_build_object('source', 'workforce_advance_register'),
        p_actor_user_id, p_actor_user_id
      )
      on conflict (company_id, deduction_head_id, workforce_id, effective_from, effective_to)
      do update set
        station_id = excluded.station_id,
        amount = excluded.amount,
        source_type = 'advance_register',
        source_batch_id = null,
        source_row_id = null,
        import_metadata = excluded.import_metadata,
        updated_by = excluded.updated_by,
        updated_at = clock_timestamp()
      returning id into v_deduction_value_id;

      update public.workforce_advance_recoveries recovery
      set deduction_value_id = v_deduction_value_id
      where recovery.company_id = p_company_id
        and recovery.workforce_id = v_workforce_id
        and recovery.station_id = v_station_id
        and recovery.recovery_type = 'payout'
        and recovery.period_start = p_period_start
        and recovery.period_end = p_period_end
        and recovery.status = 'deducted';
    else
      delete from public.workforce_payout_deduction_values value
      where value.company_id = p_company_id
        and value.deduction_head_id = v_head.id
        and value.workforce_id = v_workforce_id
        and value.effective_from = p_period_start
        and value.effective_to = p_period_end
        and value.source_type = 'advance_register';
    end if;

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'workforce_id', v_workforce_id,
      'station_id', v_station_id,
      'deducted', v_recovered
    ));
  end loop;

  return v_results;
end;
$function$;

comment on table public.workforce_advances is
  'Canonical Workforce advance-payment register. Deducted and pending balances are derived from immutable recovery rows.';
comment on table public.workforce_advance_recoveries is
  'FIFO Workforce advance recoveries applied to exact payout periods through the system-managed ADVANCE deduction head.';
comment on function public.workforce_apply_advance_import(uuid, text, text, jsonb, uuid, uuid[]) is
  'Atomically imports validated historical Workforce advances once per workbook fingerprint.';
comment on function public.workforce_advance_recovery_snapshot_hash(uuid, date, date) is
  'Hashes payout inputs, direct allocations, payment policies and provider mappings used to cap advance recovery.';
comment on function public.workforce_apply_advance_recoveries(uuid, uuid, date, date, jsonb, uuid[]) is
  'Idempotently recalculates FIFO advance recovery for selected Workforce payouts without exceeding the server-calculated available net pay.';

alter table public.workforce_advance_import_batches enable row level security;
alter table public.workforce_advances enable row level security;
alter table public.workforce_advance_recoveries enable row level security;

revoke all on table public.workforce_advance_import_batches, public.workforce_advances,
  public.workforce_advance_recoveries from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.workforce_advance_import_batches,
  public.workforce_advances, public.workforce_advance_recoveries to service_role;

create policy workforce_advance_import_batches_service_role_all
  on public.workforce_advance_import_batches for all to service_role using (true) with check (true);
create policy workforce_advances_service_role_all
  on public.workforce_advances for all to service_role using (true) with check (true);
create policy workforce_advance_recoveries_service_role_all
  on public.workforce_advance_recoveries for all to service_role using (true) with check (true);

revoke all on function public.prepare_workforce_advance(),
  public.seed_workforce_advance_deduction_head(),
  public.guard_workforce_advance_deduction_head(),
  public.guard_workforce_advance_payout_import_row(),
  public.workforce_advance_recovery_snapshot_hash(uuid, date, date),
  public.workforce_apply_advance_import(uuid, text, text, jsonb, uuid, uuid[]),
  public.workforce_apply_advance_recoveries(uuid, uuid, date, date, jsonb, uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.workforce_apply_advance_import(uuid, text, text, jsonb, uuid, uuid[]),
  public.workforce_apply_advance_recoveries(uuid, uuid, date, date, jsonb, uuid[]),
  public.workforce_advance_recovery_snapshot_hash(uuid, date, date)
  to service_role;

insert into public.app_pages(company_id, code, name, sort_order, is_active, created_at, updated_at)
select company.id, page.code, page.name, page.sort_order, true, now(), now()
from public.companies company
cross join (values
  ('workforce_advances', 'Workforce Advance Register', 111),
  ('ops_workforce_advances', 'Workforce Advance Register', 91)
) as page(code, name, sort_order)
on conflict (company_id, code) do update set
  name = excluded.name,
  sort_order = excluded.sort_order,
  is_active = true,
  updated_at = now();

notify pgrst, 'reload schema';

commit;
