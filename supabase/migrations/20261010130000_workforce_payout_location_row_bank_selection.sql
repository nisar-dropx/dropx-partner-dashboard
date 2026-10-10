begin;

create index if not exists workforce_payout_payment_allocations_company_station_item_idx
  on public.workforce_payout_payment_allocations(company_id, station_id, payment_item_id);

-- Bank generation refreshes only the worksheet rows that the operator checked.
-- Use exact Workforce/station pairs; separate Workforce and station arrays
-- would create an unsafe cross-product when several profiles are selected.
create or replace function public.workforce_claim_selected_payout_publication_row_refresh_jobs(
  p_limit integer,
  p_company_id uuid,
  p_rows jsonb,
  p_period_start date,
  p_period_end date
)
returns setof public.workforce_payout_publication_refresh_jobs
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'Claim between 1 and 100 payout publication refresh jobs.';
  end if;
  if p_company_id is null then
    raise exception 'A company is required to claim selected payout publication refresh jobs.';
  end if;
  if p_rows is null
    or jsonb_typeof(p_rows) <> 'array'
    or jsonb_array_length(p_rows) < 1
    or jsonb_array_length(p_rows) > 10000
  then
    raise exception 'Supply between 1 and 10000 Workforce payout rows.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_rows) selected(value)
    where jsonb_typeof(selected.value) <> 'object'
      or coalesce(selected.value ->> 'workforce_id', '')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(selected.value ->> 'station_id', '')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    raise exception 'Every Workforce payout row requires a valid Workforce ID and station ID.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_rows) selected(value)
    group by lower(selected.value ->> 'workforce_id'), lower(selected.value ->> 'station_id')
    having count(*) > 1
  ) then
    raise exception 'Supply each Workforce payout row only once.';
  end if;
  if p_period_start is null
    or p_period_end is null
    or p_period_start <> date_trunc('month', p_period_start)::date
    or p_period_end <> (p_period_start + interval '1 month - 1 day')::date
  then
    raise exception 'Selected payout publication refresh jobs require one complete calendar month.';
  end if;

  -- Preserve the canonical ten-minute lease and final-attempt dead-letter
  -- sweep, constrained to the exact supplied row identities.
  update public.workforce_payout_publication_refresh_jobs job
  set status = 'failed',
      claim_token = null,
      claimed_at = null,
      next_attempt_at = null,
      failed_at = clock_timestamp(),
      last_error = coalesce(job.last_error, 'Refresh worker lease expired after the final attempt.'),
      updated_at = clock_timestamp()
  where job.status = 'processing'
    and job.claimed_at < clock_timestamp() - interval '10 minutes'
    and job.claim_attempts >= job.max_attempts
    and job.company_id = p_company_id
    and job.period_start = p_period_start
    and job.period_end = p_period_end
    and exists (
      select 1
      from (
        select
          (selected.value ->> 'workforce_id')::uuid as workforce_id,
          (selected.value ->> 'station_id')::uuid as station_id
        from jsonb_array_elements(p_rows) selected(value)
      ) pair
      where pair.workforce_id = job.workforce_id
        and pair.station_id = job.station_id
    );

  return query
  with eligible as (
    select
      job.id,
      job.refresh_request_id,
      job.created_at,
      row_number() over (
        partition by job.company_id, job.workforce_id, job.station_id,
          job.period_start, job.period_end
        order by job.created_at, job.id
      ) as identity_order
    from public.workforce_payout_publication_refresh_jobs job
    where job.company_id = p_company_id
      and job.period_start = p_period_start
      and job.period_end = p_period_end
      and exists (
        select 1
        from (
          select
            (selected.value ->> 'workforce_id')::uuid as workforce_id,
            (selected.value ->> 'station_id')::uuid as station_id
          from jsonb_array_elements(p_rows) selected(value)
        ) pair
        where pair.workforce_id = job.workforce_id
          and pair.station_id = job.station_id
      )
      and job.claim_attempts < job.max_attempts
      and (
        (job.status = 'pending' and job.next_attempt_at <= clock_timestamp())
        or (
          job.status = 'processing'
          and job.claimed_at < clock_timestamp() - interval '10 minutes'
        )
      )
      and not exists (
        select 1
        from public.workforce_payout_publication_refresh_jobs active
        where active.company_id = job.company_id
          and active.workforce_id = job.workforce_id
          and active.station_id = job.station_id
          and active.period_start = job.period_start
          and active.period_end = job.period_end
          and active.status = 'processing'
          and active.claimed_at >= clock_timestamp() - interval '10 minutes'
      )
      and not exists (
        select 1
        from public.workforce_payout_publication_refresh_jobs predecessor
        where predecessor.company_id = job.company_id
          and predecessor.workforce_id = job.workforce_id
          and predecessor.station_id = job.station_id
          and predecessor.period_start = job.period_start
          and predecessor.period_end = job.period_end
          and predecessor.status in ('pending', 'processing')
          and (predecessor.created_at, predecessor.id) < (job.created_at, job.id)
      )
  ), target_generation as (
    select eligible.refresh_request_id
    from eligible
    where eligible.identity_order = 1
    group by eligible.refresh_request_id
    order by min(eligible.created_at), eligible.refresh_request_id
    limit 1
  ), candidates as (
    select job.id
    from public.workforce_payout_publication_refresh_jobs job
    join eligible on eligible.id = job.id and eligible.identity_order = 1
    join target_generation
      on target_generation.refresh_request_id = job.refresh_request_id
    order by eligible.created_at, job.id
    limit p_limit
    for update of job skip locked
  ), claimed as (
    update public.workforce_payout_publication_refresh_jobs job
    set status = 'processing',
        claim_attempts = job.claim_attempts + 1,
        claim_token = gen_random_uuid(),
        claimed_at = clock_timestamp(),
        next_attempt_at = null,
        last_error = null,
        updated_at = clock_timestamp()
    from candidates
    where job.id = candidates.id
    returning job.*
  )
  select claimed.*
  from claimed
  order by claimed.created_at, claimed.id;
end
$function$;

comment on function public.workforce_claim_selected_payout_publication_row_refresh_jobs(
  integer, uuid, jsonb, date, date
) is
  'Claims exact Workforce/station/exact-month refresh rows while preserving canonical lease, predecessor, generation, attempt and SKIP LOCKED semantics.';

revoke all on function public.workforce_claim_selected_payout_publication_row_refresh_jobs(
  integer, uuid, jsonb, date, date
) from public, anon, authenticated, service_role;
grant execute on function public.workforce_claim_selected_payout_publication_row_refresh_jobs(
  integer, uuid, jsonb, date, date
) to service_role;

-- Bank selection is a worksheet-row decision. A row is identified by the
-- Workforce profile and the station publication that produced that row. The
-- candidate calculator prices only that row after validating the profile's
-- complete station set and allocation history; sibling amounts are never
-- pulled into the selected row's bank instruction.
create or replace function public.workforce_payout_payment_row_candidates(
  p_company_id uuid,
  p_period_start date,
  p_period_end date,
  p_rows jsonb
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
  publication_id uuid,
  publication_revision integer,
  mapping_relock_id uuid,
  publication_snapshot_hash text
)
language plpgsql
security invoker
set search_path = ''
stable
as $function$
declare
  v_selection record;
  v_workforce_id uuid;
  v_station_id uuid;
  v_worker public.workforce%rowtype;
  v_publication record;
  v_relock_id uuid;
  v_active_locations jsonb;
  v_target numeric(14,2);
  v_paid numeric(14,2);
  v_processing numeric(14,2);
  v_profile_target numeric(14,2);
  v_profile_paid numeric(14,2);
  v_profile_processing numeric(14,2);
  v_station_balance_total numeric(14,2);
  v_station_available_total numeric(14,2);
  v_history_count integer;
  v_latest_attempt_status text;
  v_max_payment_version integer;
  v_selected_row_count integer;
  v_required_count integer;
  v_eligible_count integer;
  v_current_publications jsonb;
  v_allocations_reconcile boolean;
  v_paid_deltas_nonnegative boolean;
  v_processing_deltas_nonnegative boolean;
  v_profile_outstanding_reconciles boolean;
begin
  if p_company_id is null then
    raise exception 'Company is required for a Workforce payment preview.';
  end if;
  if p_period_start is null
    or p_period_end is null
    or extract(day from p_period_start) <> 1
    or p_period_end <> (p_period_start + interval '1 month - 1 day')::date
  then
    raise exception 'Workforce bank payment preview requires one exact calendar month.';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) < 1 then
    raise exception 'Select at least one Workforce payout row.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_rows) selected(value)
    where jsonb_typeof(selected.value) <> 'object'
      or coalesce(selected.value ->> 'workforce_id', '')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(selected.value ->> 'station_id', '')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    raise exception 'Every Workforce payout row requires a valid Workforce ID and station ID.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_rows) selected(value)
    group by lower(selected.value ->> 'workforce_id'), lower(selected.value ->> 'station_id')
    having count(*) > 1
  ) then
    raise exception 'The same Workforce payout row was selected more than once.';
  end if;

  for v_selection in
    select
      (selected.value ->> 'workforce_id')::uuid as workforce_id,
      (selected.value ->> 'station_id')::uuid as station_id
    from jsonb_array_elements(p_rows) selected(value)
    order by (selected.value ->> 'workforce_id')::uuid,
      (selected.value ->> 'station_id')::uuid
  loop
    v_workforce_id := v_selection.workforce_id;
    v_station_id := v_selection.station_id;
    workforce_id := v_workforce_id;
    station_id := v_station_id;
    dropx_id := null;
    station_code := null;
    current_target_amount := 0;
    paid_amount := 0;
    processing_amount := 0;
    balance_payable := 0;
    available_to_pay := 0;
    history_count := 0;
    payment_status := null;
    eligible := false;
    eligibility_code := null;
    eligibility_message := null;
    publication_id := null;
    publication_revision := null;
    mapping_relock_id := null;
    publication_snapshot_hash := null;
    v_latest_attempt_status := null;

    select worker.*
    into v_worker
    from public.workforce worker
    where worker.company_id = p_company_id
      and worker.id = v_workforce_id;
    if not found then
      eligibility_code := 'profile_unavailable';
      eligibility_message := format(
        'Workforce profile %s is unavailable in this company.', v_workforce_id
      );
      return next;
      continue;
    end if;
    dropx_id := nullif(upper(btrim(coalesce(v_worker.dropx_id, ''))), '');

    if exists (
      select 1
      from public.workforce_payout_publication_refresh_jobs job
      where job.company_id = p_company_id
        and job.workforce_id = v_workforce_id
        and job.station_id = v_station_id
        and job.period_start = p_period_start
        and job.period_end = p_period_end
        and job.status <> 'completed'
    ) then
      eligibility_code := 'publication_refresh_pending';
      eligibility_message := format(
        'The selected payout row for Workforce ID %s still has an unfinished publication refresh.',
        coalesce(dropx_id, v_workforce_id::text)
      );
      return next;
      continue;
    end if;

    select count(*)::integer
    into v_selected_row_count
    from jsonb_array_elements(p_rows) selected(value)
    where (selected.value ->> 'workforce_id')::uuid = v_workforce_id;

    if exists (
      select 1
      from public.workforce_payout_mapping_revision_state(
        p_company_id, v_workforce_id
      ) revision
      where revision.period_start = p_period_start
        and revision.period_end = p_period_end
        and revision.revision_pending
    ) then
      eligibility_code := 'mapping_relock_required';
      eligibility_message := format(
        'Relock Workforce ID %s mapping for this month before creating its bank payment.',
        coalesce(dropx_id, v_workforce_id::text)
      );
      return next;
      continue;
    end if;

    select relock.id, relock.active_locations
    into v_relock_id, v_active_locations
    from public.workforce_payout_mapping_relocks relock
    where relock.company_id = p_company_id
      and relock.period_start = p_period_start
      and relock.period_end = p_period_end
      and relock.affected_workforce_ids @> array[v_workforce_id]::uuid[]
    order by relock.relocked_at desc, relock.id desc
    limit 1;

    if v_relock_id is not null and not exists (
      select 1
      from jsonb_array_elements_text(coalesce(
        v_active_locations -> (v_workforce_id::text), '[]'::jsonb
      )) active(station_text)
      where active.station_text = v_station_id::text
    ) then
      eligibility_code := 'publication_missing';
      eligibility_message := 'The selected location is not active in the latest relocked mapping.';
      return next;
      continue;
    end if;

    -- A row can be paid independently only after the complete current station
    -- set is known.  This prevents a selected station from hiding a sibling
    -- publication whose signed amount is part of the profile's true balance.
    with required_stations as (
      select distinct required.station_id
      from (
        select station_text::uuid as station_id
        from jsonb_array_elements_text(coalesce(
          v_active_locations -> (v_workforce_id::text), '[]'::jsonb
        )) active(station_text)
        where v_relock_id is not null
        union all
        select review_submission.location_id
        from public.workforce_payout_review_submissions review_submission
        where v_relock_id is null
          and review_submission.company_id = p_company_id
          and review_submission.subject_type = 'workforce'
          and review_submission.subject_id = v_workforce_id
          and review_submission.period_start = p_period_start
          and review_submission.period_end = p_period_end
      ) required
    ), candidate_publications as (
      select publication.*, review_submission.status as review_status
      from public.workforce_payout_publications publication
      join required_stations required_station
        on required_station.station_id = publication.station_id
      join public.workforce_payout_review_submissions review_submission
        on review_submission.company_id = publication.company_id
       and review_submission.id = publication.review_submission_id
       and review_submission.subject_type = 'workforce'
       and review_submission.subject_id = publication.workforce_id
       and review_submission.location_id = publication.station_id
       and review_submission.period_start = publication.period_start
       and review_submission.period_end = publication.period_end
      where publication.company_id = p_company_id
        and publication.workforce_id = v_workforce_id
        and publication.publication_kind = 'worksheet'
        and publication.period_start = p_period_start
        and publication.period_end = p_period_end
        and (
          (v_relock_id is null and publication.mapping_relock_id is null)
          or publication.mapping_relock_id = v_relock_id
        )
    ), latest as (
      select distinct on (publication.station_id) publication.*
      from candidate_publications publication
      order by publication.station_id, publication.revision desc,
        publication.published_at desc, publication.id desc
    ), evaluated as (
      select
        required_station.station_id,
        latest.id,
        latest.revision,
        latest.mapping_relock_id,
        latest.snapshot_hash,
        latest.snapshot,
        latest.published_at,
        latest.review_status,
        upper(btrim(coalesce(
          latest.snapshot -> 'item' ->> 'station_code', station.station_code
        ))) as resolved_station_code,
        case
          when coalesce(latest.snapshot -> 'item' ->> 'net_amount', '')
            ~ '^[+-]?[0-9]+([.][0-9]+)?$'
          then round((latest.snapshot -> 'item' ->> 'net_amount')::numeric, 2)
          else null
        end as target_amount,
        latest.id is not null
          and latest.snapshot ->> 'schema_version' = '2'
          and latest.snapshot ->> 'source' = 'workforce_payout_worksheet'
          and latest.snapshot -> 'item' ->> 'workforce_id' = v_workforce_id::text
          and (
            latest.snapshot #>> '{worksheet,payment_eligible}' = 'true'
            or (
              latest.snapshot #> '{worksheet,payment_eligible}' is null
              and latest.snapshot #> '{worksheet,payment_details_available}' is null
              and latest.snapshot #> '{worksheet,payment_status}' is null
              and latest.published_at < '2026-10-10 00:00:00+00'::timestamptz
            )
          )
          and latest.review_status in ('under_review', 'approved')
          and coalesce(latest.snapshot -> 'item' ->> 'net_amount', '')
            ~ '^[+-]?[0-9]+([.][0-9]+)?$'
          and nullif(btrim(coalesce(latest.snapshot_hash, '')), '') is not null
          and nullif(btrim(coalesce(
            latest.snapshot -> 'item' ->> 'station_code', station.station_code, ''
          )), '') is not null as is_valid
      from required_stations required_station
      left join latest on latest.station_id = required_station.station_id
      left join public.stations station
        on station.company_id = p_company_id
       and station.id = required_station.station_id
    )
    select
      count(*)::integer,
      count(*) filter (where evaluated.is_valid)::integer,
      coalesce(jsonb_agg(jsonb_build_object(
        'publication_id', evaluated.id,
        'station_id', evaluated.station_id,
        'revision', evaluated.revision,
        'mapping_relock_id', evaluated.mapping_relock_id,
        'snapshot_hash', evaluated.snapshot_hash,
        'station_code', evaluated.resolved_station_code,
        'net_amount', evaluated.target_amount
      ) order by evaluated.station_id) filter (where evaluated.is_valid), '[]'::jsonb),
      round(coalesce(sum(evaluated.target_amount) filter (where evaluated.is_valid), 0), 2)
    into v_required_count, v_eligible_count, v_current_publications, v_profile_target
    from evaluated;

    if v_required_count < 1 then
      eligibility_code := 'publication_missing';
      eligibility_message := format(
        'No current published payout is available for Workforce ID %s in this month.',
        coalesce(dropx_id, v_workforce_id::text)
      );
      return next;
      continue;
    end if;
    if v_eligible_count <> v_required_count then
      eligibility_code := 'publication_stale_or_incomplete';
      eligibility_message := format(
        'A current published payout is stale, incomplete, or not explicitly payment-eligible for Workforce ID %s.',
        coalesce(dropx_id, v_workforce_id::text)
      );
      return next;
      continue;
    end if;

    select
      (current_publication.value ->> 'publication_id')::uuid as id,
      (current_publication.value ->> 'revision')::integer as revision,
      nullif(current_publication.value ->> 'mapping_relock_id', '')::uuid as mapping_relock_id,
      current_publication.value ->> 'snapshot_hash' as snapshot_hash,
      current_publication.value ->> 'station_code' as station_code,
      (current_publication.value ->> 'net_amount')::numeric(14,2) as target_amount
    into v_publication
    from jsonb_array_elements(v_current_publications) current_publication(value)
    where (current_publication.value ->> 'station_id')::uuid = v_station_id;
    if not found then
      eligibility_code := 'publication_missing';
      eligibility_message := format(
        'No current published payout is available for Workforce ID %s at the selected location.',
        coalesce(dropx_id, v_workforce_id::text)
      );
      return next;
      continue;
    end if;

    select
      round(coalesce(sum(item.instruction_amount) filter (where item.status = 'paid'), 0), 2),
      round(coalesce(sum(item.instruction_amount) filter (where item.status = 'processing'), 0), 2),
      coalesce(max(item.payment_version), 0)::integer
    into v_profile_paid, v_profile_processing, v_max_payment_version
    from public.workforce_payout_payment_items item
    where item.company_id = p_company_id
      and item.workforce_id = v_workforce_id
      and item.period_start = p_period_start
      and item.period_end = p_period_end;

    -- Every paid/processing item must be explained completely by immutable
    -- allocations that point back to the same profile/month and to a station
    -- that still belongs to the complete current publication set.
    with current_stations as (
      select
        (current_publication.value ->> 'station_id')::uuid as station_id,
        (current_publication.value ->> 'net_amount')::numeric(14,2) as target_amount
      from jsonb_array_elements(v_current_publications) current_publication(value)
    ), history_items as (
      select item.id, item.status, item.instruction_amount
      from public.workforce_payout_payment_items item
      where item.company_id = p_company_id
        and item.workforce_id = v_workforce_id
        and item.period_start = p_period_start
        and item.period_end = p_period_end
        and item.status in ('paid', 'processing')
    ), allocation_rows as (
      select
        history_item.id as item_id,
        history_item.status,
        history_item.instruction_amount,
        allocation.id as allocation_id,
        allocation.station_id,
        allocation.instruction_amount_snapshot,
        current_station.station_id as current_station_id,
        allocation.id is not null
          and current_station.station_id is not null
          and allocation_publication.id is not null
          and allocation_publication.workforce_id = v_workforce_id
          and allocation_publication.station_id = allocation.station_id
          and allocation_publication.period_start = p_period_start
          and allocation_publication.period_end = p_period_end as allocation_valid
      from history_items history_item
      left join public.workforce_payout_payment_allocations allocation
        on allocation.company_id = p_company_id
       and allocation.payment_item_id = history_item.id
      left join current_stations current_station
        on current_station.station_id = allocation.station_id
      left join public.workforce_payout_publications allocation_publication
        on allocation_publication.company_id = p_company_id
       and allocation_publication.id = allocation.publication_id
    ), item_checks as (
      select
        allocation_row.item_id,
        round(coalesce(sum(allocation_row.instruction_amount_snapshot), 0), 2)
          = round(allocation_row.instruction_amount, 2) as amount_reconciles,
        coalesce(bool_and(allocation_row.allocation_valid), false) as allocations_valid
      from allocation_rows allocation_row
      group by allocation_row.item_id, allocation_row.instruction_amount
    ), station_history as (
      select
        current_station.station_id,
        current_station.target_amount,
        round(coalesce(sum(allocation_row.instruction_amount_snapshot) filter (
          where allocation_row.status = 'paid'
            and allocation_row.station_id = current_station.station_id
        ), 0), 2) as paid_amount,
        round(coalesce(sum(allocation_row.instruction_amount_snapshot) filter (
          where allocation_row.status = 'processing'
            and allocation_row.station_id = current_station.station_id
        ), 0), 2) as processing_amount
      from current_stations current_station
      left join allocation_rows allocation_row
        on allocation_row.station_id = current_station.station_id
      group by current_station.station_id, current_station.target_amount
    )
    select
      coalesce((select bool_and(
        item_check.amount_reconciles and item_check.allocations_valid
      ) from item_checks item_check), true)
        and round(coalesce((select sum(allocation_row.instruction_amount_snapshot)
          from allocation_rows allocation_row where allocation_row.status = 'paid'), 0), 2)
          = round(v_profile_paid, 2)
        and round(coalesce((select sum(allocation_row.instruction_amount_snapshot)
          from allocation_rows allocation_row where allocation_row.status = 'processing'), 0), 2)
          = round(v_profile_processing, 2),
      coalesce(bool_and(station_history.target_amount - station_history.paid_amount >= 0), false),
      coalesce(bool_and(
        station_history.target_amount - station_history.paid_amount
          - station_history.processing_amount >= 0
      ), false),
      round(coalesce(sum(
        station_history.target_amount - station_history.paid_amount
      ), 0), 2),
      round(coalesce(sum(
        station_history.target_amount - station_history.paid_amount
          - station_history.processing_amount
      ), 0), 2),
      coalesce(max(station_history.paid_amount) filter (
        where station_history.station_id = v_station_id
      ), 0)::numeric(14,2),
      coalesce(max(station_history.processing_amount) filter (
        where station_history.station_id = v_station_id
      ), 0)::numeric(14,2)
    into v_allocations_reconcile, v_paid_deltas_nonnegative,
      v_processing_deltas_nonnegative, v_station_balance_total,
      v_station_available_total, v_paid, v_processing
    from station_history;

    v_profile_outstanding_reconciles :=
      v_profile_target >= 0
      and round(v_profile_target - v_profile_paid, 2) = v_station_balance_total
      and round(v_profile_target - v_profile_paid - v_profile_processing, 2)
        = v_station_available_total;

    select count(distinct item.id)::integer
    into v_history_count
    from public.workforce_payout_payment_items item
    join public.workforce_payout_payment_allocations allocation
      on allocation.company_id = item.company_id
     and allocation.payment_item_id = item.id
     and allocation.station_id = v_station_id
    where item.company_id = p_company_id
      and item.workforce_id = v_workforce_id
      and item.period_start = p_period_start
      and item.period_end = p_period_end;

    select item.status
    into v_latest_attempt_status
    from public.workforce_payout_payment_items item
    join public.workforce_payout_payment_allocations allocation
      on allocation.company_id = item.company_id
     and allocation.payment_item_id = item.id
     and allocation.station_id = v_station_id
    where item.company_id = p_company_id
      and item.workforce_id = v_workforce_id
      and item.period_start = p_period_start
      and item.period_end = p_period_end
    order by item.payment_version desc, item.id desc
    limit 1;

    v_target := v_publication.target_amount;
    station_code := v_publication.station_code;
    current_target_amount := greatest(v_target, 0::numeric);
    paid_amount := v_paid;
    processing_amount := v_processing;
    history_count := v_history_count;
    balance_payable := greatest(round(current_target_amount - v_paid, 2), 0::numeric);
    available_to_pay := greatest(round(balance_payable - v_processing, 2), 0::numeric);
    publication_id := v_publication.id;
    publication_revision := v_publication.revision;
    mapping_relock_id := v_publication.mapping_relock_id;
    publication_snapshot_hash := v_publication.snapshot_hash;

    if not v_allocations_reconcile
      or not v_paid_deltas_nonnegative
      or not v_processing_deltas_nonnegative
      or not v_profile_outstanding_reconciles
    then
      available_to_pay := 0;
      eligibility_code := 'payment_history_allocation_reassignment_required';
      eligibility_message := format(
        'Payment history for Workforce ID %s must be reassigned to its complete current location set before another bank file can be created.',
        coalesce(dropx_id, v_workforce_id::text)
      );
      return next;
      continue;
    end if;

    if exists (
      select 1
      from public.workforce_payout_payment_items item
      where item.company_id = p_company_id
        and item.workforce_id = v_workforce_id
        and item.period_start = p_period_start
        and item.period_end = p_period_end
        and item.status = 'processing'
    ) then
      available_to_pay := 0;
      payment_status := 'Payment Processing';
      eligibility_code := 'payment_processing';
      eligibility_message := format(
        'A Workforce bank instruction is already processing for profile %s and this month.',
        coalesce(dropx_id, v_workforce_id::text)
      );
      return next;
      continue;
    end if;

    payment_status := case
      when v_paid > 0 and balance_payable = 0 then 'Paid'
      when v_latest_attempt_status = 'failed' then 'Payment Failed'
      when v_latest_attempt_status = 'cancelled' then 'Payment Cancelled'
      when v_paid > 0 then 'Partially paid'
      else null
    end;

    if v_worker.deleted_at is not null
      or not coalesce(v_worker.is_active, false)
      or lower(btrim(coalesce(v_worker.lifecycle_status, ''))) not in ('', 'active', 'onboarding')
      or lower(btrim(coalesce(v_worker.onboarding_status, ''))) not in ('', 'active')
    then
      available_to_pay := 0;
      payment_status := 'Profile Not Active';
      eligibility_code := 'profile_not_active';
      eligibility_message := format(
        'Only Active Workforce profiles can be included in a bank file. Workforce ID %s is not Active.',
        coalesce(dropx_id, v_workforce_id::text)
      );
      return next;
      continue;
    end if;

    if not exists (
      select 1
      from public.connect_profile_verifications verification
      where verification.company_id = p_company_id
        and verification.profile_type = 'workforce'
        and verification.account_id = v_workforce_id
        and verification.kind = 'pan_aadhaar'
        and verification.verified = true
    ) then
      available_to_pay := 0;
      payment_status := 'PAN Not Linked';
      eligibility_code := 'pan_not_linked';
      eligibility_message := format(
        'PAN-Aadhaar must be linked for Workforce ID %s before creating its bank payment.',
        coalesce(dropx_id, v_workforce_id::text)
      );
      return next;
      continue;
    end if;

    if coalesce((
      select hold_event.action = 'hold'
      from public.workforce_payout_payment_hold_events hold_event
      where hold_event.company_id = p_company_id
        and hold_event.workforce_id = v_workforce_id
        and hold_event.period_start = p_period_start
        and hold_event.period_end = p_period_end
      order by hold_event.created_at desc, hold_event.id desc
      limit 1
    ), false) then
      available_to_pay := 0;
      payment_status := 'Payment On Hold';
      eligibility_code := 'payment_on_hold';
      eligibility_message := format(
        'Payment is on hold for Workforce ID %s.', coalesce(dropx_id, v_workforce_id::text)
      );
      return next;
      continue;
    end if;

    if available_to_pay <= 0 then
      eligibility_code := 'no_positive_balance';
      eligibility_message := format(
        'The selected payout row for Workforce ID %s has no positive balance payable.',
        coalesce(dropx_id, v_workforce_id::text)
      );
      return next;
      continue;
    end if;

    if dropx_id is null
      or nullif(btrim(coalesce(v_worker.full_name, '')), '') is null
      or nullif(btrim(coalesce(v_worker.bank_account_no, '')), '') is null
      or nullif(btrim(coalesce(v_worker.ifsc_code, '')), '') is null
    then
      eligibility_code := 'beneficiary_bank_details_missing';
      eligibility_message := format(
        'DropX ID, beneficiary name, bank account and IFSC are required for Workforce ID %s.',
        coalesce(dropx_id, v_workforce_id::text)
      );
      return next;
      continue;
    end if;
    if public.workforce_payout_bank_account_canonical(v_worker.bank_account_no)
      !~ '^[A-Z0-9]{4,30}$'
    then
      eligibility_code := 'beneficiary_bank_account_invalid';
      eligibility_message := format('Bank account for Workforce ID %s is invalid.', dropx_id);
      return next;
      continue;
    end if;
    if public.workforce_payout_bank_ifsc_canonical(v_worker.ifsc_code)
      !~ '^[A-Z]{4}0[A-Z0-9]{6}$'
    then
      eligibility_code := 'beneficiary_ifsc_invalid';
      eligibility_message := format('IFSC for Workforce ID %s is invalid.', dropx_id);
      return next;
      continue;
    end if;
    if regexp_replace(dropx_id, '[^A-Z0-9]', '', 'g') = ''
      or 9 + length(regexp_replace(dropx_id, '[^A-Z0-9]', '', 'g'))
        + length((v_max_payment_version + v_selected_row_count)::text) > 64
    then
      eligibility_code := 'payment_reference_invalid';
      eligibility_message := format(
        'DropX ID %s cannot produce a valid Workforce bank reference.', dropx_id
      );
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

create or replace function public.workforce_preview_payout_payment_rows(
  p_company_id uuid,
  p_period_start date,
  p_period_end date,
  p_rows jsonb
)
returns table (
  workforce_id uuid,
  station_id uuid,
  dropx_id text,
  current_target_amount numeric(14,2),
  paid_amount numeric(14,2),
  processing_amount numeric(14,2),
  balance_payable numeric(14,2),
  available_to_pay numeric(14,2),
  history_count integer,
  payment_status text,
  eligible boolean,
  eligibility_code text,
  eligibility_message text
)
language sql
security definer
set search_path = ''
stable
as $function$
  select
    candidate.workforce_id,
    candidate.station_id,
    candidate.dropx_id,
    candidate.current_target_amount,
    candidate.paid_amount,
    candidate.processing_amount,
    candidate.balance_payable,
    candidate.available_to_pay,
    candidate.history_count,
    candidate.payment_status,
    candidate.eligible,
    candidate.eligibility_code,
    candidate.eligibility_message
  from public.workforce_payout_payment_row_candidates(
    p_company_id, p_period_start, p_period_end, p_rows
  ) candidate
  order by candidate.workforce_id, candidate.station_id;
$function$;

create or replace function public.workforce_create_payout_payment_row_batch(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_operation_id uuid,
  p_request_fingerprint text,
  p_bank_id uuid,
  p_period_start date,
  p_period_end date,
  p_value_date date,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_rows jsonb;
  v_ids uuid[];
  v_candidates jsonb;
  v_existing public.workforce_payout_payment_batches%rowtype;
  v_bank public.payment_banks%rowtype;
  v_worker public.workforce%rowtype;
  v_candidate jsonb;
  v_debit_account text;
  v_bank_ifsc text;
  v_beneficiary_account text;
  v_beneficiary_ifsc text;
  v_workforce_id uuid;
  v_station_id uuid;
  v_target numeric(14,2);
  v_paid numeric(14,2);
  v_instruction numeric(14,2);
  v_version integer;
  v_reference text;
  v_item_id uuid;
  v_batch_id uuid := gen_random_uuid();
  v_created_count integer := 0;
  v_preflight_count integer := 0;
  v_locked_count integer := 0;
begin
  if p_company_id is null or p_actor_user_id is null
    or p_operation_id is null or p_bank_id is null
  then
    raise exception 'Company, actor, operation and bank are required for a Workforce payment batch.';
  end if;
  if p_period_start is null
    or p_period_end is null
    or extract(day from p_period_start) <> 1
    or p_period_end <> (p_period_start + interval '1 month - 1 day')::date
  then
    raise exception 'Workforce bank payment generation requires one exact calendar month.';
  end if;
  if p_value_date is null then
    raise exception 'Bank value date is required.';
  end if;
  if p_request_fingerprint is null or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'A SHA-256 request fingerprint is required.';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) < 1 then
    raise exception 'Select at least one Workforce payout row.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_rows) selected(value)
    where jsonb_typeof(selected.value) <> 'object'
      or coalesce(selected.value ->> 'workforce_id', '')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(selected.value ->> 'station_id', '')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    raise exception 'Every Workforce payout row requires a valid Workforce ID and station ID.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_rows) selected(value)
    group by lower(selected.value ->> 'workforce_id'), lower(selected.value ->> 'station_id')
    having count(*) > 1
  ) then
    raise exception 'The same Workforce payout row was selected more than once.';
  end if;

  -- Canonical ordering makes operation retries deterministic while the
  -- request fingerprint preserves the exact selected row set.
  select jsonb_agg(jsonb_build_object(
      'workforce_id', normalized.workforce_id,
      'station_id', normalized.station_id
    ) order by normalized.workforce_id, normalized.station_id)
  into v_rows
  from (
    select
      (selected.value ->> 'workforce_id')::uuid as workforce_id,
      (selected.value ->> 'station_id')::uuid as station_id
    from jsonb_array_elements(p_rows) selected(value)
  ) normalized;
  select array_agg(distinct normalized.workforce_id order by normalized.workforce_id)
  into v_ids
  from (
    select (selected.value ->> 'workforce_id')::uuid as workforce_id
    from jsonb_array_elements(v_rows) selected(value)
  ) normalized;

  if not exists (select 1 from public.companies company where company.id = p_company_id) then
    raise exception 'Company was not found.';
  end if;
  if not exists (select 1 from auth.users actor where actor.id = p_actor_user_id) then
    raise exception 'Payment actor was not found.';
  end if;

  select batch.* into v_existing
  from public.workforce_payout_payment_batches batch
  where batch.company_id = p_company_id
    and batch.operation_id = p_operation_id;
  if found then
    if v_existing.request_fingerprint <> p_request_fingerprint
      or v_existing.selected_workforce_ids <> v_ids
      or v_existing.bank_id <> p_bank_id
      or v_existing.period_start <> p_period_start
      or v_existing.period_end <> p_period_end
      or v_existing.value_date <> p_value_date
      or v_existing.generated_by <> p_actor_user_id
    then
      raise exception 'This Workforce payment operation ID was already used for a different request.';
    end if;
  end if;

  perform 1
  from public.workforce workforce
  where workforce.company_id = p_company_id
    and workforce.id = any(v_ids)
  order by workforce.id
  for update;
  get diagnostics v_locked_count = row_count;
  if v_locked_count <> cardinality(v_ids) then
    raise exception 'One or more selected Workforce profiles are unavailable in this company.';
  end if;
  perform public.lock_workforce_payment_allocation_company(p_company_id);

  select batch.* into v_existing
  from public.workforce_payout_payment_batches batch
  where batch.company_id = p_company_id
    and batch.operation_id = p_operation_id;
  if found then
    if v_existing.request_fingerprint <> p_request_fingerprint
      or v_existing.selected_workforce_ids <> v_ids
      or v_existing.bank_id <> p_bank_id
      or v_existing.period_start <> p_period_start
      or v_existing.period_end <> p_period_end
      or v_existing.value_date <> p_value_date
      or v_existing.generated_by <> p_actor_user_id
    then
      raise exception 'This Workforce payment operation ID was already used for a different request.';
    end if;
    if v_existing.status <> 'processing'
      or exists (
        select 1
        from public.workforce_payout_payment_items item
        where item.company_id = p_company_id
          and item.batch_id = v_existing.id
          and item.status <> 'processing'
      )
    then
      raise exception 'This Workforce payment batch is already partially or fully finalized and its bank file cannot be regenerated.';
    end if;
    return public.workforce_payout_payment_batch_result(v_existing.id, true);
  end if;

  select bank.* into v_bank
  from public.payment_banks bank
  where bank.company_id = p_company_id
    and bank.id = p_bank_id
    and bank.is_active = true
    and upper(btrim(bank.bank_code)) = 'FEDERAL_BANK'
  for share;
  if not found then
    raise exception 'Select the active Federal Bank FedOne payment bank configured for this company.';
  end if;
  v_debit_account := public.workforce_payout_bank_account_canonical(v_bank.account_no);
  v_bank_ifsc := public.workforce_payout_bank_ifsc_canonical(v_bank.ifsc);
  if v_debit_account !~ '^[A-Z0-9]{4,30}$' then
    raise exception 'The selected Federal Bank debit account must contain 4 to 30 letters or digits.';
  end if;
  if v_bank_ifsc !~ '^[A-Z]{4}0[A-Z0-9]{6}$' then
    raise exception 'The selected Federal Bank IFSC must use the standard 11-character format.';
  end if;

  select coalesce(jsonb_agg(to_jsonb(candidate)
    order by candidate.workforce_id, candidate.station_id), '[]'::jsonb)
  into v_candidates
  from public.workforce_payout_payment_row_candidates(
    p_company_id, p_period_start, p_period_end, v_rows
  ) candidate;
  if jsonb_array_length(v_candidates) <> jsonb_array_length(v_rows) then
    raise exception 'One or more selected Workforce payout rows could not be resolved.';
  end if;
  for v_candidate in
    select selected.value
    from jsonb_array_elements(v_candidates) selected(value)
  loop
    if coalesce((v_candidate ->> 'eligible')::boolean, false) then
      v_preflight_count := v_preflight_count + 1;
    elsif v_candidate ->> 'eligibility_code' <> 'no_positive_balance' then
      raise exception '%', v_candidate ->> 'eligibility_message';
    end if;
  end loop;
  if v_preflight_count < 1 then
    raise exception 'The selected Workforce payout rows have no positive balance payable for this month.';
  end if;

  perform set_config('app.workforce_payout_payment_mutation', 'allowed', true);
  insert into public.workforce_payout_payment_batches (
    id, company_id, operation_id, request_fingerprint,
    selected_workforce_ids, bank_id, period_start, period_end,
    value_date, debit_account_no_snapshot, bank_code_snapshot,
    file_type_snapshot, status, generated_by
  ) values (
    v_batch_id, p_company_id, p_operation_id, p_request_fingerprint,
    v_ids, p_bank_id, p_period_start, p_period_end,
    p_value_date, v_debit_account, upper(btrim(v_bank.bank_code)),
    'fedone', 'processing', p_actor_user_id
  );

  for v_candidate in
    select selected.value
    from jsonb_array_elements(v_candidates) selected(value)
    order by (selected.value ->> 'workforce_id')::uuid,
      (selected.value ->> 'station_id')::uuid
  loop
    if not coalesce((v_candidate ->> 'eligible')::boolean, false) then
      continue;
    end if;
    v_workforce_id := (v_candidate ->> 'workforce_id')::uuid;
    v_station_id := (v_candidate ->> 'station_id')::uuid;
    v_target := (v_candidate ->> 'current_target_amount')::numeric(14,2);
    v_paid := (v_candidate ->> 'paid_amount')::numeric(14,2);
    v_instruction := (v_candidate ->> 'available_to_pay')::numeric(14,2);

    select workforce.* into v_worker
    from public.workforce workforce
    where workforce.company_id = p_company_id
      and workforce.id = v_workforce_id;
    v_beneficiary_account := public.workforce_payout_bank_account_canonical(v_worker.bank_account_no);
    v_beneficiary_ifsc := public.workforce_payout_bank_ifsc_canonical(v_worker.ifsc_code);

    select coalesce(max(item.payment_version), 0) + 1
    into v_version
    from public.workforce_payout_payment_items item
    where item.company_id = p_company_id
      and item.workforce_id = v_workforce_id
      and item.period_start = p_period_start
      and item.period_end = p_period_end;
    v_reference := public.workforce_payout_payment_reference(
      v_worker.dropx_id, p_period_start, v_version
    );

    insert into public.workforce_payout_payment_items (
      company_id, batch_id, workforce_id, period_start, period_end,
      payment_version, reference_no, dropx_id_snapshot,
      beneficiary_name_snapshot, beneficiary_email_snapshot,
      bank_account_no_snapshot, ifsc_snapshot,
      location_id_snapshot, location_code_snapshot,
      debit_remarks_snapshot, credit_remarks_snapshot,
      current_target_amount, paid_before_amount, instruction_amount,
      status
    ) values (
      p_company_id, v_batch_id, v_workforce_id, p_period_start, p_period_end,
      v_version, v_reference, upper(btrim(v_worker.dropx_id)),
      btrim(v_worker.full_name), nullif(btrim(coalesce(v_worker.email, '')), ''),
      v_beneficiary_account, v_beneficiary_ifsc,
      v_station_id, v_candidate ->> 'station_code',
      'NET PAY', v_candidate ->> 'station_code',
      v_target, v_paid, v_instruction,
      'processing'
    ) returning id into v_item_id;

    insert into public.workforce_payout_payment_allocations (
      company_id, payment_item_id, publication_id, station_id, revision,
      mapping_relock_id, snapshot_hash, station_code_snapshot,
      net_amount_snapshot, instruction_amount_snapshot
    ) values (
      p_company_id, v_item_id, (v_candidate ->> 'publication_id')::uuid,
      v_station_id, (v_candidate ->> 'publication_revision')::integer,
      nullif(v_candidate ->> 'mapping_relock_id', '')::uuid,
      v_candidate ->> 'publication_snapshot_hash',
      v_candidate ->> 'station_code', v_target, v_instruction
    );

    insert into public.workforce_payout_payment_events (
      company_id, batch_id, payment_item_id, event_type, event_data, actor_user_id
    ) values (
      p_company_id, v_batch_id, v_item_id, 'payment_instruction_created',
      jsonb_build_object(
        'reference_no', v_reference,
        'payment_version', v_version,
        'current_target_amount', v_target,
        'paid_before_amount', v_paid,
        'instruction_amount', v_instruction,
        'station_id', v_station_id,
        'selection_mode', 'payout_row'
      ),
      p_actor_user_id
    );
    v_created_count := v_created_count + 1;
  end loop;

  if v_created_count < 1 then
    raise exception 'The selected Workforce payout rows have no positive balance payable for this month.';
  end if;
  insert into public.workforce_payout_payment_events (
    company_id, batch_id, event_type, event_data, actor_user_id
  ) values (
    p_company_id, v_batch_id, 'bank_file_generated',
    jsonb_build_object(
      'payment_count', v_created_count,
      'selected_row_count', jsonb_array_length(v_rows),
      'value_date', p_value_date,
      'bank_id', p_bank_id,
      'selection_mode', 'payout_row'
    ),
    p_actor_user_id
  );

  return public.workforce_payout_payment_batch_result(v_batch_id, false);
end
$function$;

comment on function public.workforce_payout_payment_row_candidates(uuid, date, date, jsonb) is
  'Canonical service-only station-row bank candidate calculator. Balances and paid allocations never include sibling locations for the same Workforce profile.';
comment on function public.workforce_preview_payout_payment_rows(uuid, date, date, jsonb) is
  'Returns one authoritative balance and bank eligibility result per selected Workforce and station row.';
comment on function public.workforce_create_payout_payment_row_batch(
  uuid, uuid, uuid, text, uuid, date, date, date, jsonb
) is
  'Atomically creates one FedOne instruction per selected Workforce station row without expanding the selection to sibling locations.';

revoke all on function public.workforce_payout_payment_row_candidates(uuid, date, date, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.workforce_preview_payout_payment_rows(uuid, date, date, jsonb)
  from public, anon, authenticated;
revoke all on function public.workforce_create_payout_payment_row_batch(
  uuid, uuid, uuid, text, uuid, date, date, date, jsonb
) from public, anon, authenticated;
grant execute on function public.workforce_preview_payout_payment_rows(uuid, date, date, jsonb)
  to service_role;
grant execute on function public.workforce_create_payout_payment_row_batch(
  uuid, uuid, uuid, text, uuid, date, date, date, jsonb
) to service_role;

-- Keep the legacy profile-wide creator callable during the additive rollout.
-- A follow-up migration can revoke it only after every application instance
-- has moved to the row-aware RPC, avoiding a deployment-order outage.

notify pgrst, 'reload schema';

commit;
