begin;

create extension if not exists pgcrypto;
create extension if not exists btree_gist;

create unique index if not exists workforce_company_id_id_uidx
  on public.workforce (company_id, id);
create unique index if not exists stations_company_id_id_uidx
  on public.stations (company_id, id);
create unique index if not exists payment_fields_company_id_id_uidx
  on public.payment_fields (company_id, id);

create table public.workforce_payout_import_batches (
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
  committed_at timestamptz,
  constraint workforce_payout_import_batches_period_check
    check (effective_to >= effective_from),
  constraint workforce_payout_import_batches_file_name_check
    check (btrim(file_name) <> '' and length(file_name) <= 240),
  constraint workforce_payout_import_batches_sha_check
    check (file_sha256 ~ '^[0-9a-f]{64}$'),
  constraint workforce_payout_import_batches_status_check
    check (status in ('committed', 'failed')),
  constraint workforce_payout_import_batches_row_count_check
    check (row_count between 1 and 10000),
  constraint workforce_payout_import_batches_idempotency_unique
    unique (company_id, effective_from, effective_to, file_sha256)
);

create index workforce_payout_import_batches_company_created_idx
  on public.workforce_payout_import_batches (company_id, created_at desc);

create table public.workforce_payout_import_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.workforce_payout_import_batches(id) on delete restrict,
  company_id uuid not null references public.companies(id) on delete restrict,
  row_number integer not null,
  action text not null,
  workforce_id uuid not null,
  dropx_id_snapshot text not null,
  station_id uuid not null,
  input_type text not null,
  payment_field_id uuid,
  additional_payment_field_id uuid,
  field_code_snapshot text,
  effective_from date not null,
  effective_to date not null,
  numeric_value numeric(18,4),
  text_value text,
  work_minutes integer,
  remark text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint workforce_payout_import_rows_batch_row_unique
    unique (batch_id, row_number),
  constraint workforce_payout_import_rows_workforce_company_fk
    foreign key (company_id, workforce_id)
    references public.workforce (company_id, id)
    on delete restrict,
  constraint workforce_payout_import_rows_station_company_fk
    foreign key (company_id, station_id)
    references public.stations (company_id, id)
    on delete restrict,
  constraint workforce_payout_import_rows_payment_field_company_fk
    foreign key (company_id, payment_field_id)
    references public.payment_fields (company_id, id)
    on delete restrict,
  constraint workforce_payout_import_rows_additional_field_company_fk
    foreign key (company_id, additional_payment_field_id)
    references public.workforce_additional_payment_fields (company_id, id)
    on delete restrict,
  constraint workforce_payout_import_rows_row_number_check
    check (row_number >= 2),
  constraint workforce_payout_import_rows_action_check
    check (action in ('UPSERT', 'CLEAR')),
  constraint workforce_payout_import_rows_input_type_check
    check (input_type in ('ATTENDANCE', 'PRODUCTION_UNITS', 'PAYMENT_FIELD_VALUE', 'ADDITIONAL_PAYMENT')),
  constraint workforce_payout_import_rows_period_check
    check (effective_to >= effective_from),
  constraint workforce_payout_import_rows_minutes_check
    check (work_minutes is null or work_minutes between 0 and 1440),
  constraint workforce_payout_import_rows_value_shape_check
    check (
      (action = 'CLEAR' and numeric_value is null and text_value is null and work_minutes is null)
      or
      (
        action = 'UPSERT'
        and (
          (input_type = 'ATTENDANCE' and text_value in ('P', 'HD', 'A') and numeric_value is null)
          or
          (input_type <> 'ATTENDANCE' and numeric_value is not null and numeric_value >= 0 and text_value is null)
        )
      )
    ),
  constraint workforce_payout_import_rows_field_shape_check
    check (
      (input_type = 'ATTENDANCE' and payment_field_id is null and additional_payment_field_id is null)
      or
      (input_type in ('PRODUCTION_UNITS', 'PAYMENT_FIELD_VALUE') and payment_field_id is not null and additional_payment_field_id is null)
      or
      (input_type = 'ADDITIONAL_PAYMENT' and payment_field_id is null and additional_payment_field_id is not null)
    ),
  constraint workforce_payout_import_rows_raw_payload_check
    check (jsonb_typeof(raw_payload) = 'object')
);

create index workforce_payout_import_rows_company_period_idx
  on public.workforce_payout_import_rows (company_id, effective_from, effective_to, workforce_id);

create table public.workforce_payout_attendance_overrides (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  workforce_id uuid not null,
  station_id uuid not null,
  work_date date not null,
  attendance_status text not null,
  work_day_units numeric(4,2) not null,
  work_minutes integer,
  source_batch_id uuid not null references public.workforce_payout_import_batches(id) on delete restrict,
  source_row_id uuid not null references public.workforce_payout_import_rows(id) on delete restrict,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workforce_payout_attendance_overrides_identity_unique
    unique (company_id, workforce_id, work_date),
  constraint workforce_payout_attendance_overrides_workforce_company_fk
    foreign key (company_id, workforce_id)
    references public.workforce (company_id, id)
    on delete restrict,
  constraint workforce_payout_attendance_overrides_station_company_fk
    foreign key (company_id, station_id)
    references public.stations (company_id, id)
    on delete restrict,
  constraint workforce_payout_attendance_overrides_status_check
    check (attendance_status in ('P', 'HD', 'A')),
  constraint workforce_payout_attendance_overrides_units_check
    check (
      (attendance_status = 'P' and work_day_units = 1)
      or (attendance_status = 'HD' and work_day_units = 0.5)
      or (attendance_status = 'A' and work_day_units = 0)
    ),
  constraint workforce_payout_attendance_overrides_minutes_check
    check (work_minutes is null or work_minutes between 0 and 1440)
);

create index workforce_payout_attendance_overrides_period_idx
  on public.workforce_payout_attendance_overrides (company_id, work_date, workforce_id);

create table public.workforce_payment_field_overrides (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  workforce_id uuid not null,
  station_id uuid not null,
  payment_field_id uuid not null,
  field_code_snapshot text not null,
  effective_from date not null,
  effective_to date not null,
  input_value numeric(18,4) not null,
  source_batch_id uuid not null references public.workforce_payout_import_batches(id) on delete restrict,
  source_row_id uuid not null references public.workforce_payout_import_rows(id) on delete restrict,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workforce_payment_field_overrides_identity_unique
    unique (company_id, workforce_id, station_id, payment_field_id, effective_from, effective_to),
  constraint workforce_payment_field_overrides_workforce_company_fk
    foreign key (company_id, workforce_id)
    references public.workforce (company_id, id)
    on delete restrict,
  constraint workforce_payment_field_overrides_station_company_fk
    foreign key (company_id, station_id)
    references public.stations (company_id, id)
    on delete restrict,
  constraint workforce_payment_field_overrides_field_company_fk
    foreign key (company_id, payment_field_id)
    references public.payment_fields (company_id, id)
    on delete restrict,
  constraint workforce_payment_field_overrides_period_check
    check (effective_to >= effective_from),
  constraint workforce_payment_field_overrides_value_check
    check (input_value >= 0),
  constraint workforce_payment_field_overrides_no_overlap
    exclude using gist (
      company_id with =,
      workforce_id with =,
      station_id with =,
      payment_field_id with =,
      daterange(effective_from, effective_to, '[]') with &&
    )
);

create index workforce_payment_field_overrides_period_idx
  on public.workforce_payment_field_overrides (company_id, effective_from, effective_to, workforce_id);

create table public.workforce_custom_production_inputs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  workforce_id uuid not null,
  station_id uuid not null,
  payment_field_id uuid not null,
  field_code_snapshot text not null,
  work_date date not null,
  units numeric(18,4) not null,
  source_batch_id uuid not null references public.workforce_payout_import_batches(id) on delete restrict,
  source_row_id uuid not null references public.workforce_payout_import_rows(id) on delete restrict,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workforce_custom_production_inputs_identity_unique
    unique (company_id, workforce_id, station_id, payment_field_id, work_date),
  constraint workforce_custom_production_inputs_workforce_company_fk
    foreign key (company_id, workforce_id)
    references public.workforce (company_id, id)
    on delete restrict,
  constraint workforce_custom_production_inputs_station_company_fk
    foreign key (company_id, station_id)
    references public.stations (company_id, id)
    on delete restrict,
  constraint workforce_custom_production_inputs_field_company_fk
    foreign key (company_id, payment_field_id)
    references public.payment_fields (company_id, id)
    on delete restrict,
  constraint workforce_custom_production_inputs_units_check
    check (units >= 0)
);

create index workforce_custom_production_inputs_period_idx
  on public.workforce_custom_production_inputs (company_id, work_date, workforce_id);

alter table public.workforce_additional_payment_values
  add constraint workforce_additional_payment_values_import_batch_fk
  foreign key (import_batch_id)
  references public.workforce_payout_import_batches(id)
  on delete restrict;

comment on table public.workforce_payout_import_batches is
  'Immutable file-level audit record for an atomically committed Workforce payout input workbook.';
comment on table public.workforce_payout_import_rows is
  'Immutable normalized row audit for payout imports, including CLEAR actions.';
comment on table public.workforce_payout_attendance_overrides is
  'Explicit payout-only daily attendance overrides. These do not alter biometric attendance_daily facts.';
comment on table public.workforce_payment_field_overrides is
  'Effective-dated overrides of a configured payment-field input/rate; this table does not store final payout amounts.';
comment on table public.workforce_custom_production_inputs is
  'Daily uploaded unit counts for payment fields explicitly marked as custom production.';

alter table public.workforce_payout_import_batches enable row level security;
alter table public.workforce_payout_import_rows enable row level security;
alter table public.workforce_payout_attendance_overrides enable row level security;
alter table public.workforce_payment_field_overrides enable row level security;
alter table public.workforce_custom_production_inputs enable row level security;

revoke all on table public.workforce_payout_import_batches from public, anon, authenticated, service_role;
revoke all on table public.workforce_payout_import_rows from public, anon, authenticated, service_role;
revoke all on table public.workforce_payout_attendance_overrides from public, anon, authenticated, service_role;
revoke all on table public.workforce_payment_field_overrides from public, anon, authenticated, service_role;
revoke all on table public.workforce_custom_production_inputs from public, anon, authenticated, service_role;

grant select on table public.workforce_payout_import_batches to service_role;
grant select on table public.workforce_payout_import_rows to service_role;
grant select on table public.workforce_payout_attendance_overrides to service_role;
grant select on table public.workforce_payment_field_overrides to service_role;
grant select on table public.workforce_custom_production_inputs to service_role;

create policy workforce_payout_import_batches_service_select
  on public.workforce_payout_import_batches for select to service_role using (true);
create policy workforce_payout_import_rows_service_select
  on public.workforce_payout_import_rows for select to service_role using (true);
create policy workforce_payout_attendance_overrides_service_select
  on public.workforce_payout_attendance_overrides for select to service_role using (true);
create policy workforce_payment_field_overrides_service_select
  on public.workforce_payment_field_overrides for select to service_role using (true);
create policy workforce_custom_production_inputs_service_select
  on public.workforce_custom_production_inputs for select to service_role using (true);

create or replace function public.workforce_apply_payout_import(
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
  v_workforce_id uuid;
  v_station_id uuid;
  v_payment_field_id uuid;
  v_additional_field_id uuid;
  v_from date;
  v_to date;
  v_numeric_value numeric(18,4);
  v_text_value text;
  v_work_minutes integer;
  v_dropx_id text;
  v_field_code text;
  v_remark text;
  v_worker public.workforce%rowtype;
  v_payment_field public.payment_fields%rowtype;
  v_additional_field public.workforce_additional_payment_fields%rowtype;
  v_station_assignment_matches boolean;
  v_other_station_assignment_exists boolean;
  v_duplicate_input_type text;
  v_duplicate_first_row_number integer;
  v_duplicate_row_number integer;
begin
  if p_company_id is null or p_actor_user_id is null then
    raise exception 'Company and importing user are required.';
  end if;
  if p_effective_from is null or p_effective_to is null or p_effective_to < p_effective_from then
    raise exception 'A valid payout import period is required.';
  end if;
  if p_effective_to - p_effective_from >= 366 then
    raise exception 'A payout import can cover at most 366 days.';
  end if;
  if nullif(btrim(p_file_name), '') is null or length(p_file_name) > 240 then
    raise exception 'A valid workbook file name is required.';
  end if;
  if p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'A valid workbook fingerprint is required.';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array'
    or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 10000 then
    raise exception 'A payout import must contain between 1 and 10000 rows.';
  end if;

  -- The API resolves blank and explicit location aliases to canonical station
  -- IDs before calling this function. Reject duplicate canonical targets before
  -- any upsert can make the last row silently win. Attendance and additional
  -- payments are worker-owned across stations; rates and production are
  -- station-owned, matching their current-value constraints below.
  with raw_rows as (
    select
      nullif(item.value ->> 'row_number', '')::integer as row_number,
      upper(btrim(item.value ->> 'input_type')) as input_type,
      item.value as payload
    from jsonb_array_elements(p_rows) item(value)
  ), normalized_rows as (
    select
      raw_rows.row_number,
      raw_rows.input_type,
      case raw_rows.input_type
        when 'ATTENDANCE' then jsonb_build_array(
          raw_rows.input_type,
          raw_rows.payload ->> 'workforce_id',
          raw_rows.payload ->> 'effective_from'
        )
        when 'PRODUCTION_UNITS' then jsonb_build_array(
          raw_rows.input_type,
          raw_rows.payload ->> 'workforce_id',
          raw_rows.payload ->> 'station_id',
          raw_rows.payload ->> 'payment_field_id',
          raw_rows.payload ->> 'effective_from'
        )
        when 'PAYMENT_FIELD_VALUE' then jsonb_build_array(
          raw_rows.input_type,
          raw_rows.payload ->> 'workforce_id',
          raw_rows.payload ->> 'station_id',
          raw_rows.payload ->> 'payment_field_id',
          raw_rows.payload ->> 'effective_from',
          raw_rows.payload ->> 'effective_to'
        )
        when 'ADDITIONAL_PAYMENT' then jsonb_build_array(
          raw_rows.input_type,
          raw_rows.payload ->> 'workforce_id',
          raw_rows.payload ->> 'additional_payment_field_id',
          raw_rows.payload ->> 'effective_from',
          raw_rows.payload ->> 'effective_to'
        )
        else null
      end as resolved_identity
    from raw_rows
  ), duplicate_groups as (
    select
      normalized_rows.input_type,
      array_agg(normalized_rows.row_number order by normalized_rows.row_number) as row_numbers
    from normalized_rows
    where normalized_rows.resolved_identity is not null
    group by normalized_rows.input_type, normalized_rows.resolved_identity
    having count(*) > 1
  )
  select
    duplicate_groups.input_type,
    duplicate_groups.row_numbers[1],
    duplicate_groups.row_numbers[2]
  into
    v_duplicate_input_type,
    v_duplicate_first_row_number,
    v_duplicate_row_number
  from duplicate_groups
  order by duplicate_groups.row_numbers[1]
  limit 1;

  if found then
    raise exception 'Row % duplicates resolved % input from row %. Keep one action for each stored payout input.',
      v_duplicate_row_number, v_duplicate_input_type, v_duplicate_first_row_number;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'workforce-payout-import-company:' || p_company_id::text,
    0
  ));

  if exists (
    select 1
    from public.workforce_payout_import_batches batch
    where batch.company_id = p_company_id
      and batch.effective_from = p_effective_from
      and batch.effective_to = p_effective_to
      and batch.file_sha256 = p_file_sha256
      and batch.status = 'committed'
  ) then
    raise exception 'This exact workbook was already imported for the selected payout period.';
  end if;

  -- Match the lock order used by payroll finalization before any payout input is
  -- changed. The company mutex is shared with payment-allocation finalization.
  perform 1
  from public.workforce workforce
  where workforce.company_id = p_company_id
    and workforce.id in (
      select distinct nullif(item ->> 'workforce_id', '')::uuid
      from jsonb_array_elements(p_rows) item
    )
  order by workforce.id
  for update;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'workforce-payment-allocation-company:' || p_company_id::text,
    0
  ));

  -- Finalized payroll closes the company period. A worker does not have to be
  -- present in a payroll item for the period to be immutable.
  if exists (
    select 1
    from public.workforce_payroll_runs payroll_run
    where payroll_run.company_id = p_company_id
      and lower(coalesce(payroll_run.status, '')) in ('approved', 'paid')
      and daterange(payroll_run.period_start, payroll_run.period_end, '[]')
        && daterange(p_effective_from, p_effective_to, '[]')
  ) then
    raise exception 'The selected payout import period overlaps an approved or paid Workforce payroll.';
  end if;

  insert into public.workforce_payout_import_batches (
    company_id, effective_from, effective_to, file_name, file_sha256,
    status, row_count, created_by, committed_at
  ) values (
    p_company_id, p_effective_from, p_effective_to, btrim(p_file_name), p_file_sha256,
    'committed', jsonb_array_length(p_rows), p_actor_user_id, clock_timestamp()
  ) returning id into v_batch_id;

  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    v_row_number := nullif(v_row ->> 'row_number', '')::integer;
    v_action := upper(btrim(v_row ->> 'action'));
    v_input_type := upper(btrim(v_row ->> 'input_type'));
    v_workforce_id := nullif(v_row ->> 'workforce_id', '')::uuid;
    v_station_id := nullif(v_row ->> 'station_id', '')::uuid;
    v_payment_field_id := nullif(v_row ->> 'payment_field_id', '')::uuid;
    v_additional_field_id := nullif(v_row ->> 'additional_payment_field_id', '')::uuid;
    v_from := nullif(v_row ->> 'effective_from', '')::date;
    v_to := nullif(v_row ->> 'effective_to', '')::date;
    v_numeric_value := nullif(v_row ->> 'numeric_value', '')::numeric;
    v_text_value := nullif(upper(btrim(v_row ->> 'text_value')), '');
    v_work_minutes := nullif(v_row ->> 'work_minutes', '')::integer;
    v_dropx_id := upper(btrim(v_row ->> 'dropx_id'));
    v_field_code := nullif(upper(btrim(v_row ->> 'field_code')), '');
    v_remark := nullif(left(btrim(v_row ->> 'remark'), 500), '');

    if v_row_number is null or v_row_number < 2 then
      raise exception 'Every payout import row requires its spreadsheet row number.';
    end if;
    if v_action not in ('UPSERT', 'CLEAR') then
      raise exception 'Row % has an invalid action.', v_row_number;
    end if;
    if v_input_type not in ('ATTENDANCE', 'PRODUCTION_UNITS', 'PAYMENT_FIELD_VALUE', 'ADDITIONAL_PAYMENT') then
      raise exception 'Row % has an invalid input type.', v_row_number;
    end if;
    if v_from is null or v_to is null or v_to < v_from
      or v_from < p_effective_from or v_to > p_effective_to then
      raise exception 'Row % is outside the selected payout import period.', v_row_number;
    end if;
    if v_input_type in ('ATTENDANCE', 'PRODUCTION_UNITS') and v_from <> v_to then
      raise exception 'Row % must contain exactly one work date.', v_row_number;
    end if;
    if v_input_type = 'ADDITIONAL_PAYMENT'
      and (v_from <> p_effective_from or v_to <> p_effective_to) then
      raise exception 'Row % additional payment must use the exact payout period.', v_row_number;
    end if;
    if v_action = 'CLEAR' and (v_numeric_value is not null or v_text_value is not null or v_work_minutes is not null) then
      raise exception 'Row % CLEAR action must not contain a value.', v_row_number;
    end if;
    if v_action = 'UPSERT' and v_input_type = 'ATTENDANCE' and v_text_value not in ('P', 'HD', 'A') then
      raise exception 'Row % attendance must be P, HD or A.', v_row_number;
    end if;
    if v_action = 'UPSERT' and v_input_type <> 'ATTENDANCE'
      and (v_numeric_value is null or v_numeric_value < 0) then
      raise exception 'Row % requires a non-negative numeric value.', v_row_number;
    end if;
    if v_work_minutes is not null and (v_work_minutes < 0 or v_work_minutes > 1440) then
      raise exception 'Row % work minutes must be from 0 to 1440.', v_row_number;
    end if;
    if v_input_type <> 'ATTENDANCE' and v_work_minutes is not null then
      raise exception 'Row % work minutes are only valid for attendance.', v_row_number;
    end if;
    if v_input_type = 'ATTENDANCE' and v_text_value = 'A' and coalesce(v_work_minutes, 0) <> 0 then
      raise exception 'Row % absent attendance cannot contain work minutes.', v_row_number;
    end if;

    select workforce.*
    into v_worker
    from public.workforce workforce
    where workforce.company_id = p_company_id
      and workforce.id = v_workforce_id
      and upper(btrim(workforce.dropx_id)) = v_dropx_id
      and workforce.deleted_at is null
      and coalesce(workforce.migration_state, '') <> 'reclassified';

    if not found then
      raise exception 'Row % Workforce identity does not belong to this company.', v_row_number;
    end if;
    if v_worker.date_of_join is not null and v_from < v_worker.date_of_join then
      raise exception 'Row % starts before the Workforce joining date.', v_row_number;
    end if;
    if v_worker.last_working_date is not null and v_to > v_worker.last_working_date then
      raise exception 'Row % ends after the Workforce last working date.', v_row_number;
    end if;
    if not v_worker.is_active and v_worker.last_working_date is null then
      raise exception 'Row % Workforce member is inactive without a historical last working date.', v_row_number;
    end if;

    -- Additional payments are worker-wide inputs, independent of payment
    -- method mapping. When LOCATION is omitted, resolve ownership to the
    -- Workforce member's current location before applying scope checks.
    if v_input_type = 'ADDITIONAL_PAYMENT' and v_station_id is null then
      v_station_id := v_worker.location_id;
    end if;

    if v_station_id is null or not exists (
      select 1 from public.stations station
      where station.company_id = p_company_id and station.id = v_station_id
    ) then
      raise exception 'Row % does not have a valid company location.', v_row_number;
    end if;
    if p_allowed_location_ids is not null and not (v_station_id = any(p_allowed_location_ids)) then
      raise exception 'Row % is outside the importing user''s location scope.', v_row_number;
    end if;

    if v_input_type = 'ATTENDANCE' then
      v_station_assignment_matches := exists (
        select 1 from public.field_executive_provider_mappings mapping
        where mapping.company_id = p_company_id
          and (
            mapping.workforce_id = v_workforce_id
            or (v_worker.source_profile_type = 'employee' and mapping.employee_id = v_worker.source_profile_id)
            or (v_worker.source_profile_type = 'contractor' and mapping.contractor_id = v_worker.source_profile_id)
            or (v_worker.source_profile_type = 'field_executive' and mapping.field_executive_id = v_worker.source_profile_id)
          )
          and mapping.station_id = v_station_id
          and mapping.status <> 'cancelled'
          and mapping.effective_from <= v_to
          and (mapping.effective_to is null or mapping.effective_to >= v_from)
      ) or exists (
        select 1 from public.workforce_payment_allocations allocation
        where allocation.company_id = p_company_id
          and allocation.workforce_id = v_workforce_id
          and allocation.station_id = v_station_id
          and allocation.status <> 'cancelled'
          and allocation.effective_from <= v_to
          and (allocation.effective_to is null or allocation.effective_to >= v_from)
      );

      v_other_station_assignment_exists := exists (
        select 1 from public.field_executive_provider_mappings mapping
        where mapping.company_id = p_company_id
          and (
            mapping.workforce_id = v_workforce_id
            or (v_worker.source_profile_type = 'employee' and mapping.employee_id = v_worker.source_profile_id)
            or (v_worker.source_profile_type = 'contractor' and mapping.contractor_id = v_worker.source_profile_id)
            or (v_worker.source_profile_type = 'field_executive' and mapping.field_executive_id = v_worker.source_profile_id)
          )
          and mapping.station_id is distinct from v_station_id
          and mapping.status <> 'cancelled'
          and mapping.effective_from <= v_to
          and (mapping.effective_to is null or mapping.effective_to >= v_from)
      ) or exists (
        select 1 from public.workforce_payment_allocations allocation
        where allocation.company_id = p_company_id
          and allocation.workforce_id = v_workforce_id
          and allocation.station_id is distinct from v_station_id
          and allocation.status <> 'cancelled'
          and allocation.effective_from <= v_to
          and (allocation.effective_to is null or allocation.effective_to >= v_from)
      );

      if not v_station_assignment_matches
        and (v_station_id is distinct from v_worker.location_id or v_other_station_assignment_exists) then
        raise exception 'Row % location is not assigned to this Workforce member for the payout period.', v_row_number;
      end if;
    elsif v_input_type = 'ADDITIONAL_PAYMENT'
      and v_action = 'UPSERT'
      and not public.workforce_additional_payment_location_is_authorized(
        p_company_id,
        v_workforce_id,
        v_station_id,
        v_from,
        v_to
      ) then
      raise exception 'Row % additional payment location must be the Workforce current location or an overlapping historical payment location.', v_row_number;
    end if;

    v_payment_field := null;
    v_additional_field := null;
    if v_input_type in ('PRODUCTION_UNITS', 'PAYMENT_FIELD_VALUE') then
      select field.* into v_payment_field
      from public.payment_fields field
      where field.company_id = p_company_id
        and field.id = v_payment_field_id
        and upper(btrim(field.code)) = v_field_code
        and field.is_active = true;
      if not found then
        raise exception 'Row % payment field is not active for this company.', v_row_number;
      end if;
      if v_input_type = 'PRODUCTION_UNITS'
        and not (v_payment_field.field_type = 'production' and v_payment_field.is_custom_production) then
        raise exception 'Row % field is not configured for custom production units.', v_row_number;
      end if;

      -- Every date must be covered by exactly one provider/direct payment setup
      -- containing this field at the row's authorized location.
      if exists (
        select 1
        from generate_series(v_from, v_to, interval '1 day') day_value
        where (
          select count(*)
          from (
            select mapping.id
            from public.field_executive_provider_mappings mapping
            join public.payment_method_components component
              on component.company_id = p_company_id
             and component.payment_method_id = mapping.payment_method_id
             and component.payment_field_id = v_payment_field_id
             and component.is_active = true
            where mapping.company_id = p_company_id
              and (
                mapping.workforce_id = v_workforce_id
                or (v_worker.source_profile_type = 'employee' and mapping.employee_id = v_worker.source_profile_id)
                or (v_worker.source_profile_type = 'contractor' and mapping.contractor_id = v_worker.source_profile_id)
                or (v_worker.source_profile_type = 'field_executive' and mapping.field_executive_id = v_worker.source_profile_id)
              )
              and mapping.station_id = v_station_id
              and mapping.status <> 'cancelled'
              and mapping.effective_from <= day_value::date
              and (mapping.effective_to is null or mapping.effective_to >= day_value::date)
            union all
            select allocation.id
            from public.workforce_payment_allocations allocation
            where allocation.company_id = p_company_id
              and allocation.workforce_id = v_workforce_id
              and allocation.station_id = v_station_id
              and allocation.status <> 'cancelled'
              and allocation.effective_from <= day_value::date
              and (allocation.effective_to is null or allocation.effective_to >= day_value::date)
              and exists (
                select 1
                from jsonb_array_elements(allocation.payment_components) component(value)
                where upper(btrim(component.value ->> 'component_code')) = v_field_code
              )
          ) setup
        ) <> 1
      ) then
        raise exception 'Row % payment field is not covered by exactly one payment setup for every date and location.', v_row_number;
      end if;

      if v_input_type = 'PAYMENT_FIELD_VALUE' and exists (
        select 1
        from public.workforce_payment_field_overrides existing
        where existing.company_id = p_company_id
          and existing.workforce_id = v_workforce_id
          and existing.station_id = v_station_id
          and existing.payment_field_id = v_payment_field_id
          and daterange(existing.effective_from, existing.effective_to, '[]') && daterange(v_from, v_to, '[]')
          and (existing.effective_from, existing.effective_to) <> (v_from, v_to)
      ) then
        raise exception 'Row % partially overlaps an existing payment-field override. Clear it or use the exact existing period.', v_row_number;
      end if;
    elsif v_input_type = 'ADDITIONAL_PAYMENT' then
      select field.* into v_additional_field
      from public.workforce_additional_payment_fields field
      where field.company_id = p_company_id
        and field.id = v_additional_field_id
        and upper(btrim(field.code)) = v_field_code
        and field.is_active = true;
      if not found then
        raise exception 'Row % additional payment field is not active for this company.', v_row_number;
      end if;
      if v_additional_field.calculation_type = 'units_x_rate'
        and v_additional_field.default_rate_value is null then
        raise exception 'Row % additional payment field requires a configured default rate.', v_row_number;
      end if;
      if exists (
        select 1
        from public.workforce_additional_payment_values existing
        where existing.company_id = p_company_id
          and existing.workforce_id = v_workforce_id
          and existing.additional_payment_field_id = v_additional_field_id
          and daterange(existing.effective_from, existing.effective_to, '[]') && daterange(v_from, v_to, '[]')
          and (existing.effective_from, existing.effective_to) <> (v_from, v_to)
      ) then
        raise exception 'Row % partially overlaps an existing additional payment. Clear it or use the exact existing period.', v_row_number;
      end if;
      if exists (
        select 1
        from public.workforce_additional_payment_values existing
        where existing.company_id = p_company_id
          and existing.workforce_id = v_workforce_id
          and existing.additional_payment_field_id = v_additional_field_id
          and existing.effective_from = v_from
          and existing.effective_to = v_to
          and existing.station_id is distinct from v_station_id
      ) then
        raise exception 'Row % additional payment already belongs to another location.', v_row_number;
      end if;
    end if;

    insert into public.workforce_payout_import_rows (
      batch_id, company_id, row_number, action, workforce_id, dropx_id_snapshot,
      station_id, input_type, payment_field_id, additional_payment_field_id,
      field_code_snapshot, effective_from, effective_to, numeric_value,
      text_value, work_minutes, remark, raw_payload
    ) values (
      v_batch_id, p_company_id, v_row_number, v_action, v_workforce_id, v_dropx_id,
      v_station_id, v_input_type, v_payment_field_id, v_additional_field_id,
      v_field_code, v_from, v_to, v_numeric_value,
      v_text_value, v_work_minutes, v_remark, v_row
    ) returning id into v_import_row_id;

    if v_input_type = 'ATTENDANCE' then
      if exists (
        select 1
        from public.workforce_payout_attendance_overrides existing
        where existing.company_id = p_company_id
          and existing.workforce_id = v_workforce_id
          and existing.work_date = v_from
          and existing.station_id is distinct from v_station_id
      ) then
        raise exception 'Row % attendance already belongs to another location.', v_row_number;
      end if;
      if v_action = 'CLEAR' then
        delete from public.workforce_payout_attendance_overrides
        where company_id = p_company_id and workforce_id = v_workforce_id
          and station_id = v_station_id and work_date = v_from;
      else
        insert into public.workforce_payout_attendance_overrides (
          company_id, workforce_id, station_id, work_date, attendance_status,
          work_day_units, work_minutes, source_batch_id, source_row_id,
          created_by, updated_by
        ) values (
          p_company_id, v_workforce_id, v_station_id, v_from, v_text_value,
          case v_text_value when 'P' then 1 when 'HD' then 0.5 else 0 end,
          v_work_minutes, v_batch_id, v_import_row_id, p_actor_user_id, p_actor_user_id
        )
        on conflict (company_id, workforce_id, work_date)
        do update set
          station_id = excluded.station_id,
          attendance_status = excluded.attendance_status,
          work_day_units = excluded.work_day_units,
          work_minutes = excluded.work_minutes,
          source_batch_id = excluded.source_batch_id,
          source_row_id = excluded.source_row_id,
          updated_by = excluded.updated_by,
          updated_at = clock_timestamp();
      end if;
    elsif v_input_type = 'PRODUCTION_UNITS' then
      if v_action = 'CLEAR' then
        delete from public.workforce_custom_production_inputs
        where company_id = p_company_id and workforce_id = v_workforce_id
          and station_id = v_station_id
          and payment_field_id = v_payment_field_id and work_date = v_from;
      else
        insert into public.workforce_custom_production_inputs (
          company_id, workforce_id, station_id, payment_field_id,
          field_code_snapshot, work_date, units, source_batch_id, source_row_id,
          created_by, updated_by
        ) values (
          p_company_id, v_workforce_id, v_station_id, v_payment_field_id,
          v_payment_field.code, v_from, v_numeric_value, v_batch_id, v_import_row_id,
          p_actor_user_id, p_actor_user_id
        )
        on conflict (company_id, workforce_id, station_id, payment_field_id, work_date)
        do update set
          field_code_snapshot = excluded.field_code_snapshot,
          units = excluded.units,
          source_batch_id = excluded.source_batch_id,
          source_row_id = excluded.source_row_id,
          updated_by = excluded.updated_by,
          updated_at = clock_timestamp();
      end if;
    elsif v_input_type = 'PAYMENT_FIELD_VALUE' then
      if v_action = 'CLEAR' then
        delete from public.workforce_payment_field_overrides
        where company_id = p_company_id and workforce_id = v_workforce_id
          and station_id = v_station_id
          and payment_field_id = v_payment_field_id
          and effective_from = v_from and effective_to = v_to;
      else
        insert into public.workforce_payment_field_overrides (
          company_id, workforce_id, station_id, payment_field_id,
          field_code_snapshot, effective_from, effective_to, input_value,
          source_batch_id, source_row_id, created_by, updated_by
        ) values (
          p_company_id, v_workforce_id, v_station_id, v_payment_field_id,
          v_payment_field.code, v_from, v_to, v_numeric_value,
          v_batch_id, v_import_row_id, p_actor_user_id, p_actor_user_id
        )
        on conflict (company_id, workforce_id, station_id, payment_field_id, effective_from, effective_to)
        do update set
          field_code_snapshot = excluded.field_code_snapshot,
          input_value = excluded.input_value,
          source_batch_id = excluded.source_batch_id,
          source_row_id = excluded.source_row_id,
          updated_by = excluded.updated_by,
          updated_at = clock_timestamp();
      end if;
    else
      if v_action = 'CLEAR' then
        delete from public.workforce_additional_payment_values
        where company_id = p_company_id and workforce_id = v_workforce_id
          and station_id = v_station_id
          and additional_payment_field_id = v_additional_field_id
          and effective_from = v_from and effective_to = v_to;
      else
        insert into public.workforce_additional_payment_values (
          company_id, additional_payment_field_id, workforce_id, station_id,
          field_code_snapshot, field_name_snapshot, calculation_type_snapshot,
          effective_from, effective_to, input_value, rate_value, final_amount,
          source_type, import_batch_id, import_row_number, import_metadata,
          created_by, updated_by
        ) values (
          p_company_id, v_additional_field_id, v_workforce_id, v_station_id,
          v_additional_field.code, v_additional_field.name, v_additional_field.calculation_type,
          v_from, v_to, v_numeric_value, null, 0,
          'bulk_import', v_batch_id, v_row_number,
          jsonb_build_object('file_sha256', p_file_sha256, 'remark', v_remark),
          p_actor_user_id, p_actor_user_id
        )
        on conflict (company_id, additional_payment_field_id, workforce_id, effective_from, effective_to)
        do update set
          input_value = excluded.input_value,
          rate_value = null,
          source_type = 'bulk_import',
          import_batch_id = excluded.import_batch_id,
          import_row_number = excluded.import_row_number,
          import_metadata = excluded.import_metadata,
          updated_by = excluded.updated_by,
          updated_at = clock_timestamp();
      end if;
    end if;
  end loop;

  return v_batch_id;
end
$function$;

comment on function public.workforce_apply_payout_import(uuid, date, date, text, text, jsonb, uuid, uuid[]) is
  'Atomically revalidates and applies an effective-dated Workforce payout input workbook. A failed row rolls back the batch and every current-value change.';

revoke all on function public.workforce_apply_payout_import(uuid, date, date, text, text, jsonb, uuid, uuid[])
  from public, anon, authenticated;
grant execute on function public.workforce_apply_payout_import(uuid, date, date, text, text, jsonb, uuid, uuid[])
  to service_role;

notify pgrst, 'reload schema';

commit;
