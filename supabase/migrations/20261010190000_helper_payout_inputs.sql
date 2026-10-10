begin;

create extension if not exists pgcrypto;
create extension if not exists btree_gist;

create unique index if not exists helpers_company_id_id_uidx
  on public.helpers (company_id, id);
create unique index if not exists stations_company_id_id_uidx
  on public.stations (company_id, id);
create unique index if not exists workforce_additional_payment_fields_company_id_id_uidx
  on public.workforce_additional_payment_fields (company_id, id);
create unique index if not exists workforce_deduction_heads_company_id_id_uidx
  on public.workforce_deduction_heads (company_id, id);

create table public.helper_payout_import_batches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  effective_from date not null,
  effective_to date not null,
  file_name text not null,
  file_sha256 text not null,
  status text not null default 'committed',
  row_count integer not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  committed_at timestamptz not null default now(),
  constraint helper_payout_import_batches_period_check check (effective_to >= effective_from),
  constraint helper_payout_import_batches_file_name_check check (btrim(file_name) <> '' and length(file_name) <= 240),
  constraint helper_payout_import_batches_sha_check check (file_sha256 ~ '^[0-9a-f]{64}$'),
  constraint helper_payout_import_batches_status_check check (status in ('committed', 'failed')),
  constraint helper_payout_import_batches_row_count_check check (row_count between 1 and 10000),
  constraint helper_payout_import_batches_idempotency_unique
    unique (company_id, effective_from, effective_to, file_sha256)
);

create index helper_payout_import_batches_company_created_idx
  on public.helper_payout_import_batches (company_id, created_at desc);

create table public.helper_payout_import_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.helper_payout_import_batches(id) on delete restrict,
  company_id uuid not null references public.companies(id) on delete restrict,
  row_number integer not null,
  action text not null,
  helper_id uuid not null,
  dropx_id_snapshot text not null,
  station_id uuid not null,
  input_type text not null,
  additional_payment_field_id uuid,
  deduction_head_id uuid,
  field_code_snapshot text not null,
  effective_from date not null,
  effective_to date not null,
  numeric_value numeric(18,4),
  remark text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint helper_payout_import_rows_batch_row_unique unique (batch_id, row_number),
  constraint helper_payout_import_rows_helper_company_fk
    foreign key (company_id, helper_id) references public.helpers (company_id, id) on delete restrict,
  constraint helper_payout_import_rows_station_company_fk
    foreign key (company_id, station_id) references public.stations (company_id, id) on delete restrict,
  constraint helper_payout_import_rows_additional_field_company_fk
    foreign key (company_id, additional_payment_field_id)
    references public.workforce_additional_payment_fields (company_id, id) on delete restrict,
  constraint helper_payout_import_rows_deduction_head_company_fk
    foreign key (company_id, deduction_head_id)
    references public.workforce_deduction_heads (company_id, id) on delete restrict,
  constraint helper_payout_import_rows_row_number_check check (row_number >= 2),
  constraint helper_payout_import_rows_action_check check (action in ('UPSERT', 'CLEAR')),
  constraint helper_payout_import_rows_input_type_check
    check (input_type in ('ATTENDANCE', 'ADDITIONAL_PAYMENT', 'DEDUCTION')),
  constraint helper_payout_import_rows_period_check check (effective_to >= effective_from),
  constraint helper_payout_import_rows_value_check
    check ((action = 'CLEAR' and numeric_value is null) or (action = 'UPSERT' and numeric_value >= 0)),
  constraint helper_payout_import_rows_field_shape_check check (
    (input_type = 'ATTENDANCE' and field_code_snapshot in ('WORK_HOURS', 'WORK_DAYS')
      and additional_payment_field_id is null and deduction_head_id is null)
    or (input_type = 'ADDITIONAL_PAYMENT' and additional_payment_field_id is not null and deduction_head_id is null)
    or (input_type = 'DEDUCTION' and additional_payment_field_id is null and deduction_head_id is not null)
  ),
  constraint helper_payout_import_rows_raw_payload_check check (jsonb_typeof(raw_payload) = 'object')
);

create index helper_payout_import_rows_company_period_idx
  on public.helper_payout_import_rows (company_id, effective_from, effective_to, helper_id);

create table public.helper_payout_attendance_values (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  helper_id uuid not null,
  station_id uuid not null,
  attendance_basis text not null,
  effective_from date not null,
  effective_to date not null,
  quantity numeric(18,4) not null,
  source_batch_id uuid not null references public.helper_payout_import_batches(id) on delete restrict,
  source_row_id uuid not null references public.helper_payout_import_rows(id) on delete restrict,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint helper_payout_attendance_values_helper_company_fk
    foreign key (company_id, helper_id) references public.helpers (company_id, id) on delete restrict,
  constraint helper_payout_attendance_values_station_company_fk
    foreign key (company_id, station_id) references public.stations (company_id, id) on delete restrict,
  constraint helper_payout_attendance_values_exact_period_unique
    unique (company_id, helper_id, effective_from, effective_to),
  constraint helper_payout_attendance_values_no_overlap exclude using gist (
    company_id with =,
    helper_id with =,
    daterange(effective_from, effective_to, '[]') with &&
  ),
  constraint helper_payout_attendance_values_basis_check check (attendance_basis in ('hours', 'days')),
  constraint helper_payout_attendance_values_period_check check (effective_to >= effective_from),
  constraint helper_payout_attendance_values_single_month_check check (
    extract(year from effective_from) = extract(year from effective_to)
    and extract(month from effective_from) = extract(month from effective_to)
  ),
  constraint helper_payout_attendance_values_quantity_check check (quantity >= 0),
  constraint helper_payout_attendance_values_capacity_check check (
    (attendance_basis = 'hours' and quantity <= ((effective_to - effective_from + 1) * 24))
    or (attendance_basis = 'days' and quantity <= (effective_to - effective_from + 1))
  )
);

create index helper_payout_attendance_values_company_period_idx
  on public.helper_payout_attendance_values (company_id, effective_from, effective_to, helper_id);
create index helper_payout_attendance_values_station_period_idx
  on public.helper_payout_attendance_values (company_id, station_id, effective_from, effective_to);

create table public.helper_additional_payment_values (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  additional_payment_field_id uuid not null,
  helper_id uuid not null,
  station_id uuid not null,
  field_code_snapshot text not null,
  field_name_snapshot text not null,
  calculation_type_snapshot text not null,
  effective_from date not null,
  effective_to date not null,
  input_value numeric(18,4) not null,
  rate_value numeric(18,4),
  final_amount numeric(18,2) not null,
  source_batch_id uuid not null references public.helper_payout_import_batches(id) on delete restrict,
  source_row_id uuid not null references public.helper_payout_import_rows(id) on delete restrict,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint helper_additional_payment_values_field_company_fk
    foreign key (company_id, additional_payment_field_id)
    references public.workforce_additional_payment_fields (company_id, id) on delete restrict,
  constraint helper_additional_payment_values_helper_company_fk
    foreign key (company_id, helper_id) references public.helpers (company_id, id) on delete restrict,
  constraint helper_additional_payment_values_station_company_fk
    foreign key (company_id, station_id) references public.stations (company_id, id) on delete restrict,
  constraint helper_additional_payment_values_exact_period_unique
    unique (company_id, additional_payment_field_id, helper_id, effective_from, effective_to),
  constraint helper_additional_payment_values_no_overlap exclude using gist (
    company_id with =,
    additional_payment_field_id with =,
    helper_id with =,
    daterange(effective_from, effective_to, '[]') with &&
  ),
  constraint helper_additional_payment_values_period_check check (effective_to >= effective_from),
  constraint helper_additional_payment_values_input_check check (input_value >= 0),
  constraint helper_additional_payment_values_rate_check check (rate_value is null or rate_value >= 0),
  constraint helper_additional_payment_values_amount_check check (final_amount >= 0),
  constraint helper_additional_payment_values_calculation_check check (
    (calculation_type_snapshot = 'manual_amount' and rate_value is null and final_amount = round(input_value, 2))
    or (calculation_type_snapshot = 'units_x_rate' and rate_value is not null and final_amount = round(input_value * rate_value, 2))
  )
);

create index helper_additional_payment_values_company_period_idx
  on public.helper_additional_payment_values (company_id, effective_from, effective_to, helper_id);
create index helper_additional_payment_values_station_period_idx
  on public.helper_additional_payment_values (company_id, station_id, effective_from, effective_to);

create table public.helper_payout_deduction_values (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  deduction_head_id uuid not null,
  helper_id uuid not null,
  station_id uuid not null,
  head_code_snapshot text not null,
  head_name_snapshot text not null,
  effective_from date not null,
  effective_to date not null,
  amount numeric(18,2) not null,
  source_batch_id uuid not null references public.helper_payout_import_batches(id) on delete restrict,
  source_row_id uuid not null references public.helper_payout_import_rows(id) on delete restrict,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint helper_payout_deduction_values_head_company_fk
    foreign key (company_id, deduction_head_id)
    references public.workforce_deduction_heads (company_id, id) on delete restrict,
  constraint helper_payout_deduction_values_helper_company_fk
    foreign key (company_id, helper_id) references public.helpers (company_id, id) on delete restrict,
  constraint helper_payout_deduction_values_station_company_fk
    foreign key (company_id, station_id) references public.stations (company_id, id) on delete restrict,
  constraint helper_payout_deduction_values_exact_period_unique
    unique (company_id, deduction_head_id, helper_id, effective_from, effective_to),
  constraint helper_payout_deduction_values_no_overlap exclude using gist (
    company_id with =,
    deduction_head_id with =,
    helper_id with =,
    daterange(effective_from, effective_to, '[]') with &&
  ),
  constraint helper_payout_deduction_values_period_check check (effective_to >= effective_from),
  constraint helper_payout_deduction_values_amount_check check (amount >= 0)
);

create index helper_payout_deduction_values_company_period_idx
  on public.helper_payout_deduction_values (company_id, effective_from, effective_to, helper_id);
create index helper_payout_deduction_values_station_period_idx
  on public.helper_payout_deduction_values (company_id, station_id, effective_from, effective_to);

comment on table public.helper_payout_import_batches is
  'Immutable audit record for one atomically committed Helper payout input workbook or manual edit batch.';
comment on table public.helper_payout_import_rows is
  'Immutable normalized Helper payout input row audit, including exact CLEAR actions.';
comment on table public.helper_payout_attendance_values is
  'Payout-only aggregate WORK_HOURS or WORK_DAYS values for Helpers; biometric attendance facts are not changed.';
comment on table public.helper_additional_payment_values is
  'Exact-period Helper additional payments using the shared company additional-payment field catalog.';
comment on table public.helper_payout_deduction_values is
  'Exact-period non-system manual deductions for Helpers; automatic deductions remain calculation-driven.';

-- This stable hook deliberately has no dependency on a bank-ledger migration.
-- The Helper bank migration replaces the body to inspect processing items while
-- the importer keeps calling the same signature under its mutation locks.
create or replace function public.helper_payout_input_processing_locked(
  p_company_id uuid,
  p_helper_id uuid,
  p_station_id uuid,
  p_effective_from date,
  p_effective_to date
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select false;
$$;

comment on function public.helper_payout_input_processing_locked(uuid, uuid, uuid, date, date) is
  'Extension hook for the Helper bank ledger. Replace its body to return true while an overlapping Helper payment item is Payment Processing.';

create or replace function public.helper_apply_payout_import(
  p_company_id uuid,
  p_effective_from date,
  p_effective_to date,
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
  v_import_row_id uuid;
  v_row jsonb;
  v_row_number integer;
  v_action text;
  v_input_type text;
  v_helper_id uuid;
  v_station_id uuid;
  v_additional_field_id uuid;
  v_deduction_head_id uuid;
  v_from date;
  v_to date;
  v_numeric_value numeric(18,4);
  v_dropx_id text;
  v_field_code text;
  v_remark text;
  v_helper public.helpers%rowtype;
  v_additional_field public.workforce_additional_payment_fields%rowtype;
  v_deduction_head public.workforce_deduction_heads%rowtype;
  v_allocation_components jsonb;
  v_cover_count integer;
  v_has_hours boolean;
  v_has_days boolean;
  v_basis text;
  v_duplicate record;
begin
  if p_company_id is null then raise exception 'Company is required.'; end if;
  if p_effective_from is null or p_effective_to is null or p_effective_to < p_effective_from then
    raise exception 'A valid payout import period is required.';
  end if;
  if btrim(coalesce(p_file_name, '')) = '' or length(p_file_name) > 240 then
    raise exception 'A valid payout input file name is required.';
  end if;
  if coalesce(p_file_sha256, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'A valid payout input fingerprint is required.';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array'
    or jsonb_array_length(p_rows) < 1 or jsonb_array_length(p_rows) > 10000 then
    raise exception 'Payout input rows must be a JSON array containing 1 to 10000 rows.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('helper-payout-inputs:' || p_company_id::text, 0));

  select batch.id into v_batch_id
  from public.helper_payout_import_batches batch
  where batch.company_id = p_company_id
    and batch.effective_from = p_effective_from
    and batch.effective_to = p_effective_to
    and batch.file_sha256 = p_file_sha256
    and batch.status = 'committed';
  if found then return v_batch_id; end if;

  -- Every payout writer uses one deterministic Helper lock order. Validate the
  -- identity text before casting, then pre-lock distinct Helpers by UUID so a
  -- caller's workbook row order cannot deadlock bank creation or publication
  -- (whose cohorts are also locked in sorted Helper order). The validation
  -- loop below retains the row-specific company/DropX error messages.
  if exists (
    select 1
    from jsonb_array_elements(p_rows) row_item
    where coalesce(row_item ->> 'helper_id', '')
      !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    raise exception 'A Helper payout input row contains an invalid identifier, date, row number, or value.';
  end if;
  perform 1
  from public.helpers helper
  where helper.company_id = p_company_id
    and helper.id in (
      select distinct (row_item ->> 'helper_id')::uuid
      from jsonb_array_elements(p_rows) row_item
    )
  order by helper.id
  for update;

  -- Validate every row while the company import mutex is held. No current
  -- value or audit row is written until the complete payload has passed.
  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    begin
      v_row_number := (v_row ->> 'row_number')::integer;
      v_helper_id := (v_row ->> 'helper_id')::uuid;
      v_station_id := (v_row ->> 'station_id')::uuid;
      v_from := (v_row ->> 'effective_from')::date;
      v_to := (v_row ->> 'effective_to')::date;
      v_additional_field_id := nullif(v_row ->> 'additional_payment_field_id', '')::uuid;
      v_deduction_head_id := nullif(v_row ->> 'deduction_head_id', '')::uuid;
      v_numeric_value := nullif(v_row ->> 'numeric_value', '')::numeric(18,4);
    exception when others then
      raise exception 'A Helper payout input row contains an invalid identifier, date, row number, or value.';
    end;
    v_action := upper(btrim(coalesce(v_row ->> 'action', '')));
    v_input_type := upper(btrim(coalesce(v_row ->> 'input_type', '')));
    v_dropx_id := upper(btrim(coalesce(v_row ->> 'dropx_id', '')));
    v_field_code := upper(btrim(coalesce(v_row ->> 'field_code', '')));

    if v_row_number < 2 then raise exception 'Helper payout input row numbers must start at 2.'; end if;
    if v_action not in ('UPSERT', 'CLEAR') then raise exception 'Row % has an unsupported action.', v_row_number; end if;
    if v_input_type not in ('ATTENDANCE', 'ADDITIONAL_PAYMENT', 'DEDUCTION') then
      raise exception 'Row % has an unsupported Helper payout input type.', v_row_number;
    end if;
    if v_from < p_effective_from or v_to > p_effective_to or v_to < v_from then
      raise exception 'Row % must stay inside the selected payout period.', v_row_number;
    end if;
    if (v_action = 'UPSERT' and (v_numeric_value is null or v_numeric_value < 0))
      or (v_action = 'CLEAR' and v_numeric_value is not null) then
      raise exception 'Row % has an invalid VALUE for its action.', v_row_number;
    end if;
    if p_allowed_location_ids is not null and not (v_station_id = any(p_allowed_location_ids)) then
      raise exception 'Row % is outside your location scope.', v_row_number;
    end if;

    select helper.* into v_helper
    from public.helpers helper
    where helper.company_id = p_company_id and helper.id = v_helper_id
    for update;
    if not found then raise exception 'Row % Helper does not belong to this company.', v_row_number; end if;
    if upper(btrim(coalesce(v_helper.dropx_id, ''))) <> v_dropx_id then
      raise exception 'Row % DropX ID does not match the selected Helper.', v_row_number;
    end if;
    if v_helper.date_of_join is not null and v_from < v_helper.date_of_join then
      raise exception 'Row % starts before the Helper joining date.', v_row_number;
    end if;
    if not exists (select 1 from public.stations station where station.company_id = p_company_id and station.id = v_station_id) then
      raise exception 'Row % location does not belong to this company.', v_row_number;
    end if;
    if public.helper_payout_input_processing_locked(p_company_id, v_helper_id, v_station_id, v_from, v_to) then
      raise exception 'Row % cannot change because the Helper payment is Payment Processing.', v_row_number;
    end if;

    if v_input_type = 'ATTENDANCE' then
      if v_field_code not in ('WORK_HOURS', 'WORK_DAYS') then
        raise exception 'Row % attendance FIELD_CODE must be WORK_HOURS or WORK_DAYS.', v_row_number;
      end if;
      v_basis := case when v_field_code = 'WORK_HOURS' then 'hours' else 'days' end;
      if date_trunc('month', v_from::timestamp) <> date_trunc('month', v_to::timestamp) then
        raise exception 'Row % attendance range cannot cross a calendar month.', v_row_number;
      end if;
      if v_action = 'UPSERT' and ((v_basis = 'hours' and v_numeric_value > ((v_to - v_from + 1) * 24))
        or (v_basis = 'days' and v_numeric_value > (v_to - v_from + 1))) then
        raise exception 'Row % attendance VALUE exceeds the effective-range capacity.', v_row_number;
      end if;
      if v_action = 'UPSERT' then
        select count(*)::integer into v_cover_count
        from public.helper_payment_allocations allocation
        where allocation.company_id = p_company_id
          and allocation.helper_id = v_helper_id
          and allocation.station_id = v_station_id
          and allocation.status in ('active', 'closed')
          and allocation.effective_from <= v_from
          and (allocation.effective_to is null or allocation.effective_to >= v_to);
        if v_cover_count <> 1 then
          raise exception 'Row % attendance requires exactly one Helper payment allocation covering the complete range.', v_row_number;
        end if;
        select allocation.payment_components into v_allocation_components
        from public.helper_payment_allocations allocation
        where allocation.company_id = p_company_id
          and allocation.helper_id = v_helper_id
          and allocation.station_id = v_station_id
          and allocation.status in ('active', 'closed')
          and allocation.effective_from <= v_from
          and (allocation.effective_to is null or allocation.effective_to >= v_to)
        limit 1;
        select
          coalesce(bool_or(lower(coalesce(component ->> 'pay_schedule', '')) = 'per_hour'), false),
          coalesce(bool_or(lower(coalesce(component ->> 'pay_schedule', '')) in ('per_day', 'per_month')), false)
        into v_has_hours, v_has_days
        from jsonb_array_elements(coalesce(v_allocation_components, '[]'::jsonb)) component
        where lower(coalesce(component ->> 'component_type', '')) <> 'production'
          and lower(coalesce(component ->> 'calculation_source', '')) = 'attendance_eligibility';
        if v_has_hours = v_has_days then
          raise exception 'Row % payment allocation must have exactly one attendance basis.', v_row_number;
        end if;
        if (v_has_hours and v_basis <> 'hours') or (v_has_days and v_basis <> 'days') then
          raise exception 'Row % attendance FIELD_CODE does not match the Helper payment allocation.', v_row_number;
        end if;
      end if;
    else
      if v_station_id <> v_helper.location_id and not exists (
        select 1 from public.helper_payment_allocations allocation
        where allocation.company_id = p_company_id
          and allocation.helper_id = v_helper_id
          and allocation.station_id = v_station_id
          and allocation.status in ('active', 'closed')
          and allocation.effective_from <= v_to
          and (allocation.effective_to is null or allocation.effective_to >= v_from)
      ) then
        raise exception 'Row % adjustment location must be the Helper current location or an overlapping payment location.', v_row_number;
      end if;
    end if;

    if v_input_type = 'ADDITIONAL_PAYMENT' then
      select field.* into v_additional_field
      from public.workforce_additional_payment_fields field
      where field.company_id = p_company_id and field.id = v_additional_field_id;
      if not found or upper(btrim(v_additional_field.code)) <> v_field_code then
        raise exception 'Row % additional payment field is invalid.', v_row_number;
      end if;
      if v_action = 'UPSERT' and (not v_additional_field.is_active
        or (v_additional_field.calculation_type = 'units_x_rate' and v_additional_field.default_rate_value is null)) then
        raise exception 'Row % additional payment field is not available for input.', v_row_number;
      end if;
    elsif v_input_type = 'DEDUCTION' then
      select head.* into v_deduction_head
      from public.workforce_deduction_heads head
      where head.company_id = p_company_id and head.id = v_deduction_head_id;
      if not found or upper(btrim(v_deduction_head.code)) <> v_field_code then
        raise exception 'Row % deduction head is invalid.', v_row_number;
      end if;
      if v_action = 'UPSERT' and (not v_deduction_head.is_active
        or v_deduction_head.is_system or v_deduction_head.calculation_type <> 'manual') then
        raise exception 'Row % deduction head is not an active non-system manual deduction.', v_row_number;
      end if;
      if v_action = 'UPSERT' and round(v_numeric_value, 2) <> v_numeric_value then
        raise exception 'Row % deduction VALUE can have at most two decimal places.', v_row_number;
      end if;
    end if;
  end loop;

  select duplicate_row.* into v_duplicate
  from (
    select
      min((row_item ->> 'row_number')::integer) first_row,
      max((row_item ->> 'row_number')::integer) duplicate_row,
      upper(row_item ->> 'input_type') input_type
    from jsonb_array_elements(p_rows) row_item
    group by
      row_item ->> 'helper_id',
      upper(row_item ->> 'input_type'),
      coalesce(row_item ->> 'additional_payment_field_id', ''),
      coalesce(row_item ->> 'deduction_head_id', ''),
      row_item ->> 'effective_from',
      row_item ->> 'effective_to'
    having count(*) > 1
    limit 1
  ) duplicate_row;
  if found then
    raise exception 'Row % duplicates resolved % input from row %.',
      v_duplicate.duplicate_row, v_duplicate.input_type, v_duplicate.first_row;
  end if;

  insert into public.helper_payout_import_batches (
    company_id, effective_from, effective_to, file_name, file_sha256,
    status, row_count, created_by, committed_at
  ) values (
    p_company_id, p_effective_from, p_effective_to, p_file_name, p_file_sha256,
    'committed', jsonb_array_length(p_rows), p_actor_user_id, clock_timestamp()
  ) returning id into v_batch_id;

  for v_row in select value from jsonb_array_elements(p_rows) order by (value ->> 'row_number')::integer
  loop
    v_row_number := (v_row ->> 'row_number')::integer;
    v_action := upper(btrim(v_row ->> 'action'));
    v_input_type := upper(btrim(v_row ->> 'input_type'));
    v_helper_id := (v_row ->> 'helper_id')::uuid;
    v_station_id := (v_row ->> 'station_id')::uuid;
    v_additional_field_id := nullif(v_row ->> 'additional_payment_field_id', '')::uuid;
    v_deduction_head_id := nullif(v_row ->> 'deduction_head_id', '')::uuid;
    v_from := (v_row ->> 'effective_from')::date;
    v_to := (v_row ->> 'effective_to')::date;
    v_numeric_value := nullif(v_row ->> 'numeric_value', '')::numeric(18,4);
    v_dropx_id := upper(btrim(v_row ->> 'dropx_id'));
    v_field_code := upper(btrim(v_row ->> 'field_code'));
    v_remark := nullif(btrim(coalesce(v_row ->> 'remark', '')), '');

    insert into public.helper_payout_import_rows (
      batch_id, company_id, row_number, action, helper_id, dropx_id_snapshot,
      station_id, input_type, additional_payment_field_id, deduction_head_id,
      field_code_snapshot, effective_from, effective_to, numeric_value, remark, raw_payload
    ) values (
      v_batch_id, p_company_id, v_row_number, v_action, v_helper_id, v_dropx_id,
      v_station_id, v_input_type, v_additional_field_id, v_deduction_head_id,
      v_field_code, v_from, v_to, v_numeric_value, v_remark, v_row
    ) returning id into v_import_row_id;

    if v_input_type = 'ATTENDANCE' then
      if v_action = 'CLEAR' then
        delete from public.helper_payout_attendance_values value
        where value.company_id = p_company_id and value.helper_id = v_helper_id
          and value.effective_from = v_from and value.effective_to = v_to;
      else
        v_basis := case when v_field_code = 'WORK_HOURS' then 'hours' else 'days' end;
        insert into public.helper_payout_attendance_values (
          company_id, helper_id, station_id, attendance_basis, effective_from, effective_to,
          quantity, source_batch_id, source_row_id, created_by, updated_by
        ) values (
          p_company_id, v_helper_id, v_station_id, v_basis, v_from, v_to,
          v_numeric_value, v_batch_id, v_import_row_id, p_actor_user_id, p_actor_user_id
        ) on conflict on constraint helper_payout_attendance_values_exact_period_unique do update set
          station_id = excluded.station_id,
          attendance_basis = excluded.attendance_basis,
          quantity = excluded.quantity,
          source_batch_id = excluded.source_batch_id,
          source_row_id = excluded.source_row_id,
          updated_by = excluded.updated_by,
          updated_at = clock_timestamp();
      end if;
    elsif v_input_type = 'ADDITIONAL_PAYMENT' then
      if v_action = 'CLEAR' then
        delete from public.helper_additional_payment_values value
        where value.company_id = p_company_id and value.helper_id = v_helper_id
          and value.additional_payment_field_id = v_additional_field_id
          and value.effective_from = v_from and value.effective_to = v_to;
      else
        select field.* into v_additional_field
        from public.workforce_additional_payment_fields field
        where field.company_id = p_company_id and field.id = v_additional_field_id;
        insert into public.helper_additional_payment_values (
          company_id, additional_payment_field_id, helper_id, station_id,
          field_code_snapshot, field_name_snapshot, calculation_type_snapshot,
          effective_from, effective_to, input_value, rate_value, final_amount,
          source_batch_id, source_row_id, created_by, updated_by
        ) values (
          p_company_id, v_additional_field_id, v_helper_id, v_station_id,
          v_additional_field.code, v_additional_field.name, v_additional_field.calculation_type,
          v_from, v_to, v_numeric_value,
          case when v_additional_field.calculation_type = 'units_x_rate' then v_additional_field.default_rate_value else null end,
          round(case when v_additional_field.calculation_type = 'units_x_rate'
            then v_numeric_value * v_additional_field.default_rate_value else v_numeric_value end, 2),
          v_batch_id, v_import_row_id, p_actor_user_id, p_actor_user_id
        ) on conflict on constraint helper_additional_payment_values_exact_period_unique do update set
          station_id = excluded.station_id,
          field_code_snapshot = excluded.field_code_snapshot,
          field_name_snapshot = excluded.field_name_snapshot,
          calculation_type_snapshot = excluded.calculation_type_snapshot,
          input_value = excluded.input_value,
          rate_value = excluded.rate_value,
          final_amount = excluded.final_amount,
          source_batch_id = excluded.source_batch_id,
          source_row_id = excluded.source_row_id,
          updated_by = excluded.updated_by,
          updated_at = clock_timestamp();
      end if;
    else
      if v_action = 'CLEAR' then
        delete from public.helper_payout_deduction_values value
        where value.company_id = p_company_id and value.helper_id = v_helper_id
          and value.deduction_head_id = v_deduction_head_id
          and value.effective_from = v_from and value.effective_to = v_to;
      else
        select head.* into v_deduction_head
        from public.workforce_deduction_heads head
        where head.company_id = p_company_id and head.id = v_deduction_head_id;
        insert into public.helper_payout_deduction_values (
          company_id, deduction_head_id, helper_id, station_id,
          head_code_snapshot, head_name_snapshot, effective_from, effective_to,
          amount, source_batch_id, source_row_id, created_by, updated_by
        ) values (
          p_company_id, v_deduction_head_id, v_helper_id, v_station_id,
          v_deduction_head.code, v_deduction_head.name, v_from, v_to,
          round(v_numeric_value, 2), v_batch_id, v_import_row_id, p_actor_user_id, p_actor_user_id
        ) on conflict on constraint helper_payout_deduction_values_exact_period_unique do update set
          station_id = excluded.station_id,
          head_code_snapshot = excluded.head_code_snapshot,
          head_name_snapshot = excluded.head_name_snapshot,
          amount = excluded.amount,
          source_batch_id = excluded.source_batch_id,
          source_row_id = excluded.source_row_id,
          updated_by = excluded.updated_by,
          updated_at = clock_timestamp();
      end if;
    end if;
  end loop;

  return v_batch_id;
end;
$function$;

alter table public.helper_payout_import_batches enable row level security;
alter table public.helper_payout_import_rows enable row level security;
alter table public.helper_payout_attendance_values enable row level security;
alter table public.helper_additional_payment_values enable row level security;
alter table public.helper_payout_deduction_values enable row level security;

revoke all on table public.helper_payout_import_batches from public, anon, authenticated, service_role;
revoke all on table public.helper_payout_import_rows from public, anon, authenticated, service_role;
revoke all on table public.helper_payout_attendance_values from public, anon, authenticated, service_role;
revoke all on table public.helper_additional_payment_values from public, anon, authenticated, service_role;
revoke all on table public.helper_payout_deduction_values from public, anon, authenticated, service_role;

grant select on table public.helper_payout_import_batches to service_role;
grant select on table public.helper_payout_import_rows to service_role;
grant select on table public.helper_payout_attendance_values to service_role;
grant select on table public.helper_additional_payment_values to service_role;
grant select on table public.helper_payout_deduction_values to service_role;

create policy helper_payout_import_batches_service_select on public.helper_payout_import_batches
  for select to service_role using (true);
create policy helper_payout_import_rows_service_select on public.helper_payout_import_rows
  for select to service_role using (true);
create policy helper_payout_attendance_values_service_select on public.helper_payout_attendance_values
  for select to service_role using (true);
create policy helper_additional_payment_values_service_select on public.helper_additional_payment_values
  for select to service_role using (true);
create policy helper_payout_deduction_values_service_select on public.helper_payout_deduction_values
  for select to service_role using (true);

revoke all on function public.helper_payout_input_processing_locked(uuid, uuid, uuid, date, date)
  from public, anon, authenticated;
revoke all on function public.helper_apply_payout_import(uuid, date, date, text, text, jsonb, uuid, uuid[])
  from public, anon, authenticated;
grant execute on function public.helper_apply_payout_import(uuid, date, date, text, text, jsonb, uuid, uuid[])
  to service_role;

commit;
