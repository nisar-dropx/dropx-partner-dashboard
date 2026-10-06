begin;

create extension if not exists pgcrypto;
create extension if not exists btree_gist;

create table public.workforce_additional_payment_fields (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  code text not null,
  name text not null,
  description text,
  calculation_type text not null default 'manual_amount',
  default_rate_value numeric(18,4),
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workforce_additional_payment_fields_company_code_unique
    unique (company_id, code),
  constraint workforce_additional_payment_fields_code_check
    check (
      code = upper(btrim(code))
      and code ~ '^[A-Z][A-Z0-9_-]{0,63}$'
    ),
  constraint workforce_additional_payment_fields_name_check
    check (btrim(name) <> ''),
  constraint workforce_additional_payment_fields_description_check
    check (description is null or btrim(description) <> ''),
  constraint workforce_additional_payment_fields_calculation_type_check
    check (calculation_type in ('manual_amount', 'units_x_rate')),
  constraint workforce_additional_payment_fields_default_rate_check
    check (
      (calculation_type = 'manual_amount' and default_rate_value is null)
      or (
        calculation_type = 'units_x_rate'
        and default_rate_value is not null
        and default_rate_value >= 0
      )
    )
);

create unique index workforce_additional_payment_fields_company_id_id_uidx
  on public.workforce_additional_payment_fields (company_id, id);

create index workforce_additional_payment_fields_company_active_idx
  on public.workforce_additional_payment_fields (company_id, is_active, name, code);

-- These indexes already exist in current installations. Declaring them here
-- keeps the composite foreign keys valid for installations assembled from a
-- reduced migration history as well.
create unique index if not exists workforce_company_id_id_uidx
  on public.workforce (company_id, id);
create unique index if not exists stations_company_id_id_uidx
  on public.stations (company_id, id);

create table public.workforce_additional_payment_values (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  additional_payment_field_id uuid not null,
  workforce_id uuid not null,
  station_id uuid,
  station_code_snapshot text,
  field_code_snapshot text not null,
  field_name_snapshot text not null,
  calculation_type_snapshot text not null,
  effective_from date not null,
  effective_to date not null,
  input_value numeric(18,4) not null,
  rate_value numeric(18,4),
  final_amount numeric(18,2) not null,
  source_type text not null default 'manual',
  import_batch_id uuid,
  import_row_number integer,
  import_metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workforce_additional_payment_values_field_company_fk
    foreign key (company_id, additional_payment_field_id)
    references public.workforce_additional_payment_fields (company_id, id)
    on delete restrict,
  constraint workforce_additional_payment_values_workforce_company_fk
    foreign key (company_id, workforce_id)
    references public.workforce (company_id, id)
    on delete restrict,
  constraint workforce_additional_payment_values_station_company_fk
    foreign key (company_id, station_id)
    references public.stations (company_id, id)
    on delete restrict,
  constraint workforce_additional_payment_values_exact_period_unique
    unique (
      company_id,
      additional_payment_field_id,
      workforce_id,
      effective_from,
      effective_to
    ),
  constraint workforce_additional_payment_values_no_overlap
    exclude using gist (
      company_id with =,
      additional_payment_field_id with =,
      workforce_id with =,
      daterange(effective_from, effective_to, '[]') with &&
    ),
  constraint workforce_additional_payment_values_date_order_check
    check (effective_to >= effective_from),
  constraint workforce_additional_payment_values_input_check
    check (input_value >= 0),
  constraint workforce_additional_payment_values_rate_check
    check (rate_value is null or rate_value >= 0),
  constraint workforce_additional_payment_values_final_amount_check
    check (final_amount >= 0),
  constraint workforce_additional_payment_values_calculation_type_check
    check (calculation_type_snapshot in ('manual_amount', 'units_x_rate')),
  constraint workforce_additional_payment_values_source_type_check
    check (btrim(source_type) <> ''),
  constraint workforce_additional_payment_values_import_row_check
    check (import_row_number is null or import_row_number > 0),
  constraint workforce_additional_payment_values_import_metadata_check
    check (jsonb_typeof(import_metadata) = 'object'),
  constraint workforce_additional_payment_values_calculation_check
    check (
      (
        calculation_type_snapshot = 'manual_amount'
        and rate_value is null
        and final_amount = round(input_value, 2)
      )
      or (
        calculation_type_snapshot = 'units_x_rate'
        and rate_value is not null
        and final_amount = round(input_value * rate_value, 2)
      )
    )
);

create index workforce_additional_payment_values_company_period_idx
  on public.workforce_additional_payment_values (
    company_id,
    effective_from,
    effective_to,
    workforce_id
  );

create index workforce_additional_payment_values_workforce_period_idx
  on public.workforce_additional_payment_values (
    company_id,
    workforce_id,
    effective_from,
    effective_to
  );

create index workforce_additional_payment_values_station_period_idx
  on public.workforce_additional_payment_values (
    company_id,
    station_id,
    effective_from,
    effective_to
  );

create index workforce_additional_payment_values_import_batch_idx
  on public.workforce_additional_payment_values (company_id, import_batch_id)
  where import_batch_id is not null;

comment on table public.workforce_additional_payment_fields is
  'Company-wide earning definitions available to every canonical Workforce member independently of provider or payment-method mapping.';
comment on column public.workforce_additional_payment_fields.default_rate_value is
  'Required per-unit amount for units_x_rate; manual amounts store NULL.';
comment on table public.workforce_additional_payment_values is
  'Exact-period additional earning inputs for one canonical Workforce member. final_amount is normalized by the preparation trigger.';
comment on column public.workforce_additional_payment_values.input_value is
  'Manual amount or unit count according to calculation_type_snapshot.';
comment on column public.workforce_additional_payment_values.rate_value is
  'Resolved per-unit rate snapshot used by units_x_rate. Manual amounts always store NULL.';
comment on column public.workforce_additional_payment_values.import_batch_id is
  'Optional bulk-import batch identifier. A later import-batch migration may add a foreign key without changing this value contract.';

create or replace function public.workforce_additional_payment_location_is_authorized(
  p_company_id uuid,
  p_workforce_id uuid,
  p_station_id uuid,
  p_effective_from date,
  p_effective_to date
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  with worker as (
    select workforce.id, workforce.location_id, workforce.source_profile_type, workforce.source_profile_id
    from public.workforce workforce
    where workforce.company_id = p_company_id
      and workforce.id = p_workforce_id
  )
  select coalesce((
    select
      p_station_id is not null
      and p_effective_from is not null
      and p_effective_to is not null
      and p_effective_to >= p_effective_from
      and (
        worker.location_id = p_station_id
        or exists (
          select 1
          from public.field_executive_provider_mappings mapping
          where mapping.company_id = p_company_id
            and (
              mapping.workforce_id = worker.id
              or (worker.source_profile_type = 'employee' and mapping.employee_id = worker.source_profile_id)
              or (worker.source_profile_type = 'contractor' and mapping.contractor_id = worker.source_profile_id)
              or (worker.source_profile_type = 'field_executive' and mapping.field_executive_id = worker.source_profile_id)
            )
            and mapping.station_id = p_station_id
            and mapping.status <> 'cancelled'
            and mapping.effective_from <= p_effective_to
            and (mapping.effective_to is null or mapping.effective_to >= p_effective_from)
        )
        or exists (
          select 1
          from public.workforce_payment_allocations allocation
          where allocation.company_id = p_company_id
            and allocation.workforce_id = worker.id
            and allocation.station_id = p_station_id
            and allocation.status <> 'cancelled'
            and allocation.effective_from <= p_effective_to
            and (allocation.effective_to is null or allocation.effective_to >= p_effective_from)
        )
      )
    from worker
  ), false);
$function$;

comment on function public.workforce_additional_payment_location_is_authorized(uuid, uuid, uuid, date, date) is
  'Allows the Workforce current location or any provider/direct setup location overlapping the additional-payment period. Payment-method mapping and full-period station ownership are not required.';

create or replace function public.prepare_workforce_additional_payment_field()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.code := upper(btrim(new.code));
  new.name := btrim(new.name);
  new.description := nullif(btrim(new.description), '');
  new.updated_at := clock_timestamp();
  return new;
end;
$function$;

create trigger workforce_additional_payment_fields_00_prepare
before insert or update
on public.workforce_additional_payment_fields
for each row execute function public.prepare_workforce_additional_payment_field();

create or replace function public.prepare_workforce_additional_payment_value()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_field public.workforce_additional_payment_fields%rowtype;
  v_workforce_station_id uuid;
begin
  select field.*
  into v_field
  from public.workforce_additional_payment_fields field
  where field.company_id = new.company_id
    and field.id = new.additional_payment_field_id;

  if not found then
    raise exception 'Additional payment field does not belong to this company.';
  end if;

  if not v_field.is_active
    and (tg_op = 'INSERT' or new.additional_payment_field_id is distinct from old.additional_payment_field_id) then
    raise exception 'Inactive additional payment fields cannot receive new values.';
  end if;

  select workforce.location_id
  into v_workforce_station_id
  from public.workforce workforce
  where workforce.company_id = new.company_id
    and workforce.id = new.workforce_id;

  if not found then
    raise exception 'Workforce member does not belong to this company.';
  end if;

  new.station_id := coalesce(new.station_id, v_workforce_station_id);
  new.station_code_snapshot := null;
  if new.station_id is not null then
    select station.station_code
    into new.station_code_snapshot
    from public.stations station
    where station.company_id = new.company_id
      and station.id = new.station_id;

    if not found then
      raise exception 'Station does not belong to this company.';
    end if;
  end if;

  new.field_code_snapshot := v_field.code;
  new.field_name_snapshot := v_field.name;
  new.calculation_type_snapshot := v_field.calculation_type;
  new.source_type := btrim(new.source_type);
  new.import_metadata := coalesce(new.import_metadata, '{}'::jsonb);

  if new.input_value is null or new.input_value < 0 then
    raise exception 'Additional payment input must be a non-negative number.';
  end if;

  if v_field.calculation_type = 'manual_amount' then
    new.rate_value := null;
    new.final_amount := round(new.input_value, 2);
  else
    new.rate_value := coalesce(new.rate_value, v_field.default_rate_value);
    if new.rate_value is null then
      raise exception 'A rate is required for additional payment field %.', v_field.code;
    end if;
    if new.rate_value < 0 then
      raise exception 'Additional payment rate must be a non-negative number.';
    end if;

    new.final_amount := round(new.input_value * new.rate_value, 2);
  end if;

  new.updated_at := clock_timestamp();
  return new;
end;
$function$;

create trigger workforce_additional_payment_values_00_prepare
before insert or update
on public.workforce_additional_payment_values
for each row execute function public.prepare_workforce_additional_payment_value();

create or replace function public.workforce_additional_payment_period_is_finalized(
  p_company_id uuid,
  p_workforce_id uuid,
  p_effective_from date,
  p_effective_to date
)
returns boolean
language sql
stable
set search_path = ''
as $function$
  select exists (
    select 1
    from public.workforce_payroll_runs payroll_run
    where payroll_run.company_id = p_company_id
      and lower(coalesce(payroll_run.status, '')) in ('approved', 'paid')
      and daterange(payroll_run.period_start, payroll_run.period_end, '[]')
        && daterange(p_effective_from, p_effective_to, '[]')
  );
$function$;

create or replace function public.guard_finalized_workforce_additional_payment_value()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' then
    perform 1
    from public.workforce workforce
    where workforce.company_id = new.company_id
      and workforce.id = new.workforce_id
    for update;

    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'workforce-payment-allocation-company:' || new.company_id::text,
      0
    ));

    if not public.workforce_additional_payment_location_is_authorized(
      new.company_id,
      new.workforce_id,
      new.station_id,
      new.effective_from,
      new.effective_to
    ) then
      raise exception 'Additional payment location must be the Workforce current location or an overlapping historical payment location.';
    end if;

    if public.workforce_additional_payment_period_is_finalized(
      new.company_id,
      new.workforce_id,
      new.effective_from,
      new.effective_to
    ) then
      raise exception 'Approved or paid Workforce payroll exists for this additional payment period.';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    perform 1
    from public.workforce workforce
    where workforce.company_id = old.company_id
      and workforce.id = old.workforce_id
    for update;

    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'workforce-payment-allocation-company:' || old.company_id::text,
      0
    ));

    if public.workforce_additional_payment_period_is_finalized(
      old.company_id,
      old.workforce_id,
      old.effective_from,
      old.effective_to
    ) then
      raise exception 'Approved or paid Workforce payroll uses this additional payment value.';
    end if;
    return old;
  end if;

  -- Lock both canonical identities and company mutexes in deterministic order
  -- so identity/date corrections cannot race payroll approval.
  perform 1
  from public.workforce workforce
  where (workforce.company_id = old.company_id and workforce.id = old.workforce_id)
     or (workforce.company_id = new.company_id and workforce.id = new.workforce_id)
  order by workforce.company_id, workforce.id
  for update;

  if old.company_id::text <= new.company_id::text then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'workforce-payment-allocation-company:' || old.company_id::text,
      0
    ));
    if new.company_id is distinct from old.company_id then
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'workforce-payment-allocation-company:' || new.company_id::text,
        0
      ));
    end if;
  else
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'workforce-payment-allocation-company:' || new.company_id::text,
      0
    ));
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'workforce-payment-allocation-company:' || old.company_id::text,
      0
    ));
  end if;

  if not public.workforce_additional_payment_location_is_authorized(
    new.company_id,
    new.workforce_id,
    new.station_id,
    new.effective_from,
    new.effective_to
  ) then
    raise exception 'Additional payment location must be the Workforce current location or an overlapping historical payment location.';
  end if;

  if public.workforce_additional_payment_period_is_finalized(
      old.company_id,
      old.workforce_id,
      old.effective_from,
      old.effective_to
    )
    or public.workforce_additional_payment_period_is_finalized(
      new.company_id,
      new.workforce_id,
      new.effective_from,
      new.effective_to
    ) then
    raise exception 'Approved or paid Workforce payroll uses this additional payment value.';
  end if;

  return new;
end;
$function$;

create trigger workforce_additional_payment_values_01_finalized_guard
before insert or update or delete
on public.workforce_additional_payment_values
for each row execute function public.guard_finalized_workforce_additional_payment_value();

alter table public.workforce_additional_payment_fields enable row level security;
alter table public.workforce_additional_payment_values enable row level security;

revoke all on table public.workforce_additional_payment_fields
  from public, anon, authenticated, service_role;
revoke all on table public.workforce_additional_payment_values
  from public, anon, authenticated, service_role;

grant select, insert, update
  on table public.workforce_additional_payment_fields
  to service_role;
grant select, insert, update, delete
  on table public.workforce_additional_payment_values
  to service_role;

create policy workforce_additional_payment_fields_service_role_all
on public.workforce_additional_payment_fields
for all
to service_role
using (true)
with check (true);

create policy workforce_additional_payment_values_service_role_all
on public.workforce_additional_payment_values
for all
to service_role
using (true)
with check (true);

revoke all on function public.prepare_workforce_additional_payment_field(),
  public.prepare_workforce_additional_payment_value(),
  public.workforce_additional_payment_location_is_authorized(uuid, uuid, uuid, date, date),
  public.workforce_additional_payment_period_is_finalized(uuid, uuid, date, date),
  public.guard_finalized_workforce_additional_payment_value()
  from public, anon, authenticated;

grant execute on function public.prepare_workforce_additional_payment_field(),
  public.prepare_workforce_additional_payment_value(),
  public.workforce_additional_payment_location_is_authorized(uuid, uuid, uuid, date, date),
  public.workforce_additional_payment_period_is_finalized(uuid, uuid, date, date),
  public.guard_finalized_workforce_additional_payment_value()
  to service_role;

notify pgrst, 'reload schema';

commit;
