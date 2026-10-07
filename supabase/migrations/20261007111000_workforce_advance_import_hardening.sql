begin;

-- Each bulk-imported advance gets a stable internal key. This blocks the same
-- payment when users save an equivalent workbook again and its file hash changes.
lock table public.workforce_advances in share row exclusive mode;

with candidates as (
  select
    advance.id,
    advance.company_id,
    'WAI1-' || md5(
      case
        when nullif(lower(regexp_replace(btrim(coalesce(advance.payment_reference, '')), '[[:space:]]+', ' ', 'g')), '') is not null
          then 'v1|' || advance.workforce_id::text || '|reference|'
            || lower(regexp_replace(btrim(advance.payment_reference), '[[:space:]]+', ' ', 'g'))
        else 'v1|' || advance.workforce_id::text || '|business|'
          || advance.advance_date::text || '|'
          || to_char(advance.amount, 'FM999999999999999990.00') || '|'
          || advance.payment_mode
      end
    ) as business_key
  from public.workforce_advances advance
  where advance.source_type = 'bulk_import'
), ranked as (
  select
    candidate.*,
    row_number() over (
      partition by candidate.company_id, candidate.business_key
      order by candidate.id
    ) as duplicate_rank,
    exists (
      select 1
      from public.workforce_advances existing
      where existing.company_id = candidate.company_id
        and existing.id <> candidate.id
        and lower(btrim(existing.external_reference)) = lower(candidate.business_key)
    ) as key_already_used
  from candidates candidate
)
update public.workforce_advances advance
set external_reference = case
  when ranked.duplicate_rank = 1 and not ranked.key_already_used then ranked.business_key
  else ranked.business_key || '-LEGACY-' || upper(substr(replace(advance.id::text, '-', ''), 1, 8))
end,
updated_at = clock_timestamp()
from ranked
where advance.id = ranked.id;

alter table public.workforce_advances
  add constraint workforce_advances_bulk_business_key_check check (
    source_type <> 'bulk_import'
    or external_reference ~ '^WAI1-[0-9a-f]{32}(-LEGACY-[0-9A-F]{8})?$'
  );

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
  v_advance_id uuid;
  v_advance_date date;
  v_amount numeric;
  v_deducted_amount numeric;
  v_payment_mode text;
  v_payment_reference text;
  v_normalized_reference text;
  v_business_key text;
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

  perform public.lock_workforce_payment_allocation_company(p_company_id);

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
    v_deducted_amount := coalesce(nullif(v_row->>'deducted_amount', '')::numeric, 0);
    v_payment_mode := coalesce(nullif(v_row->>'payment_mode', ''), 'other');
    v_payment_reference := nullif(btrim(v_row->>'payment_reference'), '');

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
    if v_advance_date is null
      or v_amount is null
      or v_amount::text in ('NaN', 'Infinity', '-Infinity')
      or v_amount <= 0
      or v_amount > 999999999999.99
      or v_amount <> round(v_amount, 2)
    then
      raise exception 'Row % requires a valid advance date and positive amount with at most two decimal places.', v_row_number;
    end if;
    if v_deducted_amount::text in ('NaN', 'Infinity', '-Infinity')
      or v_deducted_amount < 0
      or v_deducted_amount > v_amount
      or v_deducted_amount <> round(v_deducted_amount, 2)
    then
      raise exception 'Row % requires DEDUCTED_AMOUNT between zero and AMOUNT with at most two decimal places.', v_row_number;
    end if;
    if v_payment_mode not in ('bank_transfer', 'upi', 'cash', 'other') then
      raise exception 'Row % has an unsupported payment mode.', v_row_number;
    end if;

    v_normalized_reference := nullif(
      lower(regexp_replace(btrim(coalesce(v_payment_reference, '')), '[[:space:]]+', ' ', 'g')),
      ''
    );
    v_business_key := 'WAI1-' || md5(
      case
        when v_normalized_reference is not null
          then 'v1|' || v_workforce_id::text || '|reference|' || v_normalized_reference
        else 'v1|' || v_workforce_id::text || '|business|'
          || v_advance_date::text || '|'
          || to_char(v_amount, 'FM999999999999999990.00') || '|'
          || v_payment_mode
      end
    );

    if exists (
      select 1
      from public.workforce_advances existing
      where existing.company_id = p_company_id
        and lower(btrim(existing.external_reference)) = lower(v_business_key)
    ) then
      raise exception 'Row % duplicates an advance already in the register.', v_row_number;
    end if;

    insert into public.workforce_advances(
      company_id, workforce_id, station_id, advance_number, advance_date,
      amount, payment_mode, payment_reference, external_reference, remark,
      source_type, source_batch_id, source_row_number, created_by, updated_by
    ) values (
      p_company_id, v_workforce_id, v_station_id,
      'WA-' || to_char(v_advance_date, 'YYYYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
      v_advance_date, v_amount, v_payment_mode,
      v_payment_reference, v_business_key,
      nullif(v_row->>'remark', ''), 'bulk_import', v_batch_id, v_row_number,
      p_actor_user_id, p_actor_user_id
    )
    returning id into v_advance_id;

    if v_deducted_amount > 0 then
      insert into public.workforce_advance_recoveries(
        company_id, advance_id, workforce_id, station_id,
        period_start, period_end, amount, recovery_type, status,
        deduction_value_id, idempotency_key, created_by
      ) values (
        p_company_id, v_advance_id, v_workforce_id, v_station_id,
        v_advance_date, v_advance_date, v_deducted_amount, 'opening_balance', 'deducted',
        null, 'opening-balance:' || v_advance_id::text, p_actor_user_id
      );
    end if;
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
    raise exception 'An imported advance already exists in the register.' using errcode = '23505';
end;
$function$;

comment on function public.workforce_apply_advance_import(uuid, text, text, jsonb, uuid, uuid[]) is
  'Atomically imports historical Workforce advances, opening deducted balances and stable row-level duplicate keys.';

revoke all on function public.workforce_apply_advance_import(uuid, text, text, jsonb, uuid, uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.workforce_apply_advance_import(uuid, text, text, jsonb, uuid, uuid[])
  to service_role;

notify pgrst, 'reload schema';

commit;
