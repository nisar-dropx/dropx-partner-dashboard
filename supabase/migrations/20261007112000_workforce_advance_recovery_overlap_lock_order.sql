begin;

-- Final advance-recovery safety pass:
-- * keep all active opening balances in every pending-balance calculation;
-- * reject non-exact inclusive payout-period overlap;
-- * preserve exact-period retry/recalculation and historical audit semantics;
-- * keep Workforce row and company advisory locks in one deterministic order.

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

  -- Match the recovery and finalized-input lock order: lock every requested
  -- Workforce row in deterministic order before taking the company mutex.
  -- Canonical location/scope validation still runs below while both locks hold.
  perform 1
  from public.workforce workforce
  where workforce.company_id = p_company_id
    and workforce.id in (
      select distinct nullif(requested.item->>'workforce_id', '')::uuid
      from jsonb_array_elements(p_rows) as requested(item)
      where nullif(requested.item->>'workforce_id', '') is not null
    )
  order by workforce.id
  for update;

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
  v_recovered numeric(18,2);
  v_deduction_value_id uuid;
  v_existing_deduction_id uuid;
  v_existing_source text;
  v_existing_amount numeric(18,2);
  v_existing_station_id uuid;
  v_expected_snapshot_hash text;
  v_current_snapshot_hash text;
  v_existing_plan jsonb;
  v_desired_plan jsonb;
  v_plan_item jsonb;
  v_plan_is_identical boolean;
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

  -- This lock is also acquired by every dependency and advance-state trigger.
  -- It closes the interval between revision validation and transaction commit.
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

    v_existing_deduction_id := null;
    v_existing_source := null;
    v_existing_amount := null;
    v_existing_station_id := null;
    select value.id, value.source_type, value.amount, value.station_id
      into v_existing_deduction_id, v_existing_source, v_existing_amount, v_existing_station_id
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

    perform 1
    from public.workforce_advances advance
    where advance.company_id = p_company_id
      and advance.workforce_id = v_workforce_id
      and advance.advance_date <= p_period_end
    order by advance.advance_date, advance.created_at, advance.id
    for update;

    perform 1
    from public.workforce_advance_recoveries recovery
    where recovery.company_id = p_company_id
      and recovery.workforce_id = v_workforce_id
      and recovery.status = 'deducted'
    order by recovery.period_start, recovery.period_end, recovery.id
    for update;

    if exists (
      select 1
      from public.workforce_advance_recoveries recovery
      where recovery.company_id = p_company_id
        and recovery.workforce_id = v_workforce_id
        and recovery.recovery_type = 'payout'
        and recovery.status = 'deducted'
        and daterange(recovery.period_start, recovery.period_end, '[]')
          && daterange(p_period_start, p_period_end, '[]')
        and (recovery.period_start, recovery.period_end)
          <> (p_period_start, p_period_end)
    ) then
      raise exception 'An overlapping ADVANCE deduction already exists for this Workforce member. Use the exact same payout period or choose a non-overlapping period.';
    end if;

    -- Reconstruct this period from balances as they stood immediately before
    -- it. Opening balances always reduce the advance. Strictly earlier payout
    -- recoveries reduce it too; the exact period is excluded for safe retry or
    -- recalculation, and later disjoint periods are handled after no-op detection.
    with fifo as (
      select
        advance.id,
        advance.advance_date,
        advance.created_at,
        greatest(
          advance.amount - coalesce(sum(recovery.amount) filter (
            where recovery.status = 'deducted'
              and (
                recovery.recovery_type = 'opening_balance'
                or (
                  recovery.recovery_type = 'payout'
                  and recovery.period_end < p_period_start
                )
              )
          ), 0),
          0
        )::numeric(18,2) as pending_amount
      from public.workforce_advances advance
      left join public.workforce_advance_recoveries recovery
        on recovery.company_id = advance.company_id
       and recovery.advance_id = advance.id
      where advance.company_id = p_company_id
        and advance.workforce_id = v_workforce_id
        and advance.advance_date <= p_period_end
      group by advance.id, advance.advance_date, advance.created_at, advance.amount
    ), planned as (
      select
        fifo.*,
        least(
          fifo.pending_amount,
          greatest(
            v_max_amount - coalesce(sum(fifo.pending_amount) over (
              order by fifo.advance_date, fifo.created_at, fifo.id
              rows between unbounded preceding and 1 preceding
            ), 0),
            0
          )
        )::numeric(18,2) as recovery_amount
      from fifo
    )
    select
      coalesce(jsonb_agg(
        jsonb_build_object(
          'advance_id', planned.id::text,
          'amount', planned.recovery_amount
        ) order by planned.advance_date, planned.created_at, planned.id
      ) filter (where planned.recovery_amount > 0), '[]'::jsonb),
      coalesce(sum(planned.recovery_amount) filter (where planned.recovery_amount > 0), 0)::numeric(18,2)
      into v_desired_plan, v_recovered
    from planned;

    select coalesce(jsonb_agg(
      jsonb_build_object(
        'advance_id', recovery.advance_id::text,
        'amount', recovery.amount
      ) order by advance.advance_date, advance.created_at, advance.id, recovery.id
    ), '[]'::jsonb)
      into v_existing_plan
    from public.workforce_advance_recoveries recovery
    join public.workforce_advances advance
      on advance.company_id = recovery.company_id
     and advance.id = recovery.advance_id
    where recovery.company_id = p_company_id
      and recovery.workforce_id = v_workforce_id
      and recovery.recovery_type = 'payout'
      and recovery.period_start = p_period_start
      and recovery.period_end = p_period_end
      and recovery.status = 'deducted';

    v_plan_is_identical := v_existing_plan = v_desired_plan
      and (
        (
          v_recovered > 0
          and v_existing_deduction_id is not null
          and v_existing_source = 'advance_register'
          and v_existing_amount = v_recovered
          and v_existing_station_id = v_station_id
          and not exists (
            select 1
            from public.workforce_advance_recoveries recovery
            where recovery.company_id = p_company_id
              and recovery.workforce_id = v_workforce_id
              and recovery.recovery_type = 'payout'
              and recovery.period_start = p_period_start
              and recovery.period_end = p_period_end
              and recovery.status = 'deducted'
              and (
                recovery.station_id is distinct from v_station_id
                or recovery.deduction_value_id is distinct from v_existing_deduction_id
              )
          )
        )
        or (
          v_recovered = 0
          and v_existing_deduction_id is null
          and v_existing_plan = '[]'::jsonb
        )
      );

    if v_plan_is_identical then
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'workforce_id', v_workforce_id,
        'station_id', v_station_id,
        'deducted', v_recovered
      ));
      continue;
    end if;

    if exists (
      select 1
      from public.workforce_advance_recoveries recovery
      where recovery.company_id = p_company_id
        and recovery.workforce_id = v_workforce_id
        and recovery.recovery_type = 'payout'
        and recovery.status = 'deducted'
        and recovery.period_start > p_period_end
    ) then
      raise exception 'Later ADVANCE deductions already exist for this Workforce member. Reverse the later payout deductions before recalculating this earlier period.';
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

    for v_plan_item in select value from jsonb_array_elements(v_desired_plan)
    loop
      insert into public.workforce_advance_recoveries(
        company_id, advance_id, workforce_id, station_id,
        period_start, period_end, amount, recovery_type, status,
        idempotency_key, created_by
      ) values (
        p_company_id, (v_plan_item->>'advance_id')::uuid, v_workforce_id, v_station_id,
        p_period_start, p_period_end, (v_plan_item->>'amount')::numeric, 'payout', 'deducted',
        (v_plan_item->>'advance_id') || ':' || p_period_start::text || ':' || p_period_end::text,
        p_actor_user_id
      );
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

  -- Own ADVANCE/recovery writes are version-neutral.  Any cap-affecting write
  -- must bump under this same lock, so a mismatch here aborts the transaction.
  v_current_snapshot_hash := public.workforce_advance_recovery_snapshot_hash(
    p_company_id,
    p_period_start,
    p_period_end
  );
  if v_current_snapshot_hash is distinct from v_expected_snapshot_hash then
    raise exception 'Payout inputs changed while advances were being applied. No deductions were saved; refresh the page and try again.';
  end if;

  return v_results;
end;
$function$;

comment on function public.workforce_apply_advance_import(uuid, text, text, jsonb, uuid, uuid[]) is
  'Atomically imports historical Workforce advances after deterministic Workforce-row and company locking.';
comment on function public.workforce_apply_advance_recoveries(uuid, uuid, date, date, jsonb, uuid[]) is
  'Applies FIFO advance deductions without double-recovering opening balances or overlapping payout periods.';

revoke all on function public.workforce_apply_advance_import(uuid, text, text, jsonb, uuid, uuid[]),
  public.workforce_apply_advance_recoveries(uuid, uuid, date, date, jsonb, uuid[])
from public, anon, authenticated, service_role;
grant execute on function public.workforce_apply_advance_import(uuid, text, text, jsonb, uuid, uuid[]),
  public.workforce_apply_advance_recoveries(uuid, uuid, date, date, jsonb, uuid[])
to service_role;

notify pgrst, 'reload schema';

commit;

