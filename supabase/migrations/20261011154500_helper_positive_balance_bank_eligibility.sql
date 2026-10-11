begin;

-- Helper bank payments are intentionally simpler than Workforce payments.
-- A live, server-recalculated Helper payout is the payment authority: a
-- notification/review publication and PAN verification are optional and must
-- not suppress an otherwise positive balance.

alter table public.helper_payout_payment_items
  alter column helper_publication_id drop not null;

comment on column public.helper_payout_payment_items.helper_publication_id is
  'Optional exact-matching notification publication retained only as provenance; Helper bank eligibility does not depend on notification or review state.';

create or replace function public.helper_payout_payment_row_candidates(
  p_company_id uuid, p_period_start date, p_period_end date, p_rows jsonb
)
returns table (
  workforce_id uuid,
  station_id uuid,
  dropx_id text,
  station_code text,
  current_target_amount numeric(14,2),
  paid_amount numeric(14,2),
  processing_amount numeric(14,2),
  balance_payable numeric(14,2),
  available_to_pay numeric(14,2),
  history_count integer,
  payment_status text,
  eligible boolean,
  eligibility_code text,
  eligibility_message text,
  helper_publication_id uuid,
  target_snapshot_hash text
)
language plpgsql security invoker set search_path = '' stable as $function$
declare
  v_selected record;
  v_helper public.helpers%rowtype;
  v_station public.stations%rowtype;
  v_publication public.helper_payout_publications%rowtype;
  v_paid numeric(14,2);
  v_processing numeric(14,2);
  v_latest_status text;
begin
  if p_company_id is null then
    raise exception 'Company is required for a Helper payment preview.';
  end if;
  if p_period_start is null or p_period_end is null or extract(day from p_period_start) <> 1
    or p_period_end <> (p_period_start + interval '1 month - 1 day')::date
  then
    raise exception 'Helper bank payment preview requires one exact calendar month.';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) < 1 then
    raise exception 'Select at least one Helper payout row.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_rows) selected(value)
    where jsonb_typeof(selected.value) <> 'object'
      or coalesce(selected.value ->> 'workforce_id', '') !~* '^[0-9a-f-]{36}$'
      or coalesce(selected.value ->> 'station_id', '') !~* '^[0-9a-f-]{36}$'
      or coalesce(selected.value ->> 'current_target_amount', '')
        !~ '^[+-]?[0-9]+([.][0-9]{1,2})?$'
      or coalesce(selected.value ->> 'current_snapshot_hash', '') !~ '^[0-9a-f]{64}$'
  ) then
    raise exception 'Every Helper payout row requires valid Helper, station, target amount and snapshot values.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_rows) selected(value)
    group by lower(selected.value ->> 'workforce_id'), lower(selected.value ->> 'station_id')
    having count(*) > 1
  ) then
    raise exception 'The same Helper payout row was selected more than once.';
  end if;

  for v_selected in
    select (selected.value ->> 'workforce_id')::uuid helper_id,
      (selected.value ->> 'station_id')::uuid location_id,
      greatest(round((selected.value ->> 'current_target_amount')::numeric, 2), 0)::numeric(14,2) target,
      selected.value ->> 'current_snapshot_hash' live_snapshot_hash
    from jsonb_array_elements(p_rows) selected(value)
    order by 1, 2
  loop
    workforce_id := v_selected.helper_id;
    station_id := v_selected.location_id;
    dropx_id := null;
    station_code := null;
    current_target_amount := v_selected.target;
    paid_amount := 0;
    processing_amount := 0;
    balance_payable := v_selected.target;
    available_to_pay := v_selected.target;
    history_count := 0;
    payment_status := null;
    eligible := false;
    eligibility_code := null;
    eligibility_message := null;
    helper_publication_id := null;
    target_snapshot_hash := v_selected.live_snapshot_hash;

    select helper.* into v_helper
    from public.helpers helper
    where helper.company_id = p_company_id
      and helper.id = v_selected.helper_id;
    if not found then
      eligibility_code := 'profile_unavailable';
      eligibility_message := 'Helper profile is unavailable in this company.';
      return next;
      continue;
    end if;
    dropx_id := nullif(upper(btrim(coalesce(v_helper.dropx_id, ''))), '');

    select station.* into v_station
    from public.stations station
    where station.company_id = p_company_id
      and station.id = v_selected.location_id;
    if not found then
      eligibility_code := 'location_unavailable';
      eligibility_message := 'Helper payout location is unavailable.';
      return next;
      continue;
    end if;
    station_code := nullif(upper(public.helper_payout_bank_text(v_station.station_code)), '');

    -- A publication is optional provenance only. Retain its foreign key when
    -- it exactly describes the live server snapshot and amount; never use it
    -- to replace or gate the current payout target.
    select publication.* into v_publication
    from public.helper_payout_publications publication
    where publication.company_id = p_company_id
      and publication.helper_id = v_selected.helper_id
      and publication.station_id = v_selected.location_id
      and publication.period_start = p_period_start
      and publication.period_end = p_period_end
      and publication.snapshot_hash = v_selected.live_snapshot_hash
      and coalesce(publication.snapshot #>> '{item,net_amount}', '')
        ~ '^[+-]?[0-9]+([.][0-9]+)?$'
      and greatest(
        round((publication.snapshot #>> '{item,net_amount}')::numeric, 2), 0
      ) = v_selected.target
    order by publication.revision desc, publication.published_at desc, publication.id desc
    limit 1;
    if found then
      helper_publication_id := v_publication.id;
    end if;

    select coalesce(sum(item.instruction_amount) filter (where item.status = 'paid'), 0),
      coalesce(sum(item.instruction_amount) filter (where item.status = 'processing'), 0),
      count(*)::integer
    into v_paid, v_processing, history_count
    from public.helper_payout_payment_items item
    where item.company_id = p_company_id
      and item.helper_id = v_selected.helper_id
      and item.location_id_snapshot = v_selected.location_id
      and item.period_start = p_period_start
      and item.period_end = p_period_end;
    paid_amount := round(v_paid, 2);
    processing_amount := round(v_processing, 2);
    balance_payable := greatest(current_target_amount - paid_amount, 0);
    available_to_pay := greatest(balance_payable - processing_amount, 0);

    select item.status into v_latest_status
    from public.helper_payout_payment_items item
    where item.company_id = p_company_id
      and item.helper_id = v_selected.helper_id
      and item.location_id_snapshot = v_selected.location_id
      and item.period_start = p_period_start
      and item.period_end = p_period_end
    order by item.payment_version desc, item.id desc
    limit 1;
    payment_status := case
      when processing_amount > 0 then 'Payment Processing'
      when paid_amount > 0 and balance_payable = 0 then 'Paid'
      when v_latest_status = 'failed' then 'Payment Failed'
      when v_latest_status = 'cancelled' then 'Payment Cancelled'
      when paid_amount > 0 then 'Partially Paid'
      else null
    end;

    if current_target_amount <= 0 or balance_payable <= 0 then
      available_to_pay := 0;
      eligibility_code := 'no_positive_balance';
      eligibility_message := 'No positive Helper balance is payable.';
      return next;
      continue;
    end if;
    if processing_amount > 0 then
      available_to_pay := 0;
      payment_status := 'Payment Processing';
      eligibility_code := 'payment_processing';
      eligibility_message := 'A Helper bank payment is already processing for this payout row.';
      return next;
      continue;
    end if;
    if coalesce((
      select hold.action = 'hold'
      from public.helper_payout_payment_hold_events hold
      where hold.company_id = p_company_id
        and hold.helper_id = v_selected.helper_id
        and hold.period_start = p_period_start
        and hold.period_end = p_period_end
      order by hold.created_at desc, hold.id desc
      limit 1
    ), false) then
      available_to_pay := 0;
      payment_status := 'Payment On Hold';
      eligibility_code := 'payment_on_hold';
      eligibility_message := 'Release the Helper payment hold before creating a bank payment.';
      return next;
      continue;
    end if;

    -- The remaining checks are intrinsic bank-instruction requirements, not
    -- review, PAN, allocation, or active-status business gates.
    if dropx_id is null or regexp_replace(dropx_id, '[^A-Z0-9]', '', 'g') = '' then
      available_to_pay := 0;
      eligibility_code := 'dropx_id_missing';
      eligibility_message := 'Helper DropX ID is required.';
      return next;
      continue;
    end if;
    if public.helper_payout_bank_text(v_helper.full_name) = '' then
      available_to_pay := 0;
      eligibility_code := 'beneficiary_name_missing';
      eligibility_message := format('Beneficiary name for Helper ID %s is required.', dropx_id);
      return next;
      continue;
    end if;
    if station_code is null then
      available_to_pay := 0;
      eligibility_code := 'location_code_missing';
      eligibility_message := 'Helper location code is required.';
      return next;
      continue;
    end if;
    if nullif(btrim(coalesce(v_helper.bank_account_no, '')), '') is null
      or nullif(btrim(coalesce(v_helper.ifsc_code, '')), '') is null
    then
      available_to_pay := 0;
      eligibility_code := 'bank_details_missing';
      eligibility_message := format('Bank details for Helper ID %s are incomplete.', dropx_id);
      return next;
      continue;
    end if;
    if public.workforce_payout_bank_account_canonical(v_helper.bank_account_no)
      !~ '^[A-Z0-9]{4,30}$'
    then
      available_to_pay := 0;
      eligibility_code := 'beneficiary_bank_account_invalid';
      eligibility_message := format('Bank account for Helper ID %s is invalid.', dropx_id);
      return next;
      continue;
    end if;
    if public.workforce_payout_bank_ifsc_canonical(v_helper.ifsc_code)
      !~ '^[A-Z]{4}0[A-Z0-9]{6}$'
    then
      available_to_pay := 0;
      eligibility_code := 'beneficiary_ifsc_invalid';
      eligibility_message := format('IFSC for Helper ID %s is invalid.', dropx_id);
      return next;
      continue;
    end if;

    eligible := true;
    eligibility_code := 'eligible';
    eligibility_message := '';
    return next;
  end loop;
end
$function$;

-- PAN and notification/review state no longer participate in Helper bank
-- eligibility, so they must not be frozen merely because a Helper instruction
-- is processing. Calculation, beneficiary, allocation, attendance, and other
-- live payout sources remain protected by their existing processing guards.
drop trigger if exists connect_profile_verifications_helper_processing_insert
  on public.connect_profile_verifications;
drop trigger if exists connect_profile_verifications_helper_processing_update
  on public.connect_profile_verifications;
drop trigger if exists connect_profile_verifications_helper_processing_delete
  on public.connect_profile_verifications;
drop trigger if exists helper_payout_processing_truncate
  on public.connect_profile_verifications;
drop trigger if exists helper_payout_publications_01_processing_guard
  on public.helper_payout_publications;
drop trigger if exists workforce_payout_review_submissions_01_helper_processing_guard
  on public.workforce_payout_review_submissions;

comment on table public.helper_payout_payment_items is
  'Immutable, location-scoped Helper bank instructions based on the live server-recalculated payout. Paid amounts reduce only the same Helper/location monthly balance.';
comment on function public.helper_preview_payout_payment_rows(uuid,date,date,jsonb) is
  'Returns authoritative live Helper balances and bank eligibility for selected Helper/location rows without requiring review, notification publication, allocation, PAN, or active status.';
comment on function public.helper_create_payout_payment_row_batch(uuid,uuid,uuid,text,uuid,date,date,date,jsonb) is
  'Creates one versioned FedOne instruction per eligible Helper/location row from the locked, server-recalculated Helper payout snapshot.';
comment on function public.guard_helper_payout_company_source_processing() is
  'Freezes shared payout calculation definitions while affected companies have processing Helper payments.';

notify pgrst, 'reload schema';

commit;
