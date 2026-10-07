begin;

-- Advance workbooks can arrive before the referenced DropX identity has a
-- canonical Workforce profile. Keep those rows in the register without
-- inventing a profile or location, then link them in the Workforce profile's
-- registration transaction once that identity becomes canonical.
alter table public.workforce_advances
  add column imported_dropx_id text,
  add column link_status text not null default 'linked',
  add column opening_deducted_amount numeric(18,2) not null default 0,
  add column linked_at timestamptz;

-- The old trigger validates every UPDATE against the member's current station.
-- Historical advances intentionally retain the station where they were paid,
-- so suspend this one trigger while metadata is backfilled under the table's
-- migration lock and restore its pending-aware replacement below.
drop trigger if exists workforce_advances_00_prepare on public.workforce_advances;

update public.workforce_advances advance
set imported_dropx_id = case
      when public.normalize_people_dropx_id(workforce.dropx_id) is not null
        then workforce.dropx_id
      else advance.workforce_id::text
    end,
    link_status = 'linked',
    linked_at = coalesce(advance.linked_at, advance.created_at)
from public.workforce workforce
where workforce.company_id = advance.company_id
  and workforce.id = advance.workforce_id;

update public.workforce_advances advance
set imported_dropx_id = case
      when public.normalize_people_dropx_id(advance.imported_dropx_id) is not null
        then advance.imported_dropx_id
      else advance.workforce_id::text
    end,
    linked_at = coalesce(advance.linked_at, advance.created_at)
where advance.imported_dropx_id is null
   or public.normalize_people_dropx_id(advance.imported_dropx_id) is null
   or advance.linked_at is null;

update public.workforce_advances advance
set opening_deducted_amount = coalesce((
  select sum(recovery.amount)
  from public.workforce_advance_recoveries recovery
  where recovery.company_id = advance.company_id
    and recovery.advance_id = advance.id
    and recovery.recovery_type = 'opening_balance'
    and recovery.status = 'deducted'
), 0);

alter table public.workforce_advances
  alter column imported_dropx_id set not null,
  alter column workforce_id drop not null,
  alter column station_id drop not null,
  add constraint workforce_advances_link_status_check
    check (link_status in ('pending', 'linked')),
  add constraint workforce_advances_imported_dropx_id_check
    check (public.normalize_people_dropx_id(imported_dropx_id) is not null),
  add constraint workforce_advances_opening_deducted_amount_check
    check (
      opening_deducted_amount >= 0
      and opening_deducted_amount <= amount
    ),
  add constraint workforce_advances_link_shape_check
    check (
      (
        link_status = 'pending'
        and workforce_id is null
        and station_id is null
        and source_type = 'bulk_import'
        and linked_at is null
      )
      or
      (
        link_status = 'linked'
        and workforce_id is not null
        and station_id is not null
        and linked_at is not null
      )
    );

alter table public.workforce_advances
  drop constraint workforce_advances_bulk_business_key_check,
  add constraint workforce_advances_bulk_business_key_check check (
    source_type <> 'bulk_import'
    or external_reference ~ '^WAI1-[0-9a-f]{32}(-LEGACY-[0-9A-F]{8})?$'
    or external_reference ~ '^WAI2-[0-9a-f]{32}$'
  );

create index workforce_advances_company_link_status_date_idx
  on public.workforce_advances(company_id, link_status, advance_date desc, id);
create index workforce_advances_pending_dropx_id_idx
  on public.workforce_advances(
    company_id,
    public.normalize_people_dropx_id(imported_dropx_id),
    id
  )
  where link_status = 'pending';

create or replace function public.workforce_advance_import_business_key(
  p_dropx_id text,
  p_advance_date date,
  p_amount numeric,
  p_payment_mode text,
  p_payment_reference text
)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $function$
  select 'WAI2-' || pg_catalog.md5(
    case
      when nullif(
        pg_catalog.lower(
          pg_catalog.regexp_replace(
            pg_catalog.btrim(coalesce(p_payment_reference, '')),
            '[[:space:]]+',
            ' ',
            'g'
          )
        ),
        ''
      ) is not null
        then 'v2|' || public.normalize_people_dropx_id(p_dropx_id)
          || '|reference|'
          || pg_catalog.lower(
            pg_catalog.regexp_replace(
              pg_catalog.btrim(p_payment_reference),
              '[[:space:]]+',
              ' ',
              'g'
            )
          )
      else 'v2|' || public.normalize_people_dropx_id(p_dropx_id)
        || '|business|' || p_advance_date::text
        || '|' || pg_catalog.to_char(p_amount, 'FM999999999999999990.00')
        || '|' || p_payment_mode
    end
  )
$function$;

create or replace function public.prepare_workforce_advance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_recovered numeric(18,2);
  v_workforce public.workforce%rowtype;
begin
  if new.advance_number is null or pg_catalog.btrim(new.advance_number) = '' then
    new.advance_number := 'WA-' || pg_catalog.to_char(new.advance_date, 'YYYYMMDD')
      || '-' || pg_catalog.upper(pg_catalog.substr(pg_catalog.replace(new.id::text, '-', ''), 1, 8));
  else
    new.advance_number := pg_catalog.upper(pg_catalog.btrim(new.advance_number));
  end if;
  new.payment_reference := nullif(pg_catalog.btrim(new.payment_reference), '');
  new.external_reference := nullif(pg_catalog.btrim(new.external_reference), '');
  new.remark := nullif(pg_catalog.btrim(new.remark), '');
  new.link_status := coalesce(nullif(new.link_status, ''), 'linked');

  if new.source_type = 'manual'
    and coalesce(new.external_reference, '') ~* '^WAI[12]-'
  then
    raise exception 'WAI1 and WAI2 references are reserved for Workforce advance imports.';
  end if;
  if new.source_type = 'bulk_import'
    and (
      tg_op = 'INSERT'
      or new.external_reference is distinct from old.external_reference
    )
    and coalesce(new.external_reference, '') !~* '^WAI2-[0-9a-f]{32}$'
  then
    raise exception 'A bulk-imported Workforce advance requires its database-generated WAI2 key.';
  end if;

  if new.link_status = 'pending' then
    if tg_op = 'UPDATE' and old.link_status = 'linked' then
      raise exception 'A linked Workforce advance cannot be returned to pending identity status.';
    end if;
    if new.source_type <> 'bulk_import'
      or new.workforce_id is not null
      or new.station_id is not null
      or new.linked_at is not null
    then
      raise exception 'A pending Workforce advance must be a locationless bulk-import row.';
    end if;
    if public.normalize_people_dropx_id(new.imported_dropx_id) is null
      or pg_catalog.char_length(new.imported_dropx_id) > 80
    then
      raise exception 'A pending Workforce advance requires its original DropX ID.';
    end if;
  elsif new.link_status = 'linked' then
    if new.workforce_id is null or new.station_id is null then
      raise exception 'A linked Workforce advance requires a canonical Workforce member and location.';
    end if;

    select workforce.*
    into v_workforce
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

    if public.normalize_people_dropx_id(new.imported_dropx_id) is null then
      new.imported_dropx_id := coalesce(
        nullif(v_workforce.dropx_id, ''),
        new.workforce_id::text
      );
    elsif public.normalize_people_dropx_id(v_workforce.dropx_id) is not null
      and public.normalize_people_dropx_id(new.imported_dropx_id)
        <> public.normalize_people_dropx_id(v_workforce.dropx_id)
    then
      raise exception 'Imported DropX ID does not match the canonical Workforce member.';
    end if;
    new.linked_at := coalesce(new.linked_at, pg_catalog.clock_timestamp());
  else
    raise exception 'Unsupported Workforce advance identity-link status.';
  end if;

  if new.opening_deducted_amount is null
    or new.opening_deducted_amount < 0
    or new.opening_deducted_amount > new.amount
  then
    raise exception 'Opening deducted amount must be between zero and the advance amount.';
  end if;
  if tg_op = 'UPDATE'
    and new.opening_deducted_amount is distinct from old.opening_deducted_amount
  then
    raise exception 'Opening deducted amount is immutable after an advance is imported.';
  end if;

  if tg_op = 'UPDATE' and new.amount is distinct from old.amount then
    select coalesce(sum(recovery.amount) filter (where recovery.status = 'deducted'), 0)
    into v_recovered
    from public.workforce_advance_recoveries recovery
    where recovery.company_id = old.company_id
      and recovery.advance_id = old.id;
    if new.amount < greatest(v_recovered, new.opening_deducted_amount) then
      raise exception 'Advance amount cannot be lower than the amount already deducted.';
    end if;
  end if;

  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$function$;

create or replace function public.materialize_workforce_advance_opening_recovery()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_existing public.workforce_advance_recoveries%rowtype;
begin
  if new.link_status <> 'linked' or new.opening_deducted_amount <= 0 then
    return new;
  end if;

  select recovery.*
  into v_existing
  from public.workforce_advance_recoveries recovery
  where recovery.company_id = new.company_id
    and recovery.advance_id = new.id
    and recovery.recovery_type = 'opening_balance'
  order by recovery.created_at, recovery.id
  limit 1
  for update;

  if found then
    if v_existing.status <> 'deducted'
      or v_existing.amount <> new.opening_deducted_amount
      or v_existing.workforce_id <> new.workforce_id
      or v_existing.station_id <> new.station_id
    then
      raise exception 'The stored opening deduction conflicts with its recovery history.';
    end if;
    return new;
  end if;

  insert into public.workforce_advance_recoveries(
    company_id, advance_id, workforce_id, station_id,
    period_start, period_end, amount, recovery_type, status,
    deduction_value_id, idempotency_key, created_by
  ) values (
    new.company_id, new.id, new.workforce_id, new.station_id,
    new.advance_date, new.advance_date, new.opening_deducted_amount,
    'opening_balance', 'deducted', null,
    'opening-balance:' || new.id::text, new.created_by
  );

  return new;
end;
$function$;

create trigger workforce_advances_00_prepare
before insert or update on public.workforce_advances
for each row execute function public.prepare_workforce_advance();

drop trigger if exists workforce_advances_10_materialize_opening_recovery
  on public.workforce_advances;
create trigger workforce_advances_10_materialize_opening_recovery
after insert or update of link_status, workforce_id, station_id, opening_deducted_amount
on public.workforce_advances
for each row execute function public.materialize_workforce_advance_opening_recovery();

create or replace function public.lock_workforce_advance_identity_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform public.lock_workforce_payment_allocation_company(new.company_id);
  return new;
end;
$function$;

drop trigger if exists workforce_00_advance_identity_mutex on public.workforce;
create trigger workforce_00_advance_identity_mutex
before insert or update of company_id, dropx_id, location_id, deleted_at, migration_state
on public.workforce
for each row execute function public.lock_workforce_advance_identity_transition();

create or replace function public.link_pending_workforce_advances_from_workforce()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_advance record;
  v_normalized_dropx_id text;
begin
  v_normalized_dropx_id := public.normalize_people_dropx_id(new.dropx_id);
  if v_normalized_dropx_id is null
    or new.location_id is null
    or new.deleted_at is not null
    or new.migration_state is not distinct from 'reclassified'
  then
    return new;
  end if;

  perform public.lock_workforce_payment_allocation_company(new.company_id);

  for v_advance in
    select advance.id
    from public.workforce_advances advance
    where advance.company_id = new.company_id
      and advance.link_status = 'pending'
      and public.normalize_people_dropx_id(advance.imported_dropx_id) = v_normalized_dropx_id
    order by advance.id
    for update
  loop
    update public.workforce_advances advance
    set workforce_id = new.id,
        station_id = new.location_id,
        link_status = 'linked',
        linked_at = pg_catalog.clock_timestamp()
    where advance.company_id = new.company_id
      and advance.id = v_advance.id
      and advance.link_status = 'pending';
  end loop;

  return new;
end;
$function$;

drop trigger if exists workforce_advance_pending_identity_link on public.workforce;
create trigger workforce_advance_pending_identity_link
after insert or update of company_id, dropx_id, location_id, deleted_at, migration_state
on public.workforce
for each row execute function public.link_pending_workforce_advances_from_workforce();

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
  v_supplied_workforce_id uuid;
  v_supplied_station_id uuid;
  v_workforce public.workforce%rowtype;
  v_has_workforce boolean;
  v_imported_dropx_id text;
  v_normalized_dropx_id text;
  v_advance_date date;
  v_amount numeric;
  v_deducted_amount numeric;
  v_payment_mode text;
  v_payment_reference text;
  v_normalized_reference text;
  v_business_key text;
  v_lock_key text;
begin
  if p_company_id is null or p_actor_user_id is null then
    raise exception 'Company and actor are required.';
  end if;
  if p_file_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'A valid workbook fingerprint is required.';
  end if;
  if pg_catalog.jsonb_typeof(p_rows) <> 'array'
    or pg_catalog.jsonb_array_length(p_rows) = 0
  then
    raise exception 'At least one advance row is required.';
  end if;
  if pg_catalog.jsonb_array_length(p_rows) > 10000 then
    raise exception 'Import at most 10000 advances at a time.';
  end if;

  -- Existing Workforce rows are locked before the company mutex. The matching
  -- BEFORE trigger takes the same mutex for newly registered identities, so a
  -- concurrent registration either becomes visible here or links the pending
  -- row in its own transaction.
  perform 1
  from public.workforce workforce
  where workforce.company_id = p_company_id
    and (
      workforce.id in (
        select distinct nullif(requested.item->>'workforce_id', '')::uuid
        from pg_catalog.jsonb_array_elements(p_rows) as requested(item)
        where nullif(requested.item->>'workforce_id', '') is not null
      )
      or public.normalize_people_dropx_id(workforce.dropx_id) in (
        select distinct public.normalize_people_dropx_id(requested.item->>'dropx_id')
        from pg_catalog.jsonb_array_elements(p_rows) as requested(item)
        where public.normalize_people_dropx_id(requested.item->>'dropx_id') is not null
      )
    )
  order by workforce.id
  for update;

  -- Use the exact identity mutex taken by enforce_people_identity_uniqueness().
  -- Sorting makes multi-row workbooks compatible with profile transactions that
  -- claim DropX and biometric IDs in deterministic order.
  for v_lock_key in
    select distinct lock_key
    from (
      select p_company_id::text || ':dropx:'
        || public.normalize_people_dropx_id(requested.item->>'dropx_id') as lock_key
      from pg_catalog.jsonb_array_elements(p_rows) as requested(item)
      where public.normalize_people_dropx_id(requested.item->>'dropx_id') is not null
      union
      select p_company_id::text || ':dropx:'
        || public.normalize_people_dropx_id(workforce.dropx_id)
      from public.workforce workforce
      where workforce.company_id = p_company_id
        and workforce.id in (
          select distinct nullif(requested.item->>'workforce_id', '')::uuid
          from pg_catalog.jsonb_array_elements(p_rows) as requested(item)
          where nullif(requested.item->>'workforce_id', '') is not null
        )
        and public.normalize_people_dropx_id(workforce.dropx_id) is not null
    ) requested_locks
    where lock_key is not null
    order by lock_key
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_lock_key, 0)
    );
  end loop;

  perform public.lock_workforce_payment_allocation_company(p_company_id);

  select batch.id
  into v_batch_id
  from public.workforce_advance_import_batches batch
  where batch.company_id = p_company_id
    and batch.file_sha256 = p_file_sha256;
  if found then
    return v_batch_id;
  end if;

  insert into public.workforce_advance_import_batches(
    company_id, file_name, file_sha256, row_count, created_by
  ) values (
    p_company_id,
    pg_catalog.left(
      coalesce(nullif(pg_catalog.btrim(p_file_name), ''), 'workforce-advances.xlsx'),
      240
    ),
    p_file_sha256,
    pg_catalog.jsonb_array_length(p_rows),
    p_actor_user_id
  ) returning id into v_batch_id;

  for v_row in select value from pg_catalog.jsonb_array_elements(p_rows)
  loop
    v_row_number := nullif(v_row->>'row_number', '')::integer;
    v_supplied_workforce_id := nullif(v_row->>'workforce_id', '')::uuid;
    v_supplied_station_id := nullif(v_row->>'station_id', '')::uuid;
    v_imported_dropx_id := nullif(v_row->>'dropx_id', '');
    v_advance_date := nullif(v_row->>'advance_date', '')::date;
    v_amount := nullif(v_row->>'amount', '')::numeric;
    v_deducted_amount := coalesce(nullif(v_row->>'deducted_amount', '')::numeric, 0);
    v_payment_mode := coalesce(nullif(v_row->>'payment_mode', ''), 'other');
    v_payment_reference := nullif(pg_catalog.btrim(v_row->>'payment_reference'), '');
    v_has_workforce := false;

    if v_row_number is null or v_row_number < 2 then
      raise exception 'Every imported row requires its Excel row number.';
    end if;
    if v_advance_date is null
      or v_amount is null
      or v_amount::text in ('NaN', 'Infinity', '-Infinity')
      or v_amount <= 0
      or v_amount > 999999999999.99
      or v_amount <> pg_catalog.round(v_amount, 2)
    then
      raise exception 'Row % requires a valid advance date and positive amount with at most two decimal places.', v_row_number;
    end if;
    if v_deducted_amount::text in ('NaN', 'Infinity', '-Infinity')
      or v_deducted_amount < 0
      or v_deducted_amount > v_amount
      or v_deducted_amount <> pg_catalog.round(v_deducted_amount, 2)
    then
      raise exception 'Row % requires DEDUCTED_AMOUNT between zero and AMOUNT with at most two decimal places.', v_row_number;
    end if;
    if v_payment_mode not in ('bank_transfer', 'upi', 'cash', 'other') then
      raise exception 'Row % has an unsupported payment mode.', v_row_number;
    end if;

    v_normalized_dropx_id := public.normalize_people_dropx_id(v_imported_dropx_id);
    if v_normalized_dropx_id is null then
      -- Rollout compatibility: the previously deployed route supplied only the
      -- canonical UUID and station. Derive the retained ID for those requests.
      if v_supplied_workforce_id is null then
        raise exception 'Row % requires a DropX ID.', v_row_number;
      end if;
      select workforce.*
      into v_workforce
      from public.workforce workforce
      where workforce.company_id = p_company_id
        and workforce.id = v_supplied_workforce_id
        and workforce.deleted_at is null
        and workforce.migration_state is distinct from 'reclassified'
      for update;
      v_has_workforce := found;
      if not v_has_workforce then
        raise exception 'Row % does not identify a canonical Workforce member at its current location.', v_row_number;
      end if;
      v_imported_dropx_id := coalesce(nullif(v_workforce.dropx_id, ''), v_workforce.id::text);
      v_normalized_dropx_id := public.normalize_people_dropx_id(v_imported_dropx_id);
    else
      if pg_catalog.char_length(v_imported_dropx_id) > 80 then
        raise exception 'Row % DropX ID cannot exceed 80 characters.', v_row_number;
      end if;
      select workforce.*
      into v_workforce
      from public.workforce workforce
      where workforce.company_id = p_company_id
        and public.normalize_people_dropx_id(workforce.dropx_id) = v_normalized_dropx_id
        and workforce.deleted_at is null
        and workforce.migration_state is distinct from 'reclassified'
      order by workforce.id
      limit 1
      for update;
      v_has_workforce := found;

      if v_has_workforce and exists (
        select 1
        from public.workforce duplicate
        where duplicate.company_id = p_company_id
          and public.normalize_people_dropx_id(duplicate.dropx_id) = v_normalized_dropx_id
          and duplicate.deleted_at is null
          and duplicate.migration_state is distinct from 'reclassified'
          and duplicate.id <> v_workforce.id
      ) then
        raise exception 'Row % matches more than one canonical Workforce member.', v_row_number;
      end if;
      if v_supplied_workforce_id is not null
        and (not v_has_workforce or v_supplied_workforce_id <> v_workforce.id)
      then
        raise exception 'Row % supplied Workforce identity does not match its DropX ID.', v_row_number;
      end if;
    end if;

    if v_has_workforce then
      if p_allowed_location_ids is not null
        and v_supplied_station_id is not null
        and not (v_supplied_station_id = any(p_allowed_location_ids))
      then
        raise exception 'Row % is outside the importing user''s location scope.', v_row_number;
      end if;
      if v_workforce.location_id is null
        or not exists (
          select 1
          from public.stations station
          where station.company_id = p_company_id
            and station.id = v_workforce.location_id
        )
        or (
          v_supplied_station_id is not null
          and v_supplied_station_id <> v_workforce.location_id
        )
      then
        raise exception 'Row % does not identify a canonical Workforce member at its current location.', v_row_number;
      end if;
      if p_allowed_location_ids is not null
        and not (v_workforce.location_id = any(p_allowed_location_ids))
      then
        raise exception 'Row % is outside the importing user''s location scope.', v_row_number;
      end if;
    else
      if v_supplied_workforce_id is not null or v_supplied_station_id is not null then
        raise exception 'Row % supplied canonical identity fields for an unregistered DropX ID.', v_row_number;
      end if;
      if p_allowed_location_ids is not null then
        raise exception 'Row % is unregistered and cannot be imported without all-location access.', v_row_number;
      end if;
    end if;

    v_normalized_reference := nullif(
      pg_catalog.lower(
        pg_catalog.regexp_replace(
          pg_catalog.btrim(coalesce(v_payment_reference, '')),
          '[[:space:]]+',
          ' ',
          'g'
        )
      ),
      ''
    );
    v_business_key := public.workforce_advance_import_business_key(
      v_imported_dropx_id,
      v_advance_date,
      v_amount,
      v_payment_mode,
      v_payment_reference
    );

    if exists (
      select 1
      from public.workforce_advances existing
      where existing.company_id = p_company_id
        and public.normalize_people_dropx_id(existing.imported_dropx_id) = v_normalized_dropx_id
        and (
          (
            v_normalized_reference is not null
            and nullif(
              pg_catalog.lower(
                pg_catalog.regexp_replace(
                  pg_catalog.btrim(coalesce(existing.payment_reference, '')),
                  '[[:space:]]+',
                  ' ',
                  'g'
                )
              ),
              ''
            ) = v_normalized_reference
          )
          or
          (
            v_normalized_reference is null
            and nullif(pg_catalog.btrim(coalesce(existing.payment_reference, '')), '') is null
            and existing.advance_date = v_advance_date
            and existing.amount = v_amount
            and existing.payment_mode = v_payment_mode
          )
          or pg_catalog.lower(pg_catalog.btrim(existing.external_reference))
            = pg_catalog.lower(v_business_key)
        )
    ) then
      raise exception 'Row % duplicates an advance already in the register.', v_row_number;
    end if;

    insert into public.workforce_advances(
      company_id, workforce_id, station_id, imported_dropx_id, link_status,
      opening_deducted_amount, linked_at,
      advance_number, advance_date, amount, payment_mode, payment_reference,
      external_reference, remark, source_type, source_batch_id,
      source_row_number, created_by, updated_by
    ) values (
      p_company_id,
      case when v_has_workforce then v_workforce.id else null end,
      case when v_has_workforce then v_workforce.location_id else null end,
      v_imported_dropx_id,
      case when v_has_workforce then 'linked' else 'pending' end,
      v_deducted_amount,
      case when v_has_workforce then pg_catalog.clock_timestamp() else null end,
      'WA-' || pg_catalog.to_char(v_advance_date, 'YYYYMMDD') || '-'
        || pg_catalog.upper(pg_catalog.substr(pg_catalog.replace(gen_random_uuid()::text, '-', ''), 1, 8)),
      v_advance_date,
      v_amount,
      v_payment_mode,
      v_payment_reference,
      v_business_key,
      nullif(v_row->>'remark', ''),
      'bulk_import',
      v_batch_id,
      v_row_number,
      p_actor_user_id,
      p_actor_user_id
    );
  end loop;

  return v_batch_id;
exception
  when unique_violation then
    if v_batch_id is not null then
      select batch.id
      into v_batch_id
      from public.workforce_advance_import_batches batch
      where batch.company_id = p_company_id
        and batch.file_sha256 = p_file_sha256;
      if found then
        return v_batch_id;
      end if;
    end if;
    raise exception 'An imported advance already exists in the register.' using errcode = '23505';
end;
$function$;

comment on column public.workforce_advances.imported_dropx_id is
  'Exact DropX ID supplied by the advance workbook, retained before and after canonical Workforce linking.';
comment on column public.workforce_advances.link_status is
  'pending while an imported DropX ID has no canonical Workforce profile; linked once identity and current location are resolved.';
comment on column public.workforce_advances.opening_deducted_amount is
  'Opening amount already recovered in the source workbook; materialized into recovery history when the identity is linked.';
comment on function public.workforce_advance_import_business_key(text, date, numeric, text, text) is
  'Builds a stable WAI2 duplicate key from normalized DropX identity and payment details, independent of future Workforce UUID assignment.';
comment on function public.link_pending_workforce_advances_from_workforce() is
  'Transactionally links locationless advance imports and materializes their opening deductions when a matching canonical Workforce profile becomes usable.';
comment on function public.workforce_apply_advance_import(uuid, text, text, jsonb, uuid, uuid[]) is
  'Atomically imports matched advances or all-location pending DropX identities, retaining opening deductions and stable identity-based duplicate keys.';

revoke all on function public.workforce_advance_import_business_key(text, date, numeric, text, text),
  public.materialize_workforce_advance_opening_recovery(),
  public.lock_workforce_advance_identity_transition(),
  public.link_pending_workforce_advances_from_workforce()
from public, anon, authenticated, service_role;

revoke all on function public.workforce_apply_advance_import(uuid, text, text, jsonb, uuid, uuid[])
from public, anon, authenticated;
grant execute on function public.workforce_apply_advance_import(uuid, text, text, jsonb, uuid, uuid[])
to service_role;

notify pgrst, 'reload schema';

commit;
