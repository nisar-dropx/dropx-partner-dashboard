begin;

-- Recovery debits are monthly obligations. Add the new column instead of
-- renaming debit_date so the currently deployed application remains usable
-- while this migration and the matching application release roll out.
alter table public.payment_recovery_cases
  add column debit_month date;

update public.payment_recovery_cases
set debit_month = pg_catalog.date_trunc('month', debit_date)::date;

alter table public.payment_recovery_cases
  alter column debit_month set not null;

alter table public.payment_recovery_cases
  add constraint payment_recovery_cases_debit_month_check
  check (debit_month = pg_catalog.date_trunc('month', debit_month)::date);

comment on column public.payment_recovery_cases.debit_month is
  'Debit month stored canonically as the first calendar day of the month.';

comment on column public.payment_recovery_cases.debit_date is
  'Legacy compatibility column retained during the debit-month rollout.';

create index payment_recovery_cases_company_month_idx
  on public.payment_recovery_cases(company_id, debit_month desc, id);
create index payment_recovery_cases_provider_month_idx
  on public.payment_recovery_cases(company_id, provider_id, debit_month desc);
create index payment_recovery_cases_station_month_idx
  on public.payment_recovery_cases(company_id, station_id, debit_month desc);

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
  v_location_code text;
  v_debit_month date;
  v_debit_amount numeric(18,2);
  v_recovery_method text;
  v_provider public.providers%rowtype;
  v_station public.stations%rowtype;
  v_location_match_count integer;
  v_provider_match_count integer;
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
  if p_rows is null or jsonb_typeof(p_rows) is distinct from 'array'
    or jsonb_array_length(p_rows) = 0
  then
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
    begin
      v_row_number := nullif(v_row->>'row_number', '')::integer;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'Every recovery row requires its workbook row number.';
    end;
    v_tid := nullif(pg_catalog.btrim(v_row->>'tid'), '');
    v_normalized_tid := public.normalize_payment_recovery_tid(v_tid);
    v_location_code := pg_catalog.upper(pg_catalog.btrim(coalesce(v_row->>'location', '')));
    begin
      v_debit_month := coalesce(
        nullif(pg_catalog.btrim(v_row->>'debit_month'), '')::date,
        pg_catalog.date_trunc(
          'month',
          nullif(pg_catalog.btrim(v_row->>'debit_date'), '')::date
        )::date
      );
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception 'Row % requires a valid debit month.', v_row_number;
    end;
    begin
      v_debit_amount := round(coalesce(nullif(v_row->>'debit_amount', '')::numeric, 0), 2);
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'Row % requires a valid debit amount.', v_row_number;
    end;
    v_recovery_method := pg_catalog.lower(pg_catalog.btrim(coalesce(v_row->>'recovery_method', '')));
    v_targets := coalesce(v_row->'targets', '[]'::jsonb);

    if v_row_number is null or v_row_number < 2 then raise exception 'Every recovery row requires its workbook row number.'; end if;
    if v_normalized_tid is null or pg_catalog.char_length(v_tid) > 120 then raise exception 'Row % has an invalid TID.', v_row_number; end if;
    if v_location_code = '' then raise exception 'Row % requires a location.', v_row_number; end if;
    if v_debit_month is null then raise exception 'Row % requires a valid debit month.', v_row_number; end if;
    if v_debit_month is distinct from pg_catalog.date_trunc('month', v_debit_month)::date then
      raise exception 'Row % debit month must be the first day of its month.', v_row_number;
    end if;
    if v_debit_amount <= 0 then raise exception 'Row % requires a debit amount greater than zero.', v_row_number; end if;
    if v_recovery_method not in ('payout_deduction', 'post_invoice_dispute') then
      raise exception 'Row % has an unsupported recovery method.', v_row_number;
    end if;
    if jsonb_typeof(v_targets) is distinct from 'array' then raise exception 'Row % has invalid Recovery IDs.', v_row_number; end if;
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

    select count(*)::integer into v_location_match_count
    from public.stations station
    where station.company_id = p_company_id
      and pg_catalog.upper(pg_catalog.btrim(station.station_code)) = v_location_code;
    if v_location_match_count = 0 then
      raise exception 'Row % location % was not found.', v_row_number, v_location_code;
    end if;
    if v_location_match_count > 1 then
      raise exception 'Row % location % matches more than one location. Fix the location master before importing.',
        v_row_number, v_location_code;
    end if;

    select station.* into v_station
    from public.stations station
    where station.company_id = p_company_id
      and pg_catalog.upper(pg_catalog.btrim(station.station_code)) = v_location_code
    order by station.id
    limit 1;
    if v_station.provider_id is null then
      raise exception 'Row % location % is not linked to a provider.', v_row_number, v_location_code;
    end if;

    select count(*)::integer into v_provider_match_count
    from public.providers provider
    where provider.company_id = p_company_id
      and provider.id = v_station.provider_id;
    if v_provider_match_count = 0 then
      raise exception 'Row % location % has an invalid provider mapping.', v_row_number, v_location_code;
    end if;
    if v_provider_match_count > 1 then
      raise exception 'Row % location % has an ambiguous provider mapping.', v_row_number, v_location_code;
    end if;

    select provider.* into v_provider
    from public.providers provider
    where provider.company_id = p_company_id
      and provider.id = v_station.provider_id
    order by provider.id
    limit 1;
    if nullif(pg_catalog.btrim(v_provider.code), '') is null then
      raise exception 'Row % location % is linked to a provider without a code.', v_row_number, v_location_code;
    end if;
    if p_allowed_location_ids is not null and not (v_station.id = any(p_allowed_location_ids)) then
      raise exception 'Row % location % is outside your access scope.', v_row_number, v_location_code;
    end if;

    insert into public.payment_recovery_cases(
      company_id, tid, provider_id, station_id, debit_date, debit_month, debit_amount,
      recovery_method, status, provider_code_snapshot, provider_name_snapshot,
      station_code_snapshot, provider_reference, reason, remark,
      source_type, source_batch_id, source_row_number, created_by, updated_by
    ) values (
      p_company_id, v_tid, v_provider.id, v_station.id, v_debit_month, v_debit_month, v_debit_amount,
      v_recovery_method,
      case when v_recovery_method = 'post_invoice_dispute' then 'planned_provider_dispute' else 'ready_for_deduction' end,
      v_provider.code, coalesce(nullif(pg_catalog.btrim(v_provider.name), ''), v_provider.code),
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

comment on function public.payment_recovery_apply_import(uuid, text, text, jsonb, uuid, uuid[]) is
  'Atomically imports monthly recovery cases, inferring provider from the company location mapping and splitting payout deductions exactly.';

revoke all on function public.payment_recovery_apply_import(uuid, text, text, jsonb, uuid, uuid[])
  from public, anon, authenticated;
grant execute on function public.payment_recovery_apply_import(uuid, text, text, jsonb, uuid, uuid[])
  to service_role;

commit;
