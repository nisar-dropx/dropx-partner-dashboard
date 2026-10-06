begin;

create extension if not exists btree_gist;

-- Keep historical daily attendance-import audit rows valid while allowing the
-- new aggregate range contract. The public importer below only writes the new
-- numeric shape; the legacy branch exists solely for already committed rows.
alter table public.workforce_payout_import_rows
  drop constraint workforce_payout_import_rows_value_shape_check,
  drop constraint workforce_payout_import_rows_field_shape_check;

alter table public.workforce_payout_import_rows
  add constraint workforce_payout_import_rows_value_shape_check
    check (
      (action = 'CLEAR' and numeric_value is null and text_value is null and work_minutes is null)
      or
      (
        action = 'UPSERT'
        and (
          (
            input_type = 'ATTENDANCE'
            and (
              (numeric_value is not null and numeric_value >= 0 and text_value is null and work_minutes is null)
              or
              (numeric_value is null and text_value in ('P', 'HD', 'A'))
            )
          )
          or
          (input_type <> 'ATTENDANCE' and numeric_value is not null and numeric_value >= 0 and text_value is null)
        )
      )
    ),
  add constraint workforce_payout_import_rows_field_shape_check
    check (
      (
        input_type = 'ATTENDANCE'
        and payment_field_id is null
        and additional_payment_field_id is null
        and deduction_head_id is null
        and (field_code_snapshot in ('WORK_HOURS', 'WORK_DAYS') or field_code_snapshot is null)
        and (numeric_value is null or field_code_snapshot in ('WORK_HOURS', 'WORK_DAYS'))
      )
      or
      (input_type in ('PRODUCTION_UNITS', 'PAYMENT_FIELD_VALUE') and payment_field_id is not null and additional_payment_field_id is null and deduction_head_id is null)
      or
      (input_type = 'ADDITIONAL_PAYMENT' and payment_field_id is null and additional_payment_field_id is not null and deduction_head_id is null)
      or
      (input_type = 'DEDUCTION' and payment_field_id is null and additional_payment_field_id is null and deduction_head_id is not null)
    );

create table public.workforce_payout_attendance_values (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  workforce_id uuid not null,
  station_id uuid not null,
  attendance_basis text not null,
  effective_from date not null,
  effective_to date not null,
  quantity numeric(18,4) not null,
  source_type text not null default 'bulk_import',
  source_batch_id uuid not null references public.workforce_payout_import_batches(id) on delete restrict,
  source_row_id uuid not null references public.workforce_payout_import_rows(id) on delete restrict,
  import_metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workforce_payout_attendance_values_workforce_company_fk
    foreign key (company_id, workforce_id)
    references public.workforce (company_id, id)
    on delete restrict,
  constraint workforce_payout_attendance_values_station_company_fk
    foreign key (company_id, station_id)
    references public.stations (company_id, id)
    on delete restrict,
  constraint workforce_payout_attendance_values_exact_period_unique
    unique (company_id, workforce_id, effective_from, effective_to),
  constraint workforce_payout_attendance_values_no_overlap
    exclude using gist (
      company_id with =,
      workforce_id with =,
      daterange(effective_from, effective_to, '[]') with &&
    ),
  constraint workforce_payout_attendance_values_basis_check
    check (attendance_basis in ('hours', 'days')),
  constraint workforce_payout_attendance_values_period_check
    check (effective_to >= effective_from),
  constraint workforce_payout_attendance_values_single_month_check
    check (
      extract(year from effective_from) = extract(year from effective_to)
      and extract(month from effective_from) = extract(month from effective_to)
    ),
  constraint workforce_payout_attendance_values_quantity_check
    check (quantity >= 0),
  constraint workforce_payout_attendance_values_quantity_capacity_check
    check (
      (attendance_basis = 'hours' and quantity <= ((effective_to - effective_from + 1) * 24))
      or
      (attendance_basis = 'days' and quantity <= (effective_to - effective_from + 1))
    ),
  constraint workforce_payout_attendance_values_source_check
    check (source_type = 'bulk_import'),
  constraint workforce_payout_attendance_values_metadata_check
    check (jsonb_typeof(import_metadata) = 'object')
);

create index workforce_payout_attendance_values_company_period_idx
  on public.workforce_payout_attendance_values (company_id, effective_from, effective_to, workforce_id);
create index workforce_payout_attendance_values_station_period_idx
  on public.workforce_payout_attendance_values (company_id, station_id, effective_from, effective_to);
create index workforce_payout_attendance_values_source_batch_idx
  on public.workforce_payout_attendance_values (source_batch_id);
create index workforce_payout_attendance_values_source_row_idx
  on public.workforce_payout_attendance_values (source_row_id);
create index workforce_payout_attendance_values_created_by_idx
  on public.workforce_payout_attendance_values (created_by);
create index workforce_payout_attendance_values_updated_by_idx
  on public.workforce_payout_attendance_values (updated_by);

comment on table public.workforce_payout_attendance_values is
  'Exact-period aggregate WORK_HOURS or WORK_DAYS values imported for one canonical Workforce member. Periods may not overlap for the same Workforce member.';

create or replace function public.prepare_workforce_payout_attendance_value()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not exists (
    select 1
    from public.workforce workforce
    where workforce.company_id = new.company_id
      and workforce.id = new.workforce_id
      and workforce.deleted_at is null
      and coalesce(workforce.migration_state, '') <> 'reclassified'
  ) then
    raise exception 'Attendance Workforce member must be active in this company scope.';
  end if;
  if not exists (
    select 1
    from public.stations station
    where station.company_id = new.company_id
      and station.id = new.station_id
  ) then
    raise exception 'Attendance location must belong to this company.';
  end if;
  if new.attendance_basis not in ('hours', 'days') then
    raise exception 'Attendance basis must be hours or days.';
  end if;
  if new.effective_from is null or new.effective_to is null or new.effective_to < new.effective_from then
    raise exception 'A valid attendance effective range is required.';
  end if;
  if date_trunc('month', new.effective_from::timestamp)
    <> date_trunc('month', new.effective_to::timestamp) then
    raise exception 'Attendance must stay within one calendar month. Split the row at the month boundary.';
  end if;
  if new.quantity is null or new.quantity < 0 then
    raise exception 'Attendance quantity must be zero or greater.';
  end if;
  if new.attendance_basis = 'hours'
    and new.quantity > ((new.effective_to - new.effective_from + 1) * 24) then
    raise exception 'WORK_HOURS quantity cannot exceed 24 hours for each inclusive effective date.';
  end if;
  if new.attendance_basis = 'days'
    and new.quantity > (new.effective_to - new.effective_from + 1) then
    raise exception 'WORK_DAYS quantity cannot exceed the inclusive effective-day count.';
  end if;

  new.source_type := 'bulk_import';
  new.import_metadata := coalesce(new.import_metadata, '{}'::jsonb);
  new.updated_at := clock_timestamp();
  return new;
end;
$function$;

create trigger workforce_payout_attendance_values_00_prepare
before insert or update on public.workforce_payout_attendance_values
for each row execute function public.prepare_workforce_payout_attendance_value();

-- Preserve the deduction-aware implementation for every existing input type.
-- The stable public signature below removes only new FIELD_CODE/VALUE attendance
-- rows before forwarding, then writes their range aggregates into the new table
-- in the same transaction. Legacy daily status payloads continue through the
-- retained importer during a rolling application deployment.
alter function public.workforce_apply_payout_import(uuid, date, date, text, text, jsonb, uuid, uuid[])
  rename to workforce_apply_payout_import_without_attendance_values;

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
  v_attendance_rows jsonb;
  v_row jsonb;
  v_row_number integer;
  v_action text;
  v_workforce_id uuid;
  v_station_id uuid;
  v_from date;
  v_to date;
  v_numeric_value numeric(18,4);
  v_text_value text;
  v_work_minutes integer;
  v_dropx_id text;
  v_field_code text;
  v_attendance_basis text;
  v_remark text;
  v_worker public.workforce%rowtype;
  v_existing_station_id uuid;
  v_attendance_source_count integer;
  v_covering_source_count integer;
  v_required_basis text;
  v_has_rate_boundary boolean;
  v_has_monthly_attendance boolean;
  v_policy_calculation_method text;
  v_policy_paid_off_days smallint;
  v_policy_work_units_per_paid_off numeric;
  v_policy_cap_at_monthly_amount boolean;
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

  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
  into v_existing_rows
  from jsonb_array_elements(p_rows) with ordinality item(value, ordinality)
  where upper(btrim(item.value ->> 'input_type')) <> 'ATTENDANCE'
    or (
      nullif(upper(btrim(item.value ->> 'field_code')), '') is null
      and nullif(item.value ->> 'numeric_value', '') is null
      and (
        nullif(upper(btrim(item.value ->> 'text_value')), '') in ('P', 'HD', 'A')
        or upper(btrim(item.value ->> 'action')) = 'CLEAR'
      )
    );

  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
  into v_attendance_rows
  from jsonb_array_elements(p_rows) with ordinality item(value, ordinality)
  where upper(btrim(item.value ->> 'input_type')) = 'ATTENDANCE'
    and not (
      nullif(upper(btrim(item.value ->> 'field_code')), '') is null
      and nullif(item.value ->> 'numeric_value', '') is null
      and (
        nullif(upper(btrim(item.value ->> 'text_value')), '') in ('P', 'HD', 'A')
        or upper(btrim(item.value ->> 'action')) = 'CLEAR'
      )
    );

  with normalized_rows as (
    select
      nullif(item.value ->> 'row_number', '')::integer as row_number,
      jsonb_build_array(
        item.value ->> 'workforce_id',
        item.value ->> 'effective_from',
        item.value ->> 'effective_to'
      ) as resolved_identity
    from jsonb_array_elements(v_attendance_rows) item(value)
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
    raise exception 'Row % duplicates resolved ATTENDANCE input from row %. Keep one action for each stored payout input.',
      v_duplicate_row_number, v_duplicate_first_row_number;
  end if;

  perform 1
  from public.workforce workforce
  where workforce.company_id = p_company_id
    and workforce.id in (
      select distinct nullif(item ->> 'workforce_id', '')::uuid
      from jsonb_array_elements(p_rows) item
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

  if jsonb_array_length(v_existing_rows) > 0 then
    v_batch_id := public.workforce_apply_payout_import_without_attendance_values(
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
    insert into public.workforce_payout_import_batches (
      company_id, effective_from, effective_to, file_name, file_sha256,
      status, row_count, created_by, committed_at
    ) values (
      p_company_id, p_effective_from, p_effective_to, btrim(p_file_name), p_file_sha256,
      'committed', jsonb_array_length(p_rows), p_actor_user_id, clock_timestamp()
    ) returning id into v_batch_id;
  end if;

  for v_row in select value from jsonb_array_elements(v_attendance_rows)
  loop
    v_row_number := nullif(v_row ->> 'row_number', '')::integer;
    v_action := upper(btrim(v_row ->> 'action'));
    v_workforce_id := nullif(v_row ->> 'workforce_id', '')::uuid;
    v_station_id := nullif(v_row ->> 'station_id', '')::uuid;
    v_from := nullif(v_row ->> 'effective_from', '')::date;
    v_to := nullif(v_row ->> 'effective_to', '')::date;
    v_numeric_value := nullif(v_row ->> 'numeric_value', '')::numeric;
    v_text_value := nullif(btrim(v_row ->> 'text_value'), '');
    v_work_minutes := nullif(v_row ->> 'work_minutes', '')::integer;
    v_dropx_id := upper(btrim(v_row ->> 'dropx_id'));
    v_field_code := nullif(upper(btrim(v_row ->> 'field_code')), '');
    v_attendance_basis := case v_field_code
      when 'WORK_HOURS' then 'hours'
      when 'WORK_DAYS' then 'days'
      else null
    end;
    v_remark := nullif(left(btrim(v_row ->> 'remark'), 500), '');

    if v_row_number is null or v_row_number < 2 then
      raise exception 'Every payout import row requires its spreadsheet row number.';
    end if;
    if v_action is null or v_action not in ('UPSERT', 'CLEAR') then
      raise exception 'Row % has an invalid action.', v_row_number;
    end if;
    if v_attendance_basis is null then
      raise exception 'Row % attendance FIELD_CODE must be WORK_HOURS or WORK_DAYS.', v_row_number;
    end if;
    if v_from is null or v_to is null or v_to < v_from
      or v_from < p_effective_from or v_to > p_effective_to then
      raise exception 'Row % attendance effective range is outside the selected payout import period.', v_row_number;
    end if;
    if nullif(v_row ->> 'payment_field_id', '') is not null
      or nullif(v_row ->> 'additional_payment_field_id', '') is not null
      or nullif(v_row ->> 'deduction_head_id', '') is not null then
      raise exception 'Row % attendance cannot reference a payment or deduction field.', v_row_number;
    end if;
    if v_action = 'CLEAR' and (v_numeric_value is not null or v_text_value is not null or v_work_minutes is not null) then
      raise exception 'Row % CLEAR action must not contain a value.', v_row_number;
    end if;
    if v_action = 'UPSERT' and (v_numeric_value is null or v_numeric_value < 0) then
      raise exception 'Row % attendance requires a non-negative numeric VALUE.', v_row_number;
    end if;
    if v_action = 'UPSERT'
      and date_trunc('month', v_from::timestamp) <> date_trunc('month', v_to::timestamp) then
      raise exception 'Row % attendance must stay within one calendar month. Split the row at the month boundary.', v_row_number;
    end if;
    if v_text_value is not null or v_work_minutes is not null then
      raise exception 'Row % aggregate attendance must use numeric VALUE without text status or work minutes.', v_row_number;
    end if;
    if v_action = 'UPSERT' and v_attendance_basis = 'hours'
      and v_numeric_value > ((v_to - v_from + 1) * 24) then
      raise exception 'Row % WORK_HOURS VALUE cannot exceed 24 hours for each inclusive effective date.', v_row_number;
    end if;
    if v_action = 'UPSERT' and v_attendance_basis = 'days'
      and v_numeric_value > (v_to - v_from + 1) then
      raise exception 'Row % WORK_DAYS VALUE cannot exceed the inclusive effective-day count.', v_row_number;
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
    if v_station_id is null or not exists (
      select 1
      from public.stations station
      where station.company_id = p_company_id
        and station.id = v_station_id
    ) then
      raise exception 'Row % does not have a valid company location.', v_row_number;
    end if;
    if p_allowed_location_ids is not null and not (v_station_id = any(p_allowed_location_ids)) then
      raise exception 'Row % is outside the importing user''s location scope.', v_row_number;
    end if;

    if v_action = 'UPSERT' then
      select
        count(*)::integer,
        count(*) filter (where source.covers_range)::integer,
        min(source.required_basis)
      into v_attendance_source_count, v_covering_source_count, v_required_basis
      from (
        select
          'provider:' || mapping.id::text as source_id,
          case
            when bool_or(
              lower(coalesce(field.calculation_source, '')) = 'attendance_eligibility'
              and lower(coalesce(field.field_type, component.component_type, '')) <> 'production'
              and lower(coalesce(field.pay_schedule, component.pay_schedule, '')) = 'per_hour'
            ) and bool_or(
              lower(coalesce(field.calculation_source, '')) = 'attendance_eligibility'
              and lower(coalesce(field.field_type, component.component_type, '')) <> 'production'
              and lower(coalesce(field.pay_schedule, component.pay_schedule, '')) in ('per_day', 'per_month')
            ) then 'mixed'
            when bool_or(
              lower(coalesce(field.calculation_source, '')) = 'attendance_eligibility'
              and lower(coalesce(field.field_type, component.component_type, '')) <> 'production'
              and lower(coalesce(field.pay_schedule, component.pay_schedule, '')) = 'per_hour'
            ) then 'hours'
            when bool_or(
              lower(coalesce(field.calculation_source, '')) = 'attendance_eligibility'
              and lower(coalesce(field.field_type, component.component_type, '')) <> 'production'
              and lower(coalesce(field.pay_schedule, component.pay_schedule, '')) in ('per_day', 'per_month')
            ) then 'days'
            else null
          end as required_basis,
          mapping.effective_from <= v_from
            and (mapping.effective_to is null or mapping.effective_to >= v_to) as covers_range
        from public.field_executive_provider_mappings mapping
        left join public.payment_method_components component
          on component.company_id = p_company_id
         and component.payment_method_id = mapping.payment_method_id
         and component.is_active = true
        left join public.payment_fields field
          on field.company_id = p_company_id
         and field.id = component.payment_field_id
        where mapping.company_id = p_company_id
          and (
            mapping.workforce_id = v_workforce_id
            or (v_worker.source_profile_type = 'employee' and mapping.employee_id = v_worker.source_profile_id)
            or (v_worker.source_profile_type = 'contractor' and mapping.contractor_id = v_worker.source_profile_id)
            or (v_worker.source_profile_type = 'field_executive' and mapping.field_executive_id = v_worker.source_profile_id)
          )
          and (mapping.station_id is null or mapping.station_id = v_station_id)
          and mapping.status in ('active', 'closed')
          and mapping.effective_from <= v_to
          and (mapping.effective_to is null or mapping.effective_to >= v_from)
        group by mapping.id

        union all

        select
          'direct:' || allocation.id::text,
          case
            when exists (
              select 1
              from jsonb_array_elements(allocation.payment_components) snapshot(component)
              where lower(replace(replace(coalesce(snapshot.component ->> 'calculation_source', ''), '-', '_'), ' ', '_')) = 'attendance_eligibility'
                and lower(replace(replace(coalesce(snapshot.component ->> 'component_type', ''), '-', '_'), ' ', '_')) <> 'production'
                and lower(replace(replace(coalesce(snapshot.component ->> 'pay_schedule', ''), '-', '_'), ' ', '_')) = 'per_hour'
            ) and exists (
              select 1
              from jsonb_array_elements(allocation.payment_components) snapshot(component)
              where lower(replace(replace(coalesce(snapshot.component ->> 'calculation_source', ''), '-', '_'), ' ', '_')) = 'attendance_eligibility'
                and lower(replace(replace(coalesce(snapshot.component ->> 'component_type', ''), '-', '_'), ' ', '_')) <> 'production'
                and lower(replace(replace(coalesce(snapshot.component ->> 'pay_schedule', ''), '-', '_'), ' ', '_')) in ('per_day', 'per_month')
            ) then 'mixed'
            when exists (
              select 1
              from jsonb_array_elements(allocation.payment_components) snapshot(component)
              where lower(replace(replace(coalesce(snapshot.component ->> 'calculation_source', ''), '-', '_'), ' ', '_')) = 'attendance_eligibility'
                and lower(replace(replace(coalesce(snapshot.component ->> 'component_type', ''), '-', '_'), ' ', '_')) <> 'production'
                and lower(replace(replace(coalesce(snapshot.component ->> 'pay_schedule', ''), '-', '_'), ' ', '_')) = 'per_hour'
            ) then 'hours'
            when exists (
              select 1
              from jsonb_array_elements(allocation.payment_components) snapshot(component)
              where lower(replace(replace(coalesce(snapshot.component ->> 'calculation_source', ''), '-', '_'), ' ', '_')) = 'attendance_eligibility'
                and lower(replace(replace(coalesce(snapshot.component ->> 'component_type', ''), '-', '_'), ' ', '_')) <> 'production'
                and lower(replace(replace(coalesce(snapshot.component ->> 'pay_schedule', ''), '-', '_'), ' ', '_')) in ('per_day', 'per_month')
            ) then 'days'
            else null
          end,
          allocation.effective_from <= v_from
            and (allocation.effective_to is null or allocation.effective_to >= v_to)
        from public.workforce_payment_allocations allocation
        where allocation.company_id = p_company_id
          and allocation.workforce_id = v_workforce_id
          and (allocation.station_id is null or allocation.station_id = v_station_id)
          and allocation.status in ('active', 'closed')
          and allocation.effective_from <= v_to
          and (allocation.effective_to is null or allocation.effective_to >= v_from)
      ) source
      where source.required_basis is not null;

      if v_attendance_source_count <> 1 or v_covering_source_count <> 1 then
        raise exception 'Row % attendance VALUE must be covered by exactly one payment allocation for the entire effective range. Split the row at payment-method or effective-date changes.', v_row_number;
      end if;
      if v_required_basis = 'mixed' then
        raise exception 'Row % payment allocation mixes hourly and daily or monthly attendance pay. One attendance VALUE cannot represent both WORK_HOURS and WORK_DAYS.', v_row_number;
      end if;
      if v_required_basis is distinct from v_attendance_basis then
        raise exception 'Row % attendance FIELD_CODE % does not match the effective payment allocation basis %.',
          v_row_number, v_field_code, case v_required_basis when 'hours' then 'WORK_HOURS' else 'WORK_DAYS' end;
      end if;

      select exists (
        select 1
        from public.field_executive_provider_mappings mapping
        join public.payment_method_components component
          on component.company_id = p_company_id
         and component.payment_method_id = mapping.payment_method_id
         and component.is_active = true
        join public.payment_fields field
          on field.company_id = p_company_id
         and field.id = component.payment_field_id
        join public.workforce_payment_field_overrides rate_override
          on rate_override.company_id = p_company_id
         and rate_override.workforce_id = v_workforce_id
         and rate_override.station_id = v_station_id
         and rate_override.payment_field_id = field.id
        where mapping.company_id = p_company_id
          and (
            mapping.workforce_id = v_workforce_id
            or (v_worker.source_profile_type = 'employee' and mapping.employee_id = v_worker.source_profile_id)
            or (v_worker.source_profile_type = 'contractor' and mapping.contractor_id = v_worker.source_profile_id)
            or (v_worker.source_profile_type = 'field_executive' and mapping.field_executive_id = v_worker.source_profile_id)
          )
          and (mapping.station_id is null or mapping.station_id = v_station_id)
          and mapping.status in ('active', 'closed')
          and mapping.effective_from <= v_from
          and (mapping.effective_to is null or mapping.effective_to >= v_to)
          and lower(coalesce(field.calculation_source, '')) = 'attendance_eligibility'
          and lower(coalesce(field.field_type, component.component_type, '')) <> 'production'
          and lower(coalesce(field.pay_schedule, component.pay_schedule, '')) in ('per_hour', 'per_day', 'per_month')
          and rate_override.effective_from <= v_to
          and rate_override.effective_to >= v_from
          and (rate_override.effective_from > v_from or rate_override.effective_to < v_to)

        union all

        select 1
        from public.workforce_payment_allocations allocation
        cross join lateral jsonb_array_elements(allocation.payment_components) snapshot(component)
        join public.workforce_payment_field_overrides rate_override
          on rate_override.company_id = p_company_id
         and rate_override.workforce_id = v_workforce_id
         and rate_override.station_id = v_station_id
         and (
           (
             nullif(btrim(snapshot.component ->> 'payment_field_id'), '') is not null
             and rate_override.payment_field_id::text = nullif(btrim(snapshot.component ->> 'payment_field_id'), '')
           )
           or (
             nullif(btrim(snapshot.component ->> 'payment_field_id'), '') is null
             and upper(btrim(rate_override.field_code_snapshot)) = upper(btrim(snapshot.component ->> 'component_code'))
           )
         )
        where allocation.company_id = p_company_id
          and allocation.workforce_id = v_workforce_id
          and (allocation.station_id is null or allocation.station_id = v_station_id)
          and allocation.status in ('active', 'closed')
          and allocation.effective_from <= v_from
          and (allocation.effective_to is null or allocation.effective_to >= v_to)
          and lower(replace(replace(coalesce(snapshot.component ->> 'calculation_source', ''), '-', '_'), ' ', '_')) = 'attendance_eligibility'
          and lower(replace(replace(coalesce(snapshot.component ->> 'component_type', ''), '-', '_'), ' ', '_')) <> 'production'
          and lower(replace(replace(coalesce(snapshot.component ->> 'pay_schedule', ''), '-', '_'), ' ', '_')) in ('per_hour', 'per_day', 'per_month')
          and rate_override.effective_from <= v_to
          and rate_override.effective_to >= v_from
          and (rate_override.effective_from > v_from or rate_override.effective_to < v_to)
      ) into v_has_rate_boundary;

      if v_has_rate_boundary then
        raise exception 'Row % has an attendance payment-field rate override boundary inside its effective range. Split the row at every rate boundary.', v_row_number;
      end if;

      select exists (
        select 1
        from public.field_executive_provider_mappings mapping
        join public.payment_method_components component
          on component.company_id = p_company_id
         and component.payment_method_id = mapping.payment_method_id
         and component.is_active = true
        join public.payment_fields field
          on field.company_id = p_company_id
         and field.id = component.payment_field_id
        where mapping.company_id = p_company_id
          and (
            mapping.workforce_id = v_workforce_id
            or (v_worker.source_profile_type = 'employee' and mapping.employee_id = v_worker.source_profile_id)
            or (v_worker.source_profile_type = 'contractor' and mapping.contractor_id = v_worker.source_profile_id)
            or (v_worker.source_profile_type = 'field_executive' and mapping.field_executive_id = v_worker.source_profile_id)
          )
          and (mapping.station_id is null or mapping.station_id = v_station_id)
          and mapping.status in ('active', 'closed')
          and mapping.effective_from <= v_from
          and (mapping.effective_to is null or mapping.effective_to >= v_to)
          and lower(coalesce(field.calculation_source, '')) = 'attendance_eligibility'
          and lower(coalesce(field.field_type, component.component_type, '')) <> 'production'
          and (
            lower(coalesce(field.pay_schedule, component.pay_schedule, '')) = 'per_month'
            or lower(coalesce(field.calculation_type, '')) = 'fixed_monthly'
          )

        union all

        select 1
        from public.workforce_payment_allocations allocation
        cross join lateral jsonb_array_elements(allocation.payment_components) snapshot(component)
        where allocation.company_id = p_company_id
          and allocation.workforce_id = v_workforce_id
          and (allocation.station_id is null or allocation.station_id = v_station_id)
          and allocation.status in ('active', 'closed')
          and allocation.effective_from <= v_from
          and (allocation.effective_to is null or allocation.effective_to >= v_to)
          and lower(replace(replace(coalesce(snapshot.component ->> 'calculation_source', ''), '-', '_'), ' ', '_')) = 'attendance_eligibility'
          and lower(replace(replace(coalesce(snapshot.component ->> 'component_type', ''), '-', '_'), ' ', '_')) <> 'production'
          and (
            lower(replace(replace(coalesce(snapshot.component ->> 'pay_schedule', ''), '-', '_'), ' ', '_')) = 'per_month'
            or lower(replace(replace(coalesce(snapshot.component ->> 'calculation_type', ''), '-', '_'), ' ', '_')) = 'fixed_monthly'
          )
      ) into v_has_monthly_attendance;

      if v_has_monthly_attendance then
        select
          setting.calculation_method,
          setting.paid_off_days,
          setting.work_units_per_paid_off,
          setting.cap_at_monthly_amount
        into
          v_policy_calculation_method,
          v_policy_paid_off_days,
          v_policy_work_units_per_paid_off,
          v_policy_cap_at_monthly_amount
        from public.workforce_payment_settings setting
        where setting.company_id = p_company_id
          and setting.effective_from <= v_from
        order by setting.effective_from desc
        limit 1;

        if not found then
          v_policy_calculation_method := 'calendar_days';
          v_policy_paid_off_days := 4;
          v_policy_work_units_per_paid_off := 6;
          v_policy_cap_at_monthly_amount := true;
        end if;

        if exists (
          select 1
          from public.workforce_payment_settings setting
          where setting.company_id = p_company_id
            and setting.effective_from > v_from
            and setting.effective_from <= v_to
            and (
              setting.calculation_method,
              setting.paid_off_days,
              setting.work_units_per_paid_off,
              setting.cap_at_monthly_amount
            ) is distinct from (
              v_policy_calculation_method,
              v_policy_paid_off_days,
              v_policy_work_units_per_paid_off,
              v_policy_cap_at_monthly_amount
            )
        ) then
          raise exception 'Row % has a monthly attendance payment policy change inside its effective range. Split the row at every policy effective date.', v_row_number;
        end if;
      end if;
    end if;

    if exists (
      select 1
      from public.workforce_payout_attendance_values existing
      where existing.company_id = p_company_id
        and existing.workforce_id = v_workforce_id
        and daterange(existing.effective_from, existing.effective_to, '[]')
          && daterange(v_from, v_to, '[]')
        and (existing.effective_from, existing.effective_to) <> (v_from, v_to)
    ) then
      raise exception 'Row % partially overlaps an existing attendance value. Split the row or clear the existing exact period first.', v_row_number;
    end if;

    select existing.station_id
    into v_existing_station_id
    from public.workforce_payout_attendance_values existing
    where existing.company_id = p_company_id
      and existing.workforce_id = v_workforce_id
      and existing.effective_from = v_from
      and existing.effective_to = v_to;

    if found and v_existing_station_id is distinct from v_station_id then
      raise exception 'Row % attendance period already belongs to another location. Clear it from that location first.', v_row_number;
    end if;

    insert into public.workforce_payout_import_rows (
      batch_id, company_id, row_number, action, workforce_id, dropx_id_snapshot,
      station_id, input_type, payment_field_id, additional_payment_field_id,
      deduction_head_id, field_code_snapshot, effective_from, effective_to,
      numeric_value, text_value, work_minutes, remark, raw_payload
    ) values (
      v_batch_id, p_company_id, v_row_number, v_action, v_workforce_id, v_dropx_id,
      v_station_id, 'ATTENDANCE', null, null,
      null, v_field_code, v_from, v_to,
      v_numeric_value, null, null, v_remark, v_row
    ) returning id into v_import_row_id;

    if v_action = 'CLEAR' then
      delete from public.workforce_payout_attendance_values
      where company_id = p_company_id
        and workforce_id = v_workforce_id
        and effective_from = v_from
        and effective_to = v_to;
    else
      insert into public.workforce_payout_attendance_values (
        company_id, workforce_id, station_id, attendance_basis,
        effective_from, effective_to, quantity, source_type,
        source_batch_id, source_row_id, import_metadata,
        created_by, updated_by
      ) values (
        p_company_id, v_workforce_id, v_station_id, v_attendance_basis,
        v_from, v_to, v_numeric_value, 'bulk_import',
        v_batch_id, v_import_row_id,
        jsonb_build_object('file_sha256', p_file_sha256, 'field_code', v_field_code, 'remark', v_remark),
        p_actor_user_id, p_actor_user_id
      )
      on conflict (company_id, workforce_id, effective_from, effective_to)
      do update set
        station_id = excluded.station_id,
        attendance_basis = excluded.attendance_basis,
        quantity = excluded.quantity,
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
  'Atomically applies aggregate attendance ranges and forwards every non-attendance payout input through the deduction-aware importer, preserving locking, scope, idempotency, and row audit.';

-- Preserve the exact legacy hash when no aggregate values overlap the period,
-- so already-calculated payrolls do not become stale merely by deploying this
-- schema. Aggregate values extend that material only when they exist.
alter function public.workforce_payout_input_snapshot_hash(uuid, date, date)
  rename to workforce_payout_input_snapshot_hash_without_attendance_values;

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
  with base as (
    select public.workforce_payout_input_snapshot_hash_without_attendance_values(
      p_company_id,
      p_period_start,
      p_period_end
    ) as snapshot_hash
  ), attendance as (
    select jsonb_agg(
      jsonb_build_object(
        'id', item.id::text,
        'workforce_id', item.workforce_id::text,
        'station_id', item.station_id::text,
        'attendance_basis', item.attendance_basis,
        'effective_from', item.effective_from,
        'effective_to', item.effective_to,
        'quantity', item.quantity,
        'updated_at_epoch', extract(epoch from item.updated_at)
      ) order by item.id
    ) as payload
    from public.workforce_payout_attendance_values item
    where item.company_id = p_company_id
      and daterange(item.effective_from, item.effective_to, '[]')
        && daterange(p_period_start, p_period_end, '[]')
  )
  select case
    when attendance.payload is null then base.snapshot_hash
    else md5(jsonb_build_object(
      'base_hash', base.snapshot_hash,
      'attendance_values', attendance.payload
    )::text)
  end
  from base cross join attendance;
$function$;

comment on function public.workforce_payout_input_snapshot_hash(uuid, date, date) is
  'Hashes every payout input overlapping a Workforce payout period, including aggregate WORK_HOURS and WORK_DAYS ranges.';

create trigger workforce_payout_attendance_values_01_finalized_guard
before insert or update or delete on public.workforce_payout_attendance_values
for each row execute function public.guard_finalized_workforce_payout_input();

alter table public.workforce_payout_attendance_values enable row level security;

revoke all on table public.workforce_payout_attendance_values
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.workforce_payout_attendance_values
  to service_role;

create policy workforce_payout_attendance_values_service_role_all
  on public.workforce_payout_attendance_values
  for all
  to service_role
  using (true)
  with check (true);

revoke all on function public.prepare_workforce_payout_attendance_value(),
  public.workforce_apply_payout_import_without_attendance_values(uuid, date, date, text, text, jsonb, uuid, uuid[]),
  public.workforce_payout_input_snapshot_hash_without_attendance_values(uuid, date, date),
  public.workforce_apply_payout_import(uuid, date, date, text, text, jsonb, uuid, uuid[]),
  public.workforce_payout_input_snapshot_hash(uuid, date, date)
  from public, anon, authenticated, service_role;

grant execute on function public.workforce_apply_payout_import(uuid, date, date, text, text, jsonb, uuid, uuid[])
  to service_role;

notify pgrst, 'reload schema';

commit;
