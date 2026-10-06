begin;

create extension if not exists btree_gist;

create unique index if not exists workforce_deduction_heads_company_id_id_uidx
  on public.workforce_deduction_heads (company_id, id);

alter table public.workforce_payout_import_rows
  add column deduction_head_id uuid;

alter table public.workforce_payout_import_rows
  add constraint workforce_payout_import_rows_deduction_head_company_fk
  foreign key (company_id, deduction_head_id)
  references public.workforce_deduction_heads (company_id, id)
  on delete restrict;

alter table public.workforce_payout_import_rows
  drop constraint workforce_payout_import_rows_input_type_check,
  drop constraint workforce_payout_import_rows_value_shape_check,
  drop constraint workforce_payout_import_rows_field_shape_check;

alter table public.workforce_payout_import_rows
  add constraint workforce_payout_import_rows_input_type_check
    check (input_type in ('ATTENDANCE', 'PRODUCTION_UNITS', 'PAYMENT_FIELD_VALUE', 'ADDITIONAL_PAYMENT', 'DEDUCTION')),
  add constraint workforce_payout_import_rows_value_shape_check
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
  add constraint workforce_payout_import_rows_field_shape_check
    check (
      (input_type = 'ATTENDANCE' and payment_field_id is null and additional_payment_field_id is null and deduction_head_id is null)
      or
      (input_type in ('PRODUCTION_UNITS', 'PAYMENT_FIELD_VALUE') and payment_field_id is not null and additional_payment_field_id is null and deduction_head_id is null)
      or
      (input_type = 'ADDITIONAL_PAYMENT' and payment_field_id is null and additional_payment_field_id is not null and deduction_head_id is null)
      or
      (input_type = 'DEDUCTION' and payment_field_id is null and additional_payment_field_id is null and deduction_head_id is not null)
    );

create table public.workforce_payout_deduction_values (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  deduction_head_id uuid not null,
  workforce_id uuid not null,
  station_id uuid not null,
  head_code_snapshot text not null,
  head_name_snapshot text not null,
  effective_from date not null,
  effective_to date not null,
  amount numeric(18,2) not null,
  source_type text not null default 'bulk_import',
  source_batch_id uuid not null references public.workforce_payout_import_batches(id) on delete restrict,
  source_row_id uuid not null references public.workforce_payout_import_rows(id) on delete restrict,
  import_metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workforce_payout_deduction_values_head_company_fk
    foreign key (company_id, deduction_head_id)
    references public.workforce_deduction_heads (company_id, id)
    on delete restrict,
  constraint workforce_payout_deduction_values_workforce_company_fk
    foreign key (company_id, workforce_id)
    references public.workforce (company_id, id)
    on delete restrict,
  constraint workforce_payout_deduction_values_station_company_fk
    foreign key (company_id, station_id)
    references public.stations (company_id, id)
    on delete restrict,
  constraint workforce_payout_deduction_values_exact_period_unique
    unique (company_id, deduction_head_id, workforce_id, effective_from, effective_to),
  constraint workforce_payout_deduction_values_no_overlap
    exclude using gist (
      company_id with =,
      deduction_head_id with =,
      workforce_id with =,
      daterange(effective_from, effective_to, '[]') with &&
    ),
  constraint workforce_payout_deduction_values_period_check
    check (effective_to >= effective_from),
  constraint workforce_payout_deduction_values_amount_check
    check (amount >= 0),
  constraint workforce_payout_deduction_values_source_check
    check (source_type = 'bulk_import'),
  constraint workforce_payout_deduction_values_metadata_check
    check (jsonb_typeof(import_metadata) = 'object')
);

create index workforce_payout_deduction_values_company_period_idx
  on public.workforce_payout_deduction_values (company_id, effective_from, effective_to, workforce_id);
create index workforce_payout_deduction_values_station_period_idx
  on public.workforce_payout_deduction_values (company_id, station_id, effective_from, effective_to);
create index workforce_payout_deduction_values_batch_idx
  on public.workforce_payout_deduction_values (company_id, source_batch_id);

comment on table public.workforce_payout_deduction_values is
  'Exact-period, field-scoped non-system manual deduction amounts imported for one canonical Workforce member. Automatic fixed, percentage, and system deductions are never overridden by this table.';

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
    and head.is_system = false;

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

  new.head_code_snapshot := v_head.code;
  new.head_name_snapshot := v_head.name;
  new.source_type := 'bulk_import';
  new.import_metadata := coalesce(new.import_metadata, '{}'::jsonb);
  new.updated_at := clock_timestamp();
  return new;
end;
$function$;

create trigger workforce_payout_deduction_values_00_prepare
before insert or update on public.workforce_payout_deduction_values
for each row execute function public.prepare_workforce_payout_deduction_value();

-- Preserve the proven existing implementation for the original four input
-- types. The public wrapper below keeps the API signature stable and appends
-- deduction rows to the same immutable batch in the same transaction.
alter function public.workforce_apply_payout_import(uuid, date, date, text, text, jsonb, uuid, uuid[])
  rename to workforce_apply_payout_import_without_deductions;

-- Production values are field-scoped overrides regardless of whether their
-- normal source is a provider report or a custom upload. Patch the retained
-- implementation in place so DELIVERY can be overridden without changing
-- C-return, attendance, or any other production field/date.
do $patch_production_import$
declare
  v_definition text;
  v_patched text;
begin
  select pg_catalog.pg_get_functiondef(function_row.oid)
  into v_definition
  from pg_catalog.pg_proc function_row
  where function_row.oid =
    'public.workforce_apply_payout_import_without_deductions(uuid,date,date,text,text,jsonb,uuid,uuid[])'::regprocedure;

  v_patched := replace(
    v_definition,
    $old$and not (v_payment_field.field_type = 'production' and v_payment_field.is_custom_production)$old$,
    $new$and v_payment_field.field_type <> 'production'$new$
  );
  v_patched := replace(
    v_patched,
    $old$field is not configured for custom production units.$old$,
    $new$field is not configured as a production field.$new$
  );

  if v_definition is null or v_patched = v_definition then
    raise exception 'Unable to broaden Workforce production import validation.';
  end if;
  execute v_patched;
end;
$patch_production_import$;

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
  v_existing_rows jsonb;
  v_deduction_rows jsonb;
  v_row jsonb;
  v_row_number integer;
  v_action text;
  v_input_type text;
  v_workforce_id uuid;
  v_station_id uuid;
  v_deduction_head_id uuid;
  v_from date;
  v_to date;
  v_numeric_value numeric(18,4);
  v_text_value text;
  v_work_minutes integer;
  v_dropx_id text;
  v_field_code text;
  v_remark text;
  v_worker public.workforce%rowtype;
  v_head public.workforce_deduction_heads%rowtype;
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

  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
  into v_existing_rows
  from jsonb_array_elements(p_rows) with ordinality item(value, ordinality)
  where upper(btrim(item.value ->> 'input_type')) <> 'DEDUCTION';

  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
  into v_deduction_rows
  from jsonb_array_elements(p_rows) with ordinality item(value, ordinality)
  where upper(btrim(item.value ->> 'input_type')) = 'DEDUCTION';

  with normalized_rows as (
    select
      nullif(item.value ->> 'row_number', '')::integer as row_number,
      jsonb_build_array(
        item.value ->> 'workforce_id',
        item.value ->> 'deduction_head_id',
        item.value ->> 'effective_from',
        item.value ->> 'effective_to'
      ) as resolved_identity
    from jsonb_array_elements(v_deduction_rows) item(value)
  ), duplicate_groups as (
    select array_agg(row_number order by row_number) as row_numbers
    from normalized_rows
    group by resolved_identity
    having count(*) > 1
  )
  select duplicate_groups.row_numbers[1], duplicate_groups.row_numbers[2]
  into v_duplicate_first_row_number, v_duplicate_row_number
  from duplicate_groups
  order by duplicate_groups.row_numbers[1]
  limit 1;

  if found then
    raise exception 'Row % duplicates resolved DEDUCTION input from row %. Keep one action for each stored payout input.',
      v_duplicate_row_number, v_duplicate_first_row_number;
  end if;

  if jsonb_array_length(v_existing_rows) > 0 then
    v_batch_id := public.workforce_apply_payout_import_without_deductions(
      p_company_id,
      p_effective_from,
      p_effective_to,
      p_file_name,
      p_file_sha256,
      v_existing_rows,
      p_actor_user_id,
      p_allowed_location_ids
    );
  else
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

    perform 1
    from public.workforce workforce
    where workforce.company_id = p_company_id
      and workforce.id in (
        select distinct nullif(item ->> 'workforce_id', '')::uuid
        from jsonb_array_elements(v_deduction_rows) item
      )
    order by workforce.id
    for update;

    perform public.lock_workforce_payment_allocation_company(p_company_id);

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
  end if;

  for v_row in select value from jsonb_array_elements(v_deduction_rows)
  loop
    v_row_number := nullif(v_row ->> 'row_number', '')::integer;
    v_action := upper(btrim(v_row ->> 'action'));
    v_input_type := upper(btrim(v_row ->> 'input_type'));
    v_workforce_id := nullif(v_row ->> 'workforce_id', '')::uuid;
    v_station_id := nullif(v_row ->> 'station_id', '')::uuid;
    v_deduction_head_id := nullif(v_row ->> 'deduction_head_id', '')::uuid;
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
    if v_input_type <> 'DEDUCTION' then
      raise exception 'Row % has an invalid deduction input type.', v_row_number;
    end if;
    if v_from is null or v_to is null
      or v_from <> p_effective_from or v_to <> p_effective_to then
      raise exception 'Row % deduction must use the exact selected payout period.', v_row_number;
    end if;
    if v_action = 'CLEAR' and (v_numeric_value is not null or v_text_value is not null or v_work_minutes is not null) then
      raise exception 'Row % CLEAR action must not contain a value.', v_row_number;
    end if;
    if v_action = 'UPSERT' and (v_numeric_value is null or v_numeric_value < 0) then
      raise exception 'Row % requires a non-negative deduction amount.', v_row_number;
    end if;
    if v_action = 'UPSERT' and v_text_value is not null then
      raise exception 'Row % deduction value must be numeric.', v_row_number;
    end if;
    if v_work_minutes is not null then
      raise exception 'Row % work minutes are only valid for attendance.', v_row_number;
    end if;
    if nullif(v_row ->> 'payment_field_id', '') is not null
      or nullif(v_row ->> 'additional_payment_field_id', '') is not null then
      raise exception 'Row % deduction cannot reference a payment field.', v_row_number;
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

    if v_station_id is null then
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
    if not public.workforce_additional_payment_location_is_authorized(
      p_company_id,
      v_workforce_id,
      v_station_id,
      v_from,
      v_to
    ) then
      raise exception 'Row % deduction location must be the Workforce current location or an overlapping historical payment location.', v_row_number;
    end if;

    select head.*
    into v_head
    from public.workforce_deduction_heads head
    where head.company_id = p_company_id
      and head.id = v_deduction_head_id
      and upper(btrim(head.code)) = v_field_code
      and (
        v_action = 'CLEAR'
        or (
          head.is_active = true
          and head.calculation_type = 'manual'
          and head.is_system = false
        )
      );
    if not found then
      if v_action = 'CLEAR' then
        raise exception 'Row % deduction head and code do not belong to this company.', v_row_number;
      end if;
      raise exception 'Row % deduction head must be an active manual-entry head that is not system-managed.', v_row_number;
    end if;

    if exists (
      select 1
      from public.workforce_payout_deduction_values existing
      where existing.company_id = p_company_id
        and existing.workforce_id = v_workforce_id
        and existing.deduction_head_id = v_deduction_head_id
        and daterange(existing.effective_from, existing.effective_to, '[]')
          && daterange(v_from, v_to, '[]')
        and (existing.effective_from, existing.effective_to) <> (v_from, v_to)
    ) then
      raise exception 'Row % partially overlaps an existing deduction. Clear it or use the exact existing period.', v_row_number;
    end if;
    if exists (
      select 1
      from public.workforce_payout_deduction_values existing
      where existing.company_id = p_company_id
        and existing.workforce_id = v_workforce_id
        and existing.deduction_head_id = v_deduction_head_id
        and existing.effective_from = v_from
        and existing.effective_to = v_to
        and existing.station_id is distinct from v_station_id
    ) then
      raise exception 'Row % deduction already belongs to another location.', v_row_number;
    end if;

    insert into public.workforce_payout_import_rows (
      batch_id, company_id, row_number, action, workforce_id, dropx_id_snapshot,
      station_id, input_type, payment_field_id, additional_payment_field_id,
      deduction_head_id, field_code_snapshot, effective_from, effective_to,
      numeric_value, text_value, work_minutes, remark, raw_payload
    ) values (
      v_batch_id, p_company_id, v_row_number, v_action, v_workforce_id, v_dropx_id,
      v_station_id, 'DEDUCTION', null, null,
      v_deduction_head_id, v_head.code, v_from, v_to,
      v_numeric_value, null, null, v_remark, v_row
    ) returning id into v_import_row_id;

    if v_action = 'CLEAR' then
      delete from public.workforce_payout_deduction_values
      where company_id = p_company_id
        and workforce_id = v_workforce_id
        and station_id = v_station_id
        and deduction_head_id = v_deduction_head_id
        and effective_from = v_from
        and effective_to = v_to;
    else
      insert into public.workforce_payout_deduction_values (
        company_id, deduction_head_id, workforce_id, station_id,
        head_code_snapshot, head_name_snapshot, effective_from, effective_to,
        amount, source_type, source_batch_id, source_row_id, import_metadata,
        created_by, updated_by
      ) values (
        p_company_id, v_deduction_head_id, v_workforce_id, v_station_id,
        v_head.code, v_head.name, v_from, v_to,
        v_numeric_value, 'bulk_import', v_batch_id, v_import_row_id,
        jsonb_build_object('file_sha256', p_file_sha256, 'remark', v_remark),
        p_actor_user_id, p_actor_user_id
      )
      on conflict (company_id, deduction_head_id, workforce_id, effective_from, effective_to)
      do update set
        amount = excluded.amount,
        source_type = 'bulk_import',
        source_batch_id = excluded.source_batch_id,
        source_row_id = excluded.source_row_id,
        import_metadata = excluded.import_metadata,
        updated_by = excluded.updated_by,
        updated_at = clock_timestamp();
    end if;
  end loop;

  update public.workforce_payout_import_batches
  set row_count = jsonb_array_length(p_rows)
  where id = v_batch_id and company_id = p_company_id;

  return v_batch_id;
end;
$function$;

comment on function public.workforce_apply_payout_import(uuid, date, date, text, text, jsonb, uuid, uuid[]) is
  'Atomically applies attendance, field-value, production, additional-payment, and exact-period manual-deduction rows while preserving field-scoped replacement and immutable row audit.';

create or replace function public.workforce_payout_input_snapshot_hash(
  p_company_id uuid,
  p_period_start date,
  p_period_end date
)
returns text
language sql
security definer
set search_path = ''
as $function$
  select md5(coalesce(jsonb_agg(material.payload order by material.source_kind, material.id)::text, '[]'))
  from (
    select
      'attendance'::text as source_kind,
      item.id::text as id,
      jsonb_build_object(
        'id', item.id::text,
        'workforce_id', item.workforce_id::text,
        'station_id', item.station_id::text,
        'work_date', item.work_date,
        'attendance_status', item.attendance_status,
        'work_day_units', item.work_day_units,
        'work_minutes', item.work_minutes,
        'updated_at_epoch', extract(epoch from item.updated_at)
      ) as payload
    from public.workforce_payout_attendance_overrides item
    where item.company_id = p_company_id
      and item.work_date between p_period_start and p_period_end

    union all

    select
      'payment_field'::text,
      item.id::text,
      jsonb_build_object(
        'id', item.id::text,
        'workforce_id', item.workforce_id::text,
        'station_id', item.station_id::text,
        'payment_field_id', item.payment_field_id::text,
        'field_code_snapshot', item.field_code_snapshot,
        'effective_from', item.effective_from,
        'effective_to', item.effective_to,
        'input_value', item.input_value,
        'updated_at_epoch', extract(epoch from item.updated_at)
      )
    from public.workforce_payment_field_overrides item
    where item.company_id = p_company_id
      and daterange(item.effective_from, item.effective_to, '[]')
        && daterange(p_period_start, p_period_end, '[]')

    union all

    select
      'production'::text,
      item.id::text,
      jsonb_build_object(
        'id', item.id::text,
        'workforce_id', item.workforce_id::text,
        'station_id', item.station_id::text,
        'payment_field_id', item.payment_field_id::text,
        'field_code_snapshot', item.field_code_snapshot,
        'work_date', item.work_date,
        'units', item.units,
        'updated_at_epoch', extract(epoch from item.updated_at)
      )
    from public.workforce_custom_production_inputs item
    where item.company_id = p_company_id
      and item.work_date between p_period_start and p_period_end

    union all

    select
      'additional'::text,
      item.id::text,
      jsonb_build_object(
        'id', item.id::text,
        'workforce_id', item.workforce_id::text,
        'station_id', item.station_id::text,
        'additional_payment_field_id', item.additional_payment_field_id::text,
        'field_code_snapshot', item.field_code_snapshot,
        'field_name_snapshot', item.field_name_snapshot,
        'calculation_type_snapshot', item.calculation_type_snapshot,
        'effective_from', item.effective_from,
        'effective_to', item.effective_to,
        'input_value', item.input_value,
        'rate_value', item.rate_value,
        'final_amount', item.final_amount,
        'updated_at_epoch', extract(epoch from item.updated_at)
      )
    from public.workforce_additional_payment_values item
    where item.company_id = p_company_id
      and daterange(item.effective_from, item.effective_to, '[]')
        && daterange(p_period_start, p_period_end, '[]')

    union all

    select
      'deduction'::text,
      item.id::text,
      jsonb_build_object(
        'id', item.id::text,
        'workforce_id', item.workforce_id::text,
        'station_id', item.station_id::text,
        'deduction_head_id', item.deduction_head_id::text,
        'head_code_snapshot', item.head_code_snapshot,
        'head_name_snapshot', item.head_name_snapshot,
        'effective_from', item.effective_from,
        'effective_to', item.effective_to,
        'amount', item.amount,
        'updated_at_epoch', extract(epoch from item.updated_at)
      )
    from public.workforce_payout_deduction_values item
    where item.company_id = p_company_id
      and daterange(item.effective_from, item.effective_to, '[]')
        && daterange(p_period_start, p_period_end, '[]')
  ) material;
$function$;

comment on function public.workforce_payout_input_snapshot_hash(uuid, date, date) is
  'Hashes every attendance, configured payment-field, production, additional-payment, and manual-deduction input overlapping a Workforce payout period.';

create trigger workforce_payout_deduction_values_01_finalized_guard
before insert or update or delete on public.workforce_payout_deduction_values
for each row execute function public.guard_finalized_workforce_payout_input();

alter table public.workforce_payout_deduction_values enable row level security;

revoke all on table public.workforce_payout_deduction_values
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.workforce_payout_deduction_values
  to service_role;

create policy workforce_payout_deduction_values_service_role_all
  on public.workforce_payout_deduction_values
  for all
  to service_role
  using (true)
  with check (true);

revoke all on function public.prepare_workforce_payout_deduction_value(),
  public.workforce_apply_payout_import_without_deductions(uuid, date, date, text, text, jsonb, uuid, uuid[]),
  public.workforce_apply_payout_import(uuid, date, date, text, text, jsonb, uuid, uuid[])
  from public, anon, authenticated, service_role;

grant execute on function public.workforce_apply_payout_import(uuid, date, date, text, text, jsonb, uuid, uuid[])
  to service_role;

notify pgrst, 'reload schema';

commit;
