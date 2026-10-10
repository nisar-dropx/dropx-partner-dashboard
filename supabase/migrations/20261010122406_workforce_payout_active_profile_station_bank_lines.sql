begin;

-- A profile may have several station-level bank instructions in one batch, but
-- a second batch must never process the same profile/month concurrently.  The
-- trigger below serializes inserts on the Workforce row and enforces that
-- cross-batch invariant; this index independently prevents duplicate station
-- lines inside the accepted batch.
drop index public.workforce_payout_payment_items_active_uidx;
create unique index workforce_payout_payment_items_active_uidx
  on public.workforce_payout_payment_items(
    company_id, workforce_id, period_start, period_end,
    batch_id, location_id_snapshot
  )
  where status = 'processing';

create or replace function public.guard_workforce_payout_payment_item_ledger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if current_setting('app.workforce_payout_payment_mutation', true) is distinct from 'allowed' then
    raise exception 'Workforce payout payment items may be changed only by the bank-processing RPCs.';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Workforce payout payment items cannot be deleted.';
  end if;
  if tg_op = 'INSERT' then
    if new.status = 'processing' then
      -- This row lock is also taken by the batch RPC.  Keeping it here makes
      -- the invariant safe for every future privileged insert path and closes
      -- the race between two different batches targeting different stations.
      perform 1
      from public.workforce workforce
      where workforce.company_id = new.company_id
        and workforce.id = new.workforce_id
      for update;

      if exists (
        select 1
        from public.workforce_payout_payment_items existing
        where existing.company_id = new.company_id
          and existing.workforce_id = new.workforce_id
          and existing.period_start = new.period_start
          and existing.period_end = new.period_end
          and existing.status = 'processing'
          and existing.batch_id <> new.batch_id
      ) then
        raise exception 'A different Workforce bank batch is already processing this profile and month.';
      end if;
    end if;
    return new;
  end if;

  if (to_jsonb(new) - array[
      'status', 'bank_response_status', 'utr_cin', 'bank_processing_remarks',
      'response_import_id', 'finalized_by', 'finalized_at', 'updated_at'
    ]::text[])
    is distinct from
    (to_jsonb(old) - array[
      'status', 'bank_response_status', 'utr_cin', 'bank_processing_remarks',
      'response_import_id', 'finalized_by', 'finalized_at', 'updated_at'
    ]::text[])
  then
    raise exception 'A Workforce payout payment instruction is immutable after generation.';
  end if;
  if old.status <> 'processing' or new.status not in ('paid', 'cancelled', 'failed') then
    raise exception 'A terminal Workforce payout payment instruction is immutable.';
  end if;
  return new;
end
$function$;

-- Add the live-profile gate and make the processing preview stable when one
-- station line has finalized while a sibling from the same batch is still in
-- flight.  The immutable target is the paid amount before that batch plus all
-- instructions created by the batch, including terminal siblings.
do $patch$
declare
  v_definition text;
  v_declaration_old constant text := 'v_processing_target numeric(14,2);';
  v_declaration_new constant text := $new$v_processing_target numeric(14,2);
  v_processing_batch_id uuid;
  v_processing_batch_count integer;
  v_max_payment_version integer;$new$;
  v_eligibility_marker constant text := replace($marker$
    if not exists (
      select 1
      from public.connect_profile_verifications verification
$marker$, chr(13), '');
  v_active_gate constant text := $new$
    -- This predicate is the database equivalent of workforceProfileStatus()
    -- for the columns loaded by the Workforce payout page.  Only its literal
    -- "Active" outcome is bank eligible.  It deliberately runs only after the
    -- published target and paid/balance history are calculated, and after the
    -- Payment Processing branch, so exclusion never hides financial history.
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
$new$;
  v_totals_old constant text := replace($old$
    select
      round(coalesce(sum(item.instruction_amount) filter (where item.status = 'paid'), 0), 2),
      round(coalesce(sum(item.instruction_amount) filter (where item.status = 'processing'), 0), 2),
      round(coalesce(max(item.current_target_amount) filter (where item.status = 'processing'), 0), 2),
      count(*)::integer
    into v_paid, v_processing, v_processing_target, v_history_count
    from public.workforce_payout_payment_items item
    where item.company_id = p_company_id
      and item.workforce_id = v_workforce_id
      and item.period_start = p_period_start
      and item.period_end = p_period_end;
$old$, chr(13), '');
  v_totals_new constant text := $new$
    select
      round(coalesce(sum(item.instruction_amount) filter (where item.status = 'paid'), 0), 2),
      round(coalesce(sum(item.instruction_amount) filter (where item.status = 'processing'), 0), 2),
      (array_agg(item.batch_id order by item.batch_id)
        filter (where item.status = 'processing'))[1],
      count(distinct item.batch_id) filter (where item.status = 'processing')::integer,
      count(*)::integer,
      coalesce(max(item.payment_version), 0)::integer
    into v_paid, v_processing, v_processing_batch_id,
      v_processing_batch_count, v_history_count, v_max_payment_version
    from public.workforce_payout_payment_items item
    where item.company_id = p_company_id
      and item.workforce_id = v_workforce_id
      and item.period_start = p_period_start
      and item.period_end = p_period_end;

    if v_processing_batch_count > 1 then
      raise exception 'More than one Workforce bank batch is processing profile % for the same month.',
        v_workforce_id;
    end if;

    if v_processing_batch_id is not null then
      select round(
        coalesce(sum(item.instruction_amount) filter (
          where item.status = 'paid' and item.batch_id <> v_processing_batch_id
        ), 0)
        + coalesce(sum(item.instruction_amount) filter (
          where item.batch_id = v_processing_batch_id
        ), 0),
        2
      )
      into v_processing_target
      from public.workforce_payout_payment_items item
      where item.company_id = p_company_id
        and item.workforce_id = v_workforce_id
        and item.period_start = p_period_start
        and item.period_end = p_period_end;
    else
      v_processing_target := 0;
    end if;
$new$;
  v_reference_old constant text := $old$length((v_history_count + 1)::text) > 64$old$;
  v_reference_new constant text := $new$length((
          v_max_payment_version + greatest(v_required_count, 1)
        )::text) > 64$new$;
begin
  select pg_get_functiondef(
    'public.workforce_payout_payment_candidates(uuid,date,date,uuid[])'::regprocedure
  ) into v_definition;
  v_definition := replace(v_definition, chr(13), '');

  if position('profile_not_active' in v_definition) > 0
    and position('v_processing_batch_id uuid;' in v_definition) > 0
  then
    return;
  end if;
  if position(v_declaration_old in v_definition) = 0
    or position(v_eligibility_marker in v_definition) = 0
    or position(v_totals_old in v_definition) = 0
    or position(v_reference_old in v_definition) = 0
  then
    raise exception 'Unexpected Workforce bank candidate structure; Active/split migration was not applied.';
  end if;

  v_definition := replace(v_definition, v_declaration_old, v_declaration_new);
  v_definition := replace(v_definition, v_totals_old, v_totals_new);
  v_definition := replace(v_definition, v_reference_old, v_reference_new);
  v_definition := replace(v_definition, v_eligibility_marker, v_active_gate);
  execute v_definition;
end
$patch$;

-- Replace only the item-creation section of the existing service-only creator.
-- All earlier idempotency, profile locks, bank validation and atomic preflight
-- remain unchanged.  A station split is accepted only when the existing paid
-- allocation ledger reconciles exactly to the current station set and the
-- station deltas reproduce the canonical profile balance to the paise.
do $patch$
declare
  v_definition text;
  v_declaration_marker constant text := 'v_created_count integer := 0;';
  v_declaration_new constant text := $new$v_created_count integer := 0;
  v_next_version integer;
  v_split_safe boolean;
  v_station record;$new$;
  v_start_marker constant text := '    v_publications := v_candidate.publications;';
  v_end_marker constant text := '    v_created_count := v_created_count + 1;';
  v_start integer;
  v_end_offset integer;
  v_new_block constant text := $creator_new$    v_publications := v_candidate.publications;
    v_target := v_candidate.current_target_amount;
    v_paid := v_candidate.paid_amount;
    v_instruction := v_candidate.available_to_pay;
    v_location_id := v_candidate.location_id;
    v_location_code := v_candidate.location_code;
    v_beneficiary_account := public.workforce_payout_bank_account_canonical(v_worker.bank_account_no);
    v_beneficiary_ifsc := public.workforce_payout_bank_ifsc_canonical(v_worker.ifsc_code);

    select coalesce(max(item.payment_version), 0)
    into v_next_version
    from public.workforce_payout_payment_items item
    where item.company_id = p_company_id
      and item.workforce_id = v_workforce_id
      and item.period_start = p_period_start
      and item.period_end = p_period_end;

    with current_stations as (
      select
        (publication ->> 'publication_id')::uuid as publication_id,
        (publication ->> 'station_id')::uuid as station_id,
        (publication ->> 'net_amount')::numeric(14,2) as net_amount
      from jsonb_array_elements(v_publications) publication
    ), paid_items as (
      select item.id, item.instruction_amount
      from public.workforce_payout_payment_items item
      where item.company_id = p_company_id
        and item.workforce_id = v_workforce_id
        and item.period_start = p_period_start
        and item.period_end = p_period_end
        and item.status = 'paid'
    ), paid_item_checks as (
      select paid_item.id, paid_item.instruction_amount,
        round(coalesce(sum(allocation.instruction_amount_snapshot), 0), 2) allocated_amount
      from paid_items paid_item
      left join public.workforce_payout_payment_allocations allocation
        on allocation.company_id = p_company_id
       and allocation.payment_item_id = paid_item.id
      group by paid_item.id, paid_item.instruction_amount
    ), paid_allocations as (
      select allocation.station_id,
        round(sum(allocation.instruction_amount_snapshot), 2) paid_amount
      from paid_items paid_item
      join public.workforce_payout_payment_allocations allocation
        on allocation.company_id = p_company_id
       and allocation.payment_item_id = paid_item.id
      group by allocation.station_id
    ), station_deltas as (
      select current_station.station_id,
        round(current_station.net_amount - coalesce(paid_allocation.paid_amount, 0), 2) delta_amount
      from current_stations current_station
      left join paid_allocations paid_allocation
        on paid_allocation.station_id = current_station.station_id
    )
    select
      coalesce((
        select bool_and(check_row.allocated_amount = check_row.instruction_amount)
        from paid_item_checks check_row
      ), true)
      and not exists (
        select 1
        from paid_allocations paid_allocation
        where not exists (
          select 1 from current_stations current_station
          where current_station.station_id = paid_allocation.station_id
        )
      )
      and round(coalesce((select sum(paid_amount) from paid_allocations), 0), 2) = round(v_paid, 2)
      and coalesce((select bool_and(delta_amount >= 0) from station_deltas), false)
      and round(coalesce((select sum(delta_amount) from station_deltas), 0), 2)
        = round(v_instruction, 2)
      and exists (select 1 from station_deltas where delta_amount > 0)
    into v_split_safe;

    if v_split_safe then
      for v_station in
        with current_stations as (
          select
            (publication ->> 'publication_id')::uuid as publication_id,
            (publication ->> 'station_id')::uuid as station_id,
            (publication ->> 'revision')::integer as revision,
            nullif(publication ->> 'mapping_relock_id', '')::uuid as mapping_relock_id,
            publication ->> 'snapshot_hash' as snapshot_hash,
            upper(btrim(publication ->> 'station_code')) as station_code,
            (publication ->> 'net_amount')::numeric(14,2) as net_amount
          from jsonb_array_elements(v_publications) publication
        ), paid_allocations as (
          select allocation.station_id,
            round(sum(allocation.instruction_amount_snapshot), 2) paid_amount
          from public.workforce_payout_payment_items paid_item
          join public.workforce_payout_payment_allocations allocation
            on allocation.company_id = paid_item.company_id
           and allocation.payment_item_id = paid_item.id
          where paid_item.company_id = p_company_id
            and paid_item.workforce_id = v_workforce_id
            and paid_item.period_start = p_period_start
            and paid_item.period_end = p_period_end
            and paid_item.status = 'paid'
          group by allocation.station_id
        )
        select current_station.*,
          coalesce(paid_allocation.paid_amount, 0)::numeric(14,2) as paid_amount,
          round(
            current_station.net_amount - coalesce(paid_allocation.paid_amount, 0), 2
          )::numeric(14,2) as instruction_amount
        from current_stations current_station
        left join paid_allocations paid_allocation
          on paid_allocation.station_id = current_station.station_id
        where round(
          current_station.net_amount - coalesce(paid_allocation.paid_amount, 0), 2
        ) > 0
        order by current_station.station_code,
          current_station.station_id, current_station.publication_id
      loop
        v_next_version := v_next_version + 1;
        v_version := v_next_version;
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
          v_station.station_id, v_station.station_code,
          'NET PAY', v_station.station_code,
          v_station.net_amount, v_station.paid_amount, v_station.instruction_amount,
          'processing'
        ) returning id into v_item_id;

        insert into public.workforce_payout_payment_allocations (
          company_id, payment_item_id, publication_id, station_id, revision,
          mapping_relock_id, snapshot_hash, station_code_snapshot,
          net_amount_snapshot, instruction_amount_snapshot
        ) values (
          p_company_id, v_item_id, v_station.publication_id,
          v_station.station_id, v_station.revision,
          v_station.mapping_relock_id, v_station.snapshot_hash,
          v_station.station_code, v_station.net_amount,
          v_station.instruction_amount
        );

        insert into public.workforce_payout_payment_events (
          company_id, batch_id, payment_item_id, event_type, event_data, actor_user_id
        ) values (
          p_company_id, v_batch_id, v_item_id, 'payment_instruction_created',
          jsonb_build_object(
            'reference_no', v_reference,
            'payment_version', v_version,
            'current_target_amount', v_station.net_amount,
            'paid_before_amount', v_station.paid_amount,
            'instruction_amount', v_station.instruction_amount,
            'station_id', v_station.station_id,
            'split_mode', 'station'
          ),
          p_actor_user_id
        );
        v_created_count := v_created_count + 1;
      end loop;
    else
      -- Signed station totals, unreconciled legacy allocation evidence, or a
      -- paise mismatch are deliberately kept as one profile-level instruction.
      -- That retains every deduction and prevents a partial overpayment.
      v_next_version := v_next_version + 1;
      v_version := v_next_version;
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
        v_location_id, v_location_code,
        'NET PAY', v_location_code,
        v_target, v_paid, v_instruction,
        'processing'
      ) returning id into v_item_id;

      insert into public.workforce_payout_payment_allocations (
        company_id, payment_item_id, publication_id, station_id, revision,
        mapping_relock_id, snapshot_hash, station_code_snapshot,
        net_amount_snapshot, instruction_amount_snapshot
      )
      with source_rows as (
        select
          (publication ->> 'publication_id')::uuid as publication_id,
          (publication ->> 'station_id')::uuid as station_id,
          (publication ->> 'revision')::integer as revision,
          nullif(publication ->> 'mapping_relock_id', '')::uuid as mapping_relock_id,
          publication ->> 'snapshot_hash' as snapshot_hash,
          publication ->> 'station_code' as station_code,
          (publication ->> 'net_amount')::numeric(14,2) as net_amount,
          greatest((publication ->> 'net_amount')::numeric, 0) as weight
        from jsonb_array_elements(v_publications) publication
      ), weighted as (
        select source_rows.*,
          sum(weight) over () as total_weight,
          row_number() over (
            order by case when weight > 0 then 0 else 1 end, station_id, publication_id
          ) as allocation_rank
        from source_rows
      ), floored as (
        select weighted.*,
          floor(
            round(v_instruction * 100, 0)
            * weight / nullif(total_weight, 0)
          ) as base_cents
        from weighted
      ), allocated as (
        select floored.*,
          round(v_instruction * 100, 0) - sum(base_cents) over () as remaining_cents
        from floored
      )
      select
        p_company_id,
        v_item_id,
        allocated.publication_id,
        allocated.station_id,
        allocated.revision,
        allocated.mapping_relock_id,
        allocated.snapshot_hash,
        allocated.station_code,
        allocated.net_amount,
        (
          allocated.base_cents
          + case when allocated.allocation_rank <= allocated.remaining_cents then 1 else 0 end
        ) / 100
      from allocated;

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
          'split_mode', 'consolidated'
        ),
        p_actor_user_id
      );
      v_created_count := v_created_count + 1;
    end if;$creator_new$;
begin
  select pg_get_functiondef(
    'public.workforce_create_payout_payment_batch(uuid,uuid,uuid,text,uuid,date,date,date,uuid[])'::regprocedure
  ) into v_definition;
  v_definition := replace(v_definition, chr(13), '');

  if position('''split_mode'', ''station''' in v_definition) > 0 then
    return;
  end if;
  if position(v_declaration_marker in v_definition) = 0 then
    raise exception 'Unexpected Workforce bank batch declaration structure; station split was not applied.';
  end if;
  v_start := position(v_start_marker in v_definition);
  if v_start = 0 then
    raise exception 'The Workforce bank item-creation start marker is unavailable.';
  end if;
  v_end_offset := position(v_end_marker in substring(v_definition from v_start));
  if v_end_offset = 0 then
    raise exception 'The Workforce bank item-creation end marker is unavailable.';
  end if;

  v_definition := replace(
    v_definition, v_declaration_marker, v_declaration_new
  );
  -- Recalculate offsets after the declaration replacement changed the text
  -- length before the item-creation block.
  v_start := position(v_start_marker in v_definition);
  v_end_offset := position(v_end_marker in substring(v_definition from v_start));
  v_definition := overlay(
    v_definition placing v_new_block
    from v_start
    for v_end_offset + length(v_end_marker) - 1
  );
  execute v_definition;
end
$patch$;

comment on function public.workforce_payout_payment_candidates(uuid, date, date, uuid[]) is
  'Canonical service-only bank candidate calculator. Only live Active Workforce profiles qualify. Processing previews retain the immutable full profile target across station-line partial finalization.';
comment on function public.workforce_create_payout_payment_batch(
  uuid, uuid, uuid, text, uuid, date, date, date, uuid[]
) is
  'Atomically creates station-level bank instructions when signed publication deltas reconcile exactly to paid allocation evidence; otherwise creates one safe consolidated profile instruction. Only Active Workforce profiles qualify.';

revoke all on function public.guard_workforce_payout_payment_item_ledger()
  from public, anon, authenticated, service_role;
revoke all on function public.workforce_payout_payment_candidates(uuid, date, date, uuid[])
  from public, anon, authenticated, service_role;
revoke all on function public.workforce_create_payout_payment_batch(
  uuid, uuid, uuid, text, uuid, date, date, date, uuid[]
) from public, anon, authenticated;
grant execute on function public.workforce_create_payout_payment_batch(
  uuid, uuid, uuid, text, uuid, date, date, date, uuid[]
) to service_role;

notify pgrst, 'reload schema';

commit;
