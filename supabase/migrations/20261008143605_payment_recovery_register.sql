begin;

create or replace function public.normalize_payment_recovery_tid(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $function$
  select nullif(
    pg_catalog.upper(
      pg_catalog.regexp_replace(pg_catalog.btrim(coalesce(p_value, '')), '[[:space:]]+', '', 'g')
    ),
    ''
  )
$function$;

-- Composite tenant foreign keys below require an exact unique key. Provider
-- codes are globally unique today, but keeping the company in the key prevents
-- a recovery case from ever pointing at another company's provider.
create unique index if not exists providers_company_id_id_uidx
  on public.providers(company_id, id);

create table public.payment_recovery_import_batches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  file_name text not null,
  file_sha256 text not null,
  row_count integer not null default 0 check (row_count >= 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint payment_recovery_import_batches_hash_check
    check (file_sha256 ~ '^[0-9a-f]{64}$'),
  constraint payment_recovery_import_batches_company_hash_unique
    unique (company_id, file_sha256),
  constraint payment_recovery_import_batches_company_id_unique
    unique (company_id, id)
);

create table public.payment_recovery_cases (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  tid text not null,
  provider_id uuid not null,
  station_id uuid not null,
  debit_date date not null,
  debit_amount numeric(18,2) not null check (debit_amount > 0),
  recovery_method text not null
    check (recovery_method in ('payout_deduction', 'post_invoice_dispute')),
  status text not null
    check (status in (
      'awaiting_registration',
      'ready_for_deduction',
      'partially_recovered',
      'recovered',
      'planned_provider_dispute',
      'under_provider_dispute',
      'provider_credited',
      'dispute_rejected',
      'reversed'
    )),
  provider_code_snapshot text not null,
  provider_name_snapshot text not null,
  station_code_snapshot text not null,
  provider_reference text,
  reason text,
  remark text,
  source_type text not null default 'bulk_import'
    check (source_type in ('bulk_import', 'manual')),
  source_batch_id uuid,
  source_row_number integer,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_recovery_cases_company_id_unique unique (company_id, id),
  constraint payment_recovery_cases_tid_check
    check (public.normalize_payment_recovery_tid(tid) is not null and pg_catalog.char_length(tid) <= 120),
  constraint payment_recovery_cases_provider_company_fk
    foreign key (company_id, provider_id)
    references public.providers(company_id, id)
    on delete restrict,
  constraint payment_recovery_cases_station_company_fk
    foreign key (company_id, station_id)
    references public.stations(company_id, id)
    on delete restrict,
  constraint payment_recovery_cases_batch_company_fk
    foreign key (company_id, source_batch_id)
    references public.payment_recovery_import_batches(company_id, id)
    on delete restrict,
  constraint payment_recovery_cases_source_shape_check check (
    (source_type = 'manual' and source_batch_id is null and source_row_number is null)
    or
    (source_type = 'bulk_import' and source_batch_id is not null and source_row_number > 0)
  )
);

create unique index payment_recovery_cases_company_tid_uidx
  on public.payment_recovery_cases(company_id, public.normalize_payment_recovery_tid(tid));
create index payment_recovery_cases_company_date_idx
  on public.payment_recovery_cases(company_id, debit_date desc, id);
create index payment_recovery_cases_company_status_idx
  on public.payment_recovery_cases(company_id, status, recovery_method, id);
create index payment_recovery_cases_provider_idx
  on public.payment_recovery_cases(company_id, provider_id, debit_date desc);
create index payment_recovery_cases_station_idx
  on public.payment_recovery_cases(company_id, station_id, debit_date desc);
create index payment_recovery_cases_source_batch_idx
  on public.payment_recovery_cases(source_batch_id);

create table public.payment_recovery_allocations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  recovery_case_id uuid not null,
  imported_dropx_id text not null,
  target_type text not null
    check (target_type in ('workforce', 'contractor', 'employee', 'pending')),
  target_id uuid,
  workforce_id uuid,
  station_id uuid,
  person_name_snapshot text not null,
  category_snapshot text not null,
  allocation_amount numeric(18,2) not null check (allocation_amount > 0),
  link_status text not null default 'linked'
    check (link_status in ('pending', 'linked')),
  allocation_order integer not null check (allocation_order > 0),
  linked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_recovery_allocations_company_id_unique unique (company_id, id),
  constraint payment_recovery_allocations_company_case_id_unique
    unique (company_id, recovery_case_id, id),
  constraint payment_recovery_allocations_case_company_fk
    foreign key (company_id, recovery_case_id)
    references public.payment_recovery_cases(company_id, id)
    on delete restrict,
  constraint payment_recovery_allocations_workforce_company_fk
    foreign key (company_id, workforce_id)
    references public.workforce(company_id, id)
    on delete restrict,
  constraint payment_recovery_allocations_station_company_fk
    foreign key (company_id, station_id)
    references public.stations(company_id, id)
    on delete restrict,
  constraint payment_recovery_allocations_dropx_check
    check (public.normalize_people_dropx_id(imported_dropx_id) is not null and pg_catalog.char_length(imported_dropx_id) <= 80),
  constraint payment_recovery_allocations_link_shape_check check (
    (
      link_status = 'pending'
      and target_type = 'pending'
      and target_id is null
      and workforce_id is null
      and station_id is null
      and linked_at is null
    )
    or
    (
      link_status = 'linked'
      and target_type <> 'pending'
      and target_id is not null
      and station_id is not null
      and linked_at is not null
    )
  )
);

create unique index payment_recovery_allocations_case_dropx_uidx
  on public.payment_recovery_allocations(
    company_id,
    recovery_case_id,
    public.normalize_people_dropx_id(imported_dropx_id)
  );
create index payment_recovery_allocations_company_target_idx
  on public.payment_recovery_allocations(company_id, target_type, target_id);
create index payment_recovery_allocations_company_workforce_idx
  on public.payment_recovery_allocations(company_id, workforce_id)
  where workforce_id is not null;
create index payment_recovery_allocations_pending_dropx_idx
  on public.payment_recovery_allocations(
    company_id,
    public.normalize_people_dropx_id(imported_dropx_id),
    recovery_case_id
  ) where link_status = 'pending';

create table public.payment_recovery_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  recovery_case_id uuid not null,
  allocation_id uuid,
  event_type text not null
    check (event_type in ('payout_deduction', 'provider_credit', 'manual_recovery', 'reversal')),
  status text not null default 'applied'
    check (status in ('applied', 'reversed')),
  amount numeric(18,2) not null check (amount > 0),
  period_start date,
  period_end date,
  reference text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  reversed_by uuid references auth.users(id) on delete set null,
  reversed_at timestamptz,
  reversal_reason text,
  constraint payment_recovery_events_case_company_fk
    foreign key (company_id, recovery_case_id)
    references public.payment_recovery_cases(company_id, id)
    on delete restrict,
  constraint payment_recovery_events_allocation_case_company_fk
    foreign key (company_id, recovery_case_id, allocation_id)
    references public.payment_recovery_allocations(company_id, recovery_case_id, id)
    on delete restrict,
  constraint payment_recovery_events_period_check check (
    (period_start is null and period_end is null)
    or (period_start is not null and period_end is not null and period_end >= period_start)
  ),
  constraint payment_recovery_events_reversal_check check (
    (status = 'applied' and reversed_at is null and reversed_by is null)
    or (status = 'reversed' and reversed_at is not null)
  )
);

create index payment_recovery_events_case_idx
  on public.payment_recovery_events(company_id, recovery_case_id, status, created_at);
create index payment_recovery_events_allocation_idx
  on public.payment_recovery_events(company_id, allocation_id, status)
  where allocation_id is not null;

create or replace function public.resolve_payment_recovery_person(
  p_company_id uuid,
  p_dropx_id text
)
returns table (
  match_count integer,
  target_type text,
  target_id uuid,
  workforce_id uuid,
  station_id uuid,
  person_name text,
  category text
)
language sql
stable
set search_path = ''
as $function$
  with normalized as (
    select public.normalize_people_dropx_id(p_dropx_id) dropx_id
  ),
  candidates as (
    select
      'employee'::text target_type,
      employee.id target_id,
      canonical.id workforce_id,
      employee.location_id station_id,
      coalesce(nullif(employee.full_name, ''), 'Registered person') person_name,
      'Employee'::text category,
      'employee'::text logical_type,
      employee.id logical_id,
      1 candidate_order
    from public.employees employee
    cross join normalized
    left join lateral (
      select workforce.id
      from public.workforce workforce
      where workforce.company_id = employee.company_id
        and workforce.source_profile_type = 'employee'
        and workforce.source_profile_id = employee.id
        and workforce.is_active is true
        and workforce.deleted_at is null
        and coalesce(workforce.migration_state, 'canonical')
          not in ('reclassified', 'moved_to_vendor')
      order by workforce.id
      limit 1
    ) canonical on true
    where employee.company_id = p_company_id
      and employee.is_active is true
      and employee.deleted_at is null
      and public.normalize_people_dropx_id(employee.employee_code) = normalized.dropx_id

    union all

    select
      'contractor',
      contractor.id,
      canonical.id,
      contractor.location_id,
      coalesce(nullif(contractor.full_name, ''), 'Registered person'),
      'Independent Contractor',
      'contractor',
      contractor.id,
      1
    from public.contractors contractor
    cross join normalized
    left join lateral (
      select workforce.id
      from public.workforce workforce
      where workforce.company_id = contractor.company_id
        and workforce.source_profile_type = 'contractor'
        and workforce.source_profile_id = contractor.id
        and workforce.is_active is true
        and workforce.deleted_at is null
        and coalesce(workforce.migration_state, 'canonical')
          not in ('reclassified', 'moved_to_vendor')
      order by workforce.id
      limit 1
    ) canonical on true
    where contractor.company_id = p_company_id
      and contractor.is_active is true
      and contractor.deleted_at is null
      and public.normalize_people_dropx_id(contractor.dropx_id) = normalized.dropx_id

    union all

    select
      'workforce',
      workforce.id,
      workforce.id,
      workforce.location_id,
      coalesce(nullif(workforce.full_name, ''), 'Registered person'),
      'Workforce',
      case
        when workforce.source_profile_type in ('employee', 'contractor')
          and workforce.source_profile_id is not null
          then workforce.source_profile_type
        else 'workforce'
      end,
      case
        when workforce.source_profile_type in ('employee', 'contractor')
          and workforce.source_profile_id is not null
          then workforce.source_profile_id
        else workforce.id
      end,
      2
    from public.workforce workforce
    cross join normalized
    where workforce.company_id = p_company_id
      and workforce.is_active is true
      and workforce.deleted_at is null
      and coalesce(workforce.migration_state, 'canonical')
        not in ('reclassified', 'moved_to_vendor')
      and public.normalize_people_dropx_id(workforce.dropx_id) = normalized.dropx_id
  ),
  logical_matches as (
    select distinct candidate.logical_type, candidate.logical_id
    from candidates candidate
  ),
  counts as (
    select pg_catalog.count(*)::integer match_count
    from logical_matches
  ),
  representative as (
    select candidate.target_type, candidate.target_id, candidate.workforce_id,
           candidate.station_id, candidate.person_name, candidate.category
    from candidates candidate
    order by candidate.candidate_order, candidate.target_type, candidate.target_id
    limit 1
  )
  select counts.match_count,
         case when counts.match_count = 1 then representative.target_type end,
         case when counts.match_count = 1 then representative.target_id end,
         case when counts.match_count = 1 then representative.workforce_id end,
         case when counts.match_count = 1 then representative.station_id end,
         case when counts.match_count = 1 then representative.person_name end,
         case when counts.match_count = 1 then representative.category end
  from counts
  left join representative on counts.match_count = 1
$function$;

create or replace function public.payment_recovery_apply_import(
  p_company_id uuid,
  p_file_name text,
  p_file_sha256 text,
  p_rows jsonb,
  p_actor_user_id uuid,
  p_allowed_location_ids uuid[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_existing_batch_id uuid;
  v_batch_id uuid;
  v_row jsonb;
  v_target jsonb;
  v_targets jsonb;
  v_case_id uuid;
  v_row_number integer;
  v_tid text;
  v_normalized_tid text;
  v_provider_code text;
  v_location_code text;
  v_debit_date date;
  v_debit_amount numeric(18,2);
  v_recovery_method text;
  v_provider public.providers%rowtype;
  v_station public.stations%rowtype;
  v_dropx_id text;
  v_normalized_dropx_id text;
  v_match_count integer;
  v_target_type text;
  v_target_id uuid;
  v_workforce_id uuid;
  v_target_station_id uuid;
  v_person_name text;
  v_category text;
  v_target_count integer;
  v_target_index integer;
  v_total_cents bigint;
  v_base_cents bigint;
  v_remainder bigint;
  v_allocation_amount numeric(18,2);
  v_has_pending boolean;
  v_lock_key text;
  v_inserted_cases integer := 0;
  v_inserted_allocations integer := 0;
begin
  if p_company_id is null or p_actor_user_id is null then
    raise exception 'Company and actor are required.';
  end if;
  if p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'A valid workbook fingerprint is required.';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'The recovery workbook does not contain any rows.';
  end if;
  if jsonb_array_length(p_rows) > 10000 then
    raise exception 'A recovery workbook can contain at most 10000 TIDs.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_company_id::text || ':payment-recovery-import', 0)
  );

  select batch.id into v_existing_batch_id
  from public.payment_recovery_import_batches batch
  where batch.company_id = p_company_id
    and batch.file_sha256 = p_file_sha256;
  if found then
    return jsonb_build_object(
      'batch_id', v_existing_batch_id,
      'replayed', true,
      'cases', 0,
      'allocations', 0
    );
  end if;

  -- Lock every TID in a deterministic order before checking uniqueness.
  for v_normalized_tid in
    select distinct public.normalize_payment_recovery_tid(row_data.value->>'tid')
    from jsonb_array_elements(p_rows) row_data
    order by 1
  loop
    if v_normalized_tid is null then raise exception 'Every recovery row requires a TID.'; end if;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(p_company_id::text || ':payment-recovery-tid:' || v_normalized_tid, 0)
    );
    if exists (
      select 1 from public.payment_recovery_cases recovery
      where recovery.company_id = p_company_id
        and public.normalize_payment_recovery_tid(recovery.tid) = v_normalized_tid
    ) then
      raise exception 'TID % is already in the Recovery register.', v_normalized_tid;
    end if;
  end loop;

  -- Take the exact DropX identity mutex used by
  -- enforce_people_identity_uniqueness(). People lifecycle triggers below take
  -- the same locks before a registration can become eligible for linking.
  for v_lock_key in
    select distinct
      p_company_id::text || ':dropx:'
        || public.normalize_people_dropx_id(target.value->>'dropx_id')
    from pg_catalog.jsonb_array_elements(p_rows) row_data
    cross join lateral pg_catalog.jsonb_array_elements(
      case
        when pg_catalog.jsonb_typeof(coalesce(row_data.value->'targets', '[]'::jsonb)) = 'array'
          then coalesce(row_data.value->'targets', '[]'::jsonb)
        else '[]'::jsonb
      end
    ) target(value)
    where public.normalize_people_dropx_id(target.value->>'dropx_id') is not null
    order by 1
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_lock_key, 0)
    );
  end loop;

  insert into public.payment_recovery_import_batches(
    company_id, file_name, file_sha256, row_count, created_by
  ) values (
    p_company_id,
    left(coalesce(nullif(pg_catalog.btrim(p_file_name), ''), 'payment-recoveries.xlsx'), 240),
    p_file_sha256,
    jsonb_array_length(p_rows),
    p_actor_user_id
  ) returning id into v_batch_id;

  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    v_row_number := nullif(v_row->>'row_number', '')::integer;
    v_tid := nullif(pg_catalog.btrim(v_row->>'tid'), '');
    v_normalized_tid := public.normalize_payment_recovery_tid(v_tid);
    v_provider_code := pg_catalog.upper(pg_catalog.btrim(coalesce(v_row->>'provider_code', '')));
    v_location_code := pg_catalog.upper(pg_catalog.btrim(coalesce(v_row->>'location', '')));
    v_debit_date := nullif(v_row->>'debit_date', '')::date;
    v_debit_amount := round(coalesce(nullif(v_row->>'debit_amount', '')::numeric, 0), 2);
    v_recovery_method := pg_catalog.lower(pg_catalog.btrim(coalesce(v_row->>'recovery_method', '')));
    v_targets := coalesce(v_row->'targets', '[]'::jsonb);

    if v_row_number is null or v_row_number < 2 then raise exception 'Every recovery row requires its workbook row number.'; end if;
    if v_normalized_tid is null or pg_catalog.char_length(v_tid) > 120 then raise exception 'Row % has an invalid TID.', v_row_number; end if;
    if v_debit_date is null then raise exception 'Row % requires a valid debit date.', v_row_number; end if;
    if v_debit_amount <= 0 then raise exception 'Row % requires a debit amount greater than zero.', v_row_number; end if;
    if v_recovery_method not in ('payout_deduction', 'post_invoice_dispute') then
      raise exception 'Row % has an unsupported recovery method.', v_row_number;
    end if;
    if jsonb_typeof(v_targets) <> 'array' then raise exception 'Row % has invalid Recovery IDs.', v_row_number; end if;
    v_target_count := jsonb_array_length(v_targets);
    if v_recovery_method = 'payout_deduction' and (v_target_count < 1 or v_target_count > 50) then
      raise exception 'Row % requires between 1 and 50 Recovery IDs for payout deduction.', v_row_number;
    end if;
    if v_recovery_method = 'post_invoice_dispute' and v_target_count <> 0 then
      raise exception 'Row % must leave Recovery IDs blank for a post-invoice provider dispute.', v_row_number;
    end if;
    if v_recovery_method = 'payout_deduction'
      and round(v_debit_amount * 100)::bigint < v_target_count
    then
      raise exception 'Row % debit amount is too small to split across % Recovery IDs.', v_row_number, v_target_count;
    end if;

    select provider.* into v_provider
    from public.providers provider
    where provider.company_id = p_company_id
      and pg_catalog.upper(pg_catalog.btrim(provider.code)) = v_provider_code
    order by provider.id
    limit 1;
    if not found then raise exception 'Row % provider % was not found.', v_row_number, v_provider_code; end if;

    select station.* into v_station
    from public.stations station
    where station.company_id = p_company_id
      and pg_catalog.upper(pg_catalog.btrim(station.station_code)) = v_location_code
    order by station.id
    limit 1;
    if not found then raise exception 'Row % location % was not found.', v_row_number, v_location_code; end if;
    if v_station.provider_id is distinct from v_provider.id then
      raise exception 'Row % location % does not belong to provider %.',
        v_row_number, v_location_code, v_provider_code;
    end if;
    if p_allowed_location_ids is not null and not (v_station.id = any(p_allowed_location_ids)) then
      raise exception 'Row % location % is outside your access scope.', v_row_number, v_location_code;
    end if;

    insert into public.payment_recovery_cases(
      company_id, tid, provider_id, station_id, debit_date, debit_amount,
      recovery_method, status, provider_code_snapshot, provider_name_snapshot,
      station_code_snapshot, provider_reference, reason, remark,
      source_type, source_batch_id, source_row_number, created_by, updated_by
    ) values (
      p_company_id, v_tid, v_provider.id, v_station.id, v_debit_date, v_debit_amount,
      v_recovery_method,
      case when v_recovery_method = 'post_invoice_dispute' then 'planned_provider_dispute' else 'ready_for_deduction' end,
      coalesce(v_provider.code, v_provider_code), coalesce(v_provider.name, v_provider_code),
      coalesce(v_station.station_code, v_location_code),
      nullif(pg_catalog.btrim(v_row->>'provider_reference'), ''),
      nullif(pg_catalog.btrim(v_row->>'reason'), ''),
      nullif(pg_catalog.btrim(v_row->>'remark'), ''),
      'bulk_import', v_batch_id, v_row_number, p_actor_user_id, p_actor_user_id
    ) returning id into v_case_id;
    v_inserted_cases := v_inserted_cases + 1;

    v_has_pending := false;
    v_target_index := 0;
    v_total_cents := round(v_debit_amount * 100)::bigint;
    if v_target_count > 0 then
      v_base_cents := v_total_cents / v_target_count;
      v_remainder := v_total_cents % v_target_count;
    end if;

    for v_target in
      select target.value
      from jsonb_array_elements(v_targets) target
      order by public.normalize_people_dropx_id(target.value->>'dropx_id')
    loop
      v_target_index := v_target_index + 1;
      v_dropx_id := nullif(pg_catalog.btrim(v_target->>'dropx_id'), '');
      v_normalized_dropx_id := public.normalize_people_dropx_id(v_dropx_id);
      if v_normalized_dropx_id is null or pg_catalog.char_length(v_dropx_id) > 80 then
        raise exception 'Row % has an invalid Recovery ID.', v_row_number;
      end if;
      if exists (
        select 1
        from public.payment_recovery_allocations allocation
        where allocation.company_id = p_company_id
          and allocation.recovery_case_id = v_case_id
          and public.normalize_people_dropx_id(allocation.imported_dropx_id) = v_normalized_dropx_id
      ) then
        raise exception 'Row % lists Recovery ID % more than once.', v_row_number, v_dropx_id;
      end if;

      v_target_type := 'pending';
      v_target_id := null;
      v_workforce_id := null;
      v_target_station_id := null;
      v_person_name := 'Awaiting registration';
      v_category := 'Unregistered';

      select resolved.match_count,
             coalesce(resolved.target_type, v_target_type),
             resolved.target_id,
             resolved.workforce_id, resolved.station_id,
             coalesce(resolved.person_name, v_person_name),
             coalesce(resolved.category, v_category)
        into v_match_count, v_target_type, v_target_id,
             v_workforce_id, v_target_station_id,
             v_person_name, v_category
      from public.resolve_payment_recovery_person(
        p_company_id,
        v_normalized_dropx_id
      ) resolved;
      if v_match_count > 1 then
        raise exception 'Row % Recovery ID % matches more than one profile.', v_row_number, v_dropx_id;
      end if;

      if v_match_count = 1 then
        if v_target_station_id is null then
          raise exception 'Row % Recovery ID % has no payment location.', v_row_number, v_dropx_id;
        end if;
        if not exists (
          select 1
          from public.stations station
          where station.company_id = p_company_id
            and station.id = v_target_station_id
            and station.is_active is true
        ) then
          raise exception 'Row % Recovery ID % is not assigned to an active payment location.',
            v_row_number, v_dropx_id;
        end if;
        if p_allowed_location_ids is not null and not (v_target_station_id = any(p_allowed_location_ids)) then
          raise exception 'Row % Recovery ID % is outside your access scope.', v_row_number, v_dropx_id;
        end if;
      elsif exists (
        select 1 from public.helpers helper
        where helper.company_id = p_company_id
          and public.normalize_people_dropx_id(helper.dropx_id) = v_normalized_dropx_id
        union all
        select 1 from public.vendors vendor
        where vendor.company_id = p_company_id
          and public.normalize_people_dropx_id(vendor.dropx_id) = v_normalized_dropx_id
        union all
        select 1 from public.workforce_helpers helper
        where helper.company_id = p_company_id
          and public.normalize_people_dropx_id(helper.dropx_id) = v_normalized_dropx_id
        union all
        select 1 from public.workforce_pickers picker
        where picker.company_id = p_company_id
          and public.normalize_people_dropx_id(picker.dropx_id) = v_normalized_dropx_id
      ) then
        raise exception 'Row % Recovery ID % belongs to an unsupported category.', v_row_number, v_dropx_id;
      elsif p_allowed_location_ids is not null then
        raise exception 'Row % Recovery ID % is not registered. Company-wide access is required to retain it as pending.', v_row_number, v_dropx_id;
      else
        v_has_pending := true;
      end if;

      v_allocation_amount := (v_base_cents + case when v_target_index <= v_remainder then 1 else 0 end)::numeric / 100;
      insert into public.payment_recovery_allocations(
        company_id, recovery_case_id, imported_dropx_id,
        target_type, target_id, workforce_id, station_id,
        person_name_snapshot, category_snapshot, allocation_amount,
        link_status, allocation_order, linked_at
      ) values (
        p_company_id, v_case_id, v_dropx_id,
        v_target_type, v_target_id, v_workforce_id, v_target_station_id,
        v_person_name, v_category, v_allocation_amount,
        case when v_target_type = 'pending' then 'pending' else 'linked' end,
        v_target_index,
        case when v_target_type = 'pending' then null else clock_timestamp() end
      );
      v_inserted_allocations := v_inserted_allocations + 1;
    end loop;

    if v_has_pending then
      update public.payment_recovery_cases
      set status = 'awaiting_registration', updated_at = clock_timestamp(), updated_by = p_actor_user_id
      where company_id = p_company_id and id = v_case_id;
    end if;
  end loop;

  return jsonb_build_object(
    'batch_id', v_batch_id,
    'replayed', false,
    'cases', v_inserted_cases,
    'allocations', v_inserted_allocations
  );
end;
$function$;

create or replace function public.lock_payment_recovery_people_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_row jsonb := to_jsonb(new);
  v_old_row jsonb;
  v_code_column text := tg_argv[0];
  v_lock_key text;
begin
  if v_code_column not in ('employee_code', 'dropx_id') then
    raise exception 'Payment Recovery identity trigger has an invalid code-column configuration.';
  end if;
  if tg_op = 'UPDATE' then
    v_old_row := to_jsonb(old);
  end if;

  -- Lock both sides of an identity move in lexical order. This trigger name
  -- sorts before a00_people_identity_unique, so that trigger can safely re-take
  -- the new identity lock without reversing the order.
  for v_lock_key in
    select distinct lock_key
    from unnest(array[
      case
        when nullif(v_row->>'company_id', '') is not null
          and public.normalize_people_dropx_id(v_row->>v_code_column) is not null
          then (v_row->>'company_id') || ':dropx:'
            || public.normalize_people_dropx_id(v_row->>v_code_column)
      end,
      case
        when tg_op = 'UPDATE'
          and nullif(v_old_row->>'company_id', '') is not null
          and public.normalize_people_dropx_id(v_old_row->>v_code_column) is not null
          then (v_old_row->>'company_id') || ':dropx:'
            || public.normalize_people_dropx_id(v_old_row->>v_code_column)
      end
    ]) locks(lock_key)
    where lock_key is not null
    order by lock_key
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_lock_key, 0)
    );
  end loop;

  return new;
end;
$function$;

create or replace function public.link_pending_payment_recoveries_from_people()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_row jsonb := to_jsonb(new);
  v_company_id uuid;
  v_dropx_id text;
  v_match_count integer;
  v_target_type text;
  v_target_id uuid;
  v_workforce_id uuid;
  v_station_id uuid;
  v_name text;
  v_category text;
begin
  v_company_id := nullif(v_row->>'company_id', '')::uuid;
  v_dropx_id := case
    when tg_table_name = 'employees' then v_row->>'employee_code'
    else v_row->>'dropx_id'
  end;

  if tg_table_name not in ('employees', 'contractors', 'workforce')
    or v_company_id is null
    or public.normalize_people_dropx_id(v_dropx_id) is null
    or coalesce(nullif(v_row->>'is_active', '')::boolean, false) is not true
    or nullif(v_row->>'deleted_at', '') is not null
    or (
      tg_table_name = 'workforce'
      and coalesce(v_row->>'migration_state', 'canonical')
        in ('reclassified', 'moved_to_vendor')
    )
  then
    return new;
  end if;

  select resolved.match_count, resolved.target_type, resolved.target_id,
         resolved.workforce_id, resolved.station_id,
         resolved.person_name, resolved.category
    into v_match_count, v_target_type, v_target_id,
         v_workforce_id, v_station_id, v_name, v_category
  from public.resolve_payment_recovery_person(v_company_id, v_dropx_id) resolved;

  -- Ambiguous, inactive, deleted, reclassified, moved, and incomplete profiles
  -- remain pending instead of being linked to an arbitrary record.
  if v_match_count <> 1
    or v_target_id is null
    or v_station_id is null
    or not exists (
      select 1
      from public.stations station
      where station.company_id = v_company_id
        and station.id = v_station_id
        and station.is_active is true
    )
  then
    return new;
  end if;

  -- Serialize state transitions for cases that contain this identity. Without
  -- this row lock, two different registrations for the last pending IDs of one
  -- case can each observe the other allocation as pending.
  perform 1
  from public.payment_recovery_cases recovery
  where recovery.company_id = v_company_id
    and exists (
      select 1
      from public.payment_recovery_allocations allocation
      where allocation.company_id = recovery.company_id
        and allocation.recovery_case_id = recovery.id
        and allocation.link_status = 'pending'
        and public.normalize_people_dropx_id(allocation.imported_dropx_id)
          = public.normalize_people_dropx_id(v_dropx_id)
    )
  order by recovery.id
  for update;

  update public.payment_recovery_allocations allocation
  set target_type = v_target_type,
      target_id = v_target_id,
      workforce_id = v_workforce_id,
      station_id = v_station_id,
      person_name_snapshot = v_name,
      category_snapshot = v_category,
      link_status = 'linked',
      linked_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where allocation.company_id = v_company_id
    and allocation.link_status = 'pending'
    and public.normalize_people_dropx_id(allocation.imported_dropx_id)
      = public.normalize_people_dropx_id(v_dropx_id);

  update public.payment_recovery_cases recovery
  set status = 'ready_for_deduction', updated_at = clock_timestamp()
  where recovery.company_id = v_company_id
    and recovery.recovery_method = 'payout_deduction'
    and recovery.status = 'awaiting_registration'
    and not exists (
      select 1 from public.payment_recovery_allocations allocation
      where allocation.company_id = recovery.company_id
        and allocation.recovery_case_id = recovery.id
        and allocation.link_status = 'pending'
    );

  return new;
end;
$function$;

create trigger a00_payment_recovery_identity_mutex
before insert or update of company_id, employee_code, full_name, location_id, is_active, deleted_at
on public.employees
for each row execute function public.lock_payment_recovery_people_transition('employee_code');

create trigger employees_link_pending_payment_recoveries
after insert or update of company_id, employee_code, full_name, location_id, is_active, deleted_at on public.employees
for each row execute function public.link_pending_payment_recoveries_from_people();

create trigger a00_payment_recovery_identity_mutex
before insert or update of company_id, dropx_id, full_name, location_id, is_active, deleted_at
on public.contractors
for each row execute function public.lock_payment_recovery_people_transition('dropx_id');

create trigger contractors_link_pending_payment_recoveries
after insert or update of company_id, dropx_id, full_name, location_id, is_active, deleted_at on public.contractors
for each row execute function public.link_pending_payment_recoveries_from_people();

create trigger a00_payment_recovery_identity_mutex
before insert or update of company_id, dropx_id, full_name, location_id, is_active, deleted_at,
  migration_state, source_profile_type, source_profile_id
on public.workforce
for each row execute function public.lock_payment_recovery_people_transition('dropx_id');

create trigger workforce_link_pending_payment_recoveries
after insert or update of company_id, dropx_id, full_name, location_id, is_active, deleted_at,
  migration_state, source_profile_type, source_profile_id on public.workforce
for each row execute function public.link_pending_payment_recoveries_from_people();

comment on table public.payment_recovery_cases is
  'Provider-debited TID-level recovery cases. An upload plans either payout deduction or post-invoice provider dispute without performing either action.';
comment on table public.payment_recovery_allocations is
  'Equal paise-conserving allocation of one payout-recovery TID across one or more globally unique People IDs.';
comment on table public.payment_recovery_events is
  'Append-only recovery posting, provider credit, reversal, and manual recovery history.';
comment on function public.resolve_payment_recovery_person(uuid, text) is
  'Resolves one active logical People identity while collapsing its employee or contractor source row with its canonical Workforce mirror.';
comment on function public.payment_recovery_apply_import(uuid, text, text, jsonb, uuid, uuid[]) is
  'Atomically imports a TID-level payment recovery workbook once, blocks duplicate TIDs, and conserves every paise across equal allocations.';

alter table public.payment_recovery_import_batches enable row level security;
alter table public.payment_recovery_cases enable row level security;
alter table public.payment_recovery_allocations enable row level security;
alter table public.payment_recovery_events enable row level security;

revoke all on table public.payment_recovery_import_batches,
  public.payment_recovery_cases,
  public.payment_recovery_allocations,
  public.payment_recovery_events
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.payment_recovery_import_batches,
  public.payment_recovery_cases,
  public.payment_recovery_allocations,
  public.payment_recovery_events
  to service_role;

create policy payment_recovery_import_batches_service_role_all
  on public.payment_recovery_import_batches for all to service_role using (true) with check (true);
create policy payment_recovery_cases_service_role_all
  on public.payment_recovery_cases for all to service_role using (true) with check (true);
create policy payment_recovery_allocations_service_role_all
  on public.payment_recovery_allocations for all to service_role using (true) with check (true);
create policy payment_recovery_events_service_role_all
  on public.payment_recovery_events for all to service_role using (true) with check (true);

revoke all on function public.normalize_payment_recovery_tid(text),
  public.resolve_payment_recovery_person(uuid, text),
  public.payment_recovery_apply_import(uuid, text, text, jsonb, uuid, uuid[]),
  public.lock_payment_recovery_people_transition(),
  public.link_pending_payment_recoveries_from_people()
  from public, anon, authenticated, service_role;
grant execute on function public.normalize_payment_recovery_tid(text),
  public.payment_recovery_apply_import(uuid, text, text, jsonb, uuid, uuid[])
  to service_role;

insert into public.app_pages(company_id, code, name, sort_order, is_active, created_at, updated_at)
select company.id, 'payment_recoveries', 'Payment Recovery', 113, true, now(), now()
from public.companies company
on conflict (company_id, code) do update set
  name = excluded.name,
  sort_order = excluded.sort_order,
  is_active = true,
  updated_at = now();

-- Existing payout editors may view the new register, but add/edit permissions
-- remain explicit so a payout role does not automatically gain recovery-write access.
insert into public.role_page_permissions(
  company_id, role_id, page_id, can_view, can_add, can_edit
)
select permission.company_id, permission.role_id, target.id,
       permission.can_view or permission.can_add or permission.can_edit,
       false, false
from public.role_page_permissions permission
join public.app_pages source
  on source.company_id = permission.company_id
 and source.id = permission.page_id
 and source.code = 'workforce_payouts'
join public.app_pages target
  on target.company_id = permission.company_id
 and target.code = 'payment_recoveries'
on conflict (company_id, role_id, page_id) do update set
  can_view = public.role_page_permissions.can_view or excluded.can_view;

-- Owners receive full control immediately. Other roles retain a separate,
-- explicitly configurable Recovery permission.
insert into public.role_page_permissions(
  company_id, role_id, page_id, can_view, can_add, can_edit
)
select role.company_id, role.id, page.id, true, true, true
from public.user_roles role
join public.app_pages page
  on page.company_id = role.company_id
 and page.code = 'payment_recoveries'
where role.is_active
  and role.code in ('OWNER', 'WORKFORCE_OWNER')
on conflict (company_id, role_id, page_id) do update set
  can_view = true,
  can_add = true,
  can_edit = true;

notify pgrst, 'reload schema';

commit;
