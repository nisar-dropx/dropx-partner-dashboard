begin;

-- Attendance and shipment facts already advance the month-scoped dependency
-- revision. Published payout snapshots are immutable, however, so the revision
-- alone cannot make a corrected fact visible in the payment ledger. Resolve
-- each changed fact to its canonical Workforce/location publication and queue
-- the established immutable-publication refresh flow.

create or replace function public.workforce_payout_method_uses_attendance(
  p_company_id uuid,
  p_payment_method_id uuid,
  p_component_snapshot jsonb default null
)
returns boolean
language sql
stable
set search_path = ''
as $function$
  select case
    when jsonb_typeof(p_component_snapshot) = 'array'
      and jsonb_array_length(p_component_snapshot) > 0
    then exists (
      select 1
      from jsonb_array_elements(p_component_snapshot) component(value)
      where lower(coalesce(component.value ->> 'component_type', '')) <> 'production'
        and lower(coalesce(component.value ->> 'calculation_source', '')) = 'attendance_eligibility'
    )
    else exists (
      select 1
      from public.payment_method_components component
      join public.payment_fields field
        on field.id = component.payment_field_id
       and field.company_id = p_company_id
      where component.payment_method_id = p_payment_method_id
        and component.is_active
        and lower(coalesce(field.field_type, component.component_type, '')) <> 'production'
        and lower(coalesce(field.calculation_source, '')) = 'attendance_eligibility'
    )
  end;
$function$;

create or replace function public.enqueue_workforce_payout_attendance_fact_refresh(
  p_rows jsonb,
  p_backfill boolean default false
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_request_id uuid := md5(
    'workforce_payout_dependency:' || txid_current()::text
  )::uuid;
  v_inserted integer := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    return 0;
  end if;

  with changed as (
    select
      item.ordinality::bigint as change_id,
      row_data.company_id,
      row_data.workforce_id,
      row_data.employee_id,
      row_data.contractor_id,
      row_data.field_executive_id,
      row_data.enrolment_id,
      row_data.punch_date,
      row_data.updated_at as changed_at
    from jsonb_array_elements(p_rows) with ordinality item(value, ordinality)
    cross join lateral jsonb_to_record(item.value) as row_data(
      company_id uuid,
      workforce_id uuid,
      employee_id uuid,
      contractor_id uuid,
      field_executive_id uuid,
      enrolment_id text,
      punch_date date,
      updated_at timestamptz
    )
    where row_data.company_id is not null
      and row_data.punch_date is not null
  ), resolved as (
    select distinct
      changed.change_id,
      changed.company_id,
      worker.id as workforce_id,
      changed.punch_date,
      changed.changed_at
    from changed
    join public.workforce worker
      on worker.company_id = changed.company_id
     and worker.deleted_at is null
     and worker.migration_state is distinct from 'reclassified'
     and (
       (changed.workforce_id is not null and worker.id = changed.workforce_id)
       or (
         changed.workforce_id is null
         and (
           (changed.employee_id is not null
             and worker.source_profile_type = 'employee'
             and worker.source_profile_id = changed.employee_id)
           or (changed.contractor_id is not null
             and worker.source_profile_type = 'contractor'
             and worker.source_profile_id = changed.contractor_id)
           or (changed.field_executive_id is not null and (
             worker.id = changed.field_executive_id
             or (worker.source_profile_type = 'field_executive'
               and worker.source_profile_id = changed.field_executive_id)
           ))
           or (
             nullif(btrim(changed.enrolment_id), '') is not null
             and nullif(btrim(worker.biometric_id), '') is not null
             and coalesce(nullif(ltrim(btrim(worker.biometric_id), '0'), ''), '0')
               = coalesce(nullif(ltrim(btrim(changed.enrolment_id), '0'), ''), '0')
           )
         )
       )
     )
  ), provider_ranked as (
    select
      resolved.*,
      mapping.station_id,
      row_number() over (
        partition by resolved.change_id, resolved.workforce_id
        order by mapping.effective_from desc, mapping.id desc
      ) as mapping_order
    from resolved
    join public.field_executive_provider_mappings mapping
      on mapping.company_id = resolved.company_id
     and mapping.status in ('active', 'closed')
     and mapping.payment_method_id is not null
     and mapping.effective_from <= resolved.punch_date
     and coalesce(mapping.effective_to, resolved.punch_date) >= resolved.punch_date
     and (
       (mapping.workforce_id is not null and mapping.workforce_id = resolved.workforce_id)
       or (
         mapping.workforce_id is null
         and exists (
           select 1
           from public.workforce worker
           where worker.company_id = mapping.company_id
             and worker.id = resolved.workforce_id
             and (
               (mapping.employee_id is not null
                 and worker.source_profile_type = 'employee'
                 and worker.source_profile_id = mapping.employee_id)
               or (mapping.contractor_id is not null
                 and worker.source_profile_type = 'contractor'
                 and worker.source_profile_id = mapping.contractor_id)
               or (mapping.field_executive_id is not null and (
                 worker.id = mapping.field_executive_id
                 or (worker.source_profile_type = 'field_executive'
                   and worker.source_profile_id = mapping.field_executive_id)
               ))
             )
         )
       )
     )
     and public.workforce_payout_method_uses_attendance(
       mapping.company_id,
       mapping.payment_method_id,
       null
     )
  ), provider_targets as (
    select
      company_id, workforce_id, station_id, punch_date, changed_at
    from provider_ranked
    where mapping_order = 1
  ), direct_targets as (
    select distinct
      resolved.company_id,
      resolved.workforce_id,
      allocation.station_id,
      resolved.punch_date,
      resolved.changed_at
    from resolved
    join public.workforce_payment_allocations allocation
      on allocation.company_id = resolved.company_id
     and allocation.workforce_id = resolved.workforce_id
     and allocation.status in ('active', 'closed')
     and allocation.effective_from <= resolved.punch_date
     and coalesce(allocation.effective_to, resolved.punch_date) >= resolved.punch_date
     and public.workforce_payout_method_uses_attendance(
       allocation.company_id,
       allocation.payment_method_id,
       allocation.payment_components
     )
  ), targets as (
    select * from provider_targets
    union
    select * from direct_targets
  ), publication_candidates as (
    select
      publication.*,
      target.changed_at
    from targets target
    join public.workforce_payout_publications publication
      on publication.company_id = target.company_id
     and publication.publication_kind = 'worksheet'
     and publication.workforce_id = target.workforce_id
     and publication.station_id = target.station_id
     and target.punch_date >= date_trunc('month', publication.period_start)::date
     and target.punch_date <= publication.period_end
  ), latest as (
    select distinct on (
      candidate.company_id, candidate.workforce_id, candidate.station_id,
      candidate.period_start, candidate.period_end
    )
      candidate.*
    from publication_candidates candidate
    order by candidate.company_id, candidate.workforce_id, candidate.station_id,
      candidate.period_start, candidate.period_end,
      candidate.revision desc, candidate.published_at desc, candidate.id desc,
      candidate.changed_at desc nulls last
  )
  insert into public.workforce_payout_publication_refresh_jobs (
    company_id,
    input_batch_id,
    refresh_source,
    refresh_request_id,
    workforce_id,
    station_id,
    period_start,
    period_end,
    base_publication_id,
    base_revision,
    requested_by,
    next_attempt_at
  )
  select
    latest.company_id,
    null,
    'payout_dependency',
    v_request_id,
    latest.workforce_id,
    latest.station_id,
    latest.period_start,
    latest.period_end,
    latest.id,
    latest.revision,
    latest.published_by,
    clock_timestamp()
  from latest
  where (
      not p_backfill
      or (latest.changed_at is not null and latest.changed_at > latest.published_at)
    )
    and (
      not p_backfill
      or not exists (
        select 1
        from public.workforce_payout_publication_refresh_jobs open_job
        where open_job.company_id = latest.company_id
          and open_job.workforce_id = latest.workforce_id
          and open_job.station_id = latest.station_id
          and open_job.period_start = latest.period_start
          and open_job.period_end = latest.period_end
          and open_job.status in ('pending', 'processing')
      )
    )
  on conflict (
    company_id, refresh_request_id, workforce_id, station_id,
    period_start, period_end
  ) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end
$function$;

create or replace function public.enqueue_workforce_payout_shipment_fact_refresh(
  p_rows jsonb,
  p_backfill boolean default false
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_request_id uuid := md5(
    'workforce_payout_dependency:' || txid_current()::text
  )::uuid;
  v_inserted integer := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    return 0;
  end if;

  with changed as (
    select
      item.ordinality::bigint as change_id,
      row_data.company_id,
      row_data.client,
      row_data.work_date,
      row_data.station_code,
      row_data.provider_employee_id,
      row_data.updated_at as changed_at
    from jsonb_array_elements(p_rows) with ordinality item(value, ordinality)
    cross join lateral jsonb_to_record(item.value) as row_data(
      company_id uuid,
      client text,
      work_date date,
      station_code text,
      provider_employee_id text,
      updated_at timestamptz
    )
    where row_data.company_id is not null
      and row_data.work_date is not null
      and nullif(regexp_replace(upper(btrim(coalesce(row_data.station_code, ''))), '[^A-Z0-9]', '', 'g'), '') is not null
      and nullif(regexp_replace(upper(btrim(coalesce(row_data.provider_employee_id, ''))), '[^A-Z0-9]', '', 'g'), '') is not null
  ), targets as (
    select distinct
      changed.company_id,
      worker.id as workforce_id,
      mapping.station_id,
      changed.work_date,
      changed.changed_at
    from changed
    join public.stations station
      on station.company_id = changed.company_id
     and regexp_replace(upper(btrim(coalesce(station.station_code, ''))), '[^A-Z0-9]', '', 'g')
       = regexp_replace(upper(btrim(coalesce(changed.station_code, ''))), '[^A-Z0-9]', '', 'g')
    join public.field_executive_provider_mappings mapping
      on mapping.company_id = changed.company_id
     and mapping.station_id = station.id
     and mapping.status in ('active', 'closed')
     and mapping.effective_from <= changed.work_date
     and coalesce(mapping.effective_to, changed.work_date) >= changed.work_date
     and regexp_replace(upper(btrim(coalesce(mapping.provider_member_id, ''))), '[^A-Z0-9]', '', 'g')
       = regexp_replace(upper(btrim(coalesce(changed.provider_employee_id, ''))), '[^A-Z0-9]', '', 'g')
    left join public.providers provider
      on provider.company_id = mapping.company_id
     and provider.id = mapping.provider_id
    join public.workforce worker
      on worker.company_id = mapping.company_id
     and worker.deleted_at is null
     and worker.migration_state is distinct from 'reclassified'
     and (
       (mapping.workforce_id is not null and worker.id = mapping.workforce_id)
       or (
         mapping.workforce_id is null
         and (
           (mapping.employee_id is not null
             and worker.source_profile_type = 'employee'
             and worker.source_profile_id = mapping.employee_id)
           or (mapping.contractor_id is not null
             and worker.source_profile_type = 'contractor'
             and worker.source_profile_id = mapping.contractor_id)
           or (mapping.field_executive_id is not null and (
             worker.id = mapping.field_executive_id
             or (worker.source_profile_type = 'field_executive'
               and worker.source_profile_id = mapping.field_executive_id)
           ))
         )
       )
     )
    where nullif(regexp_replace(upper(btrim(coalesce(changed.client, ''))), '[^A-Z0-9]', '', 'g'), '') is null
      or regexp_replace(
        upper(btrim(concat_ws(' ', nullif(provider.code, ''), nullif(provider.name, '')))),
        '[^A-Z0-9]', '', 'g'
      ) like '%' || regexp_replace(
        upper(btrim(coalesce(changed.client, ''))), '[^A-Z0-9]', '', 'g'
      ) || '%'
  ), publication_candidates as (
    select
      publication.*,
      target.changed_at
    from targets target
    join public.workforce_payout_publications publication
      on publication.company_id = target.company_id
     and publication.publication_kind = 'worksheet'
     and publication.workforce_id = target.workforce_id
     and publication.station_id = target.station_id
     and target.work_date >= date_trunc('month', publication.period_start)::date
     and target.work_date <= publication.period_end
  ), latest as (
    select distinct on (
      candidate.company_id, candidate.workforce_id, candidate.station_id,
      candidate.period_start, candidate.period_end
    )
      candidate.*
    from publication_candidates candidate
    order by candidate.company_id, candidate.workforce_id, candidate.station_id,
      candidate.period_start, candidate.period_end,
      candidate.revision desc, candidate.published_at desc, candidate.id desc,
      candidate.changed_at desc nulls last
  )
  insert into public.workforce_payout_publication_refresh_jobs (
    company_id,
    input_batch_id,
    refresh_source,
    refresh_request_id,
    workforce_id,
    station_id,
    period_start,
    period_end,
    base_publication_id,
    base_revision,
    requested_by,
    next_attempt_at
  )
  select
    latest.company_id,
    null,
    'payout_dependency',
    v_request_id,
    latest.workforce_id,
    latest.station_id,
    latest.period_start,
    latest.period_end,
    latest.id,
    latest.revision,
    latest.published_by,
    clock_timestamp()
  from latest
  where (
      not p_backfill
      or (latest.changed_at is not null and latest.changed_at > latest.published_at)
    )
    and (
      not p_backfill
      or not exists (
        select 1
        from public.workforce_payout_publication_refresh_jobs open_job
        where open_job.company_id = latest.company_id
          and open_job.workforce_id = latest.workforce_id
          and open_job.station_id = latest.station_id
          and open_job.period_start = latest.period_start
          and open_job.period_end = latest.period_end
          and open_job.status in ('pending', 'processing')
      )
    )
  on conflict (
    company_id, refresh_request_id, workforce_id, station_id,
    period_start, period_end
  ) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end
$function$;

create or replace function public.queue_workforce_payout_attendance_fact_refresh()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_rows jsonb;
begin
  if tg_op = 'INSERT' then
    select coalesce(jsonb_agg(to_jsonb(row_data)), '[]'::jsonb)
    into v_rows
    from workforce_payout_fact_new_rows row_data;
  elsif tg_op = 'DELETE' then
    select coalesce(jsonb_agg(to_jsonb(row_data)), '[]'::jsonb)
    into v_rows
    from workforce_payout_fact_old_rows row_data;
  else
    with changed_ids as (
      select coalesce(old_row.id, new_row.id) as id
      from workforce_payout_fact_old_rows old_row
      full join workforce_payout_fact_new_rows new_row using (id)
      where row(
        old_row.company_id, old_row.workforce_id, old_row.employee_id,
        old_row.contractor_id, old_row.field_executive_id, old_row.enrolment_id,
        old_row.punch_date, old_row.status, old_row.in_time, old_row.out_time,
        old_row.work_minutes, old_row.punch_count
      ) is distinct from row(
        new_row.company_id, new_row.workforce_id, new_row.employee_id,
        new_row.contractor_id, new_row.field_executive_id, new_row.enrolment_id,
        new_row.punch_date, new_row.status, new_row.in_time, new_row.out_time,
        new_row.work_minutes, new_row.punch_count
      )
    ), payload as (
      select to_jsonb(old_row) as value
      from workforce_payout_fact_old_rows old_row
      join changed_ids changed on changed.id = old_row.id
      union all
      select to_jsonb(new_row) as value
      from workforce_payout_fact_new_rows new_row
      join changed_ids changed on changed.id = new_row.id
    )
    select coalesce(jsonb_agg(payload.value), '[]'::jsonb)
    into v_rows
    from payload;
  end if;

  perform public.enqueue_workforce_payout_attendance_fact_refresh(v_rows, false);
  return null;
end
$function$;

create or replace function public.queue_workforce_payout_shipment_fact_refresh()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_rows jsonb;
begin
  if tg_op = 'INSERT' then
    select coalesce(jsonb_agg(to_jsonb(row_data)), '[]'::jsonb)
    into v_rows
    from workforce_payout_fact_new_rows row_data;
  elsif tg_op = 'DELETE' then
    select coalesce(jsonb_agg(to_jsonb(row_data)), '[]'::jsonb)
    into v_rows
    from workforce_payout_fact_old_rows row_data;
  else
    with changed_ids as (
      select coalesce(old_row.id, new_row.id) as id
      from workforce_payout_fact_old_rows old_row
      full join workforce_payout_fact_new_rows new_row using (id)
      where row(
        old_row.company_id, old_row.client, old_row.work_date,
        old_row.station_code, old_row.provider_employee_id,
        old_row.amazon_delivery, old_row.swa_delivery, old_row.total_delivery,
        old_row.c_return, old_row.mfn, old_row.mfn_return
      ) is distinct from row(
        new_row.company_id, new_row.client, new_row.work_date,
        new_row.station_code, new_row.provider_employee_id,
        new_row.amazon_delivery, new_row.swa_delivery, new_row.total_delivery,
        new_row.c_return, new_row.mfn, new_row.mfn_return
      )
    ), payload as (
      select to_jsonb(old_row) as value
      from workforce_payout_fact_old_rows old_row
      join changed_ids changed on changed.id = old_row.id
      union all
      select to_jsonb(new_row) as value
      from workforce_payout_fact_new_rows new_row
      join changed_ids changed on changed.id = new_row.id
    )
    select coalesce(jsonb_agg(payload.value), '[]'::jsonb)
    into v_rows
    from payload;
  end if;

  perform public.enqueue_workforce_payout_shipment_fact_refresh(v_rows, false);
  return null;
end
$function$;

drop trigger if exists attendance_daily_90_queue_payout_publication_refresh
  on public.attendance_daily;
create trigger attendance_daily_90_queue_payout_publication_refresh
after insert on public.attendance_daily
referencing new table as workforce_payout_fact_new_rows
for each statement execute function public.queue_workforce_payout_attendance_fact_refresh();

drop trigger if exists attendance_daily_91_queue_payout_publication_refresh
  on public.attendance_daily;
create trigger attendance_daily_91_queue_payout_publication_refresh
after update on public.attendance_daily
referencing old table as workforce_payout_fact_old_rows
  new table as workforce_payout_fact_new_rows
for each statement execute function public.queue_workforce_payout_attendance_fact_refresh();

drop trigger if exists attendance_daily_92_queue_payout_publication_refresh
  on public.attendance_daily;
create trigger attendance_daily_92_queue_payout_publication_refresh
after delete on public.attendance_daily
referencing old table as workforce_payout_fact_old_rows
for each statement execute function public.queue_workforce_payout_attendance_fact_refresh();

drop trigger if exists cps_shipment_daily_90_queue_payout_publication_refresh
  on public.cps_shipment_daily;
create trigger cps_shipment_daily_90_queue_payout_publication_refresh
after insert on public.cps_shipment_daily
referencing new table as workforce_payout_fact_new_rows
for each statement execute function public.queue_workforce_payout_shipment_fact_refresh();

drop trigger if exists cps_shipment_daily_91_queue_payout_publication_refresh
  on public.cps_shipment_daily;
create trigger cps_shipment_daily_91_queue_payout_publication_refresh
after update on public.cps_shipment_daily
referencing old table as workforce_payout_fact_old_rows
  new table as workforce_payout_fact_new_rows
for each statement execute function public.queue_workforce_payout_shipment_fact_refresh();

drop trigger if exists cps_shipment_daily_92_queue_payout_publication_refresh
  on public.cps_shipment_daily;
create trigger cps_shipment_daily_92_queue_payout_publication_refresh
after delete on public.cps_shipment_daily
referencing old table as workforce_payout_fact_old_rows
for each statement execute function public.queue_workforce_payout_shipment_fact_refresh();

-- A fact correction is allowed to queue while a bank instruction is frozen,
-- but must not be claimed until that instruction becomes terminal. This keeps
-- the immutable publication current immediately after finalization/cancellation
-- without ever changing the target under an in-flight bank file.
do $patch_refresh_claimants$
declare
  v_signature regprocedure;
  v_definition text;
  v_marker text := E'and job.claim_attempts < job.max_attempts\n';
  v_replacement text := E'and job.claim_attempts < job.max_attempts\n      and not public.workforce_payout_payment_is_processing(\n        job.company_id, job.workforce_id, job.period_start, job.period_end\n      )\n      ';
  v_signatures regprocedure[] := array[
    'public.workforce_claim_payout_publication_refresh_jobs(integer,uuid,uuid)'::regprocedure,
    'public.workforce_claim_selected_payout_publication_refresh_jobs(integer,uuid,uuid[],date,date)'::regprocedure,
    'public.workforce_claim_selected_payout_publication_row_refresh_jobs(integer,uuid,jsonb,date,date)'::regprocedure
  ];
begin
  foreach v_signature in array v_signatures
  loop
    select replace(pg_get_functiondef(v_signature), chr(13), '')
    into v_definition;
    if position(v_marker in v_definition) = 0 then
      raise exception 'Unexpected payout refresh claimant definition in %.', v_signature::text;
    end if;
    v_definition := replace(v_definition, v_marker, v_replacement);
    execute v_definition;
  end loop;
end
$patch_refresh_claimants$;

-- The transactional candidate calculator intentionally stops before reading
-- the ledger while an immutable publication refresh is unfinished. Keep that
-- fail-closed behavior for bank creation, but enrich the read-only preview so
-- the worksheet does not hide already-paid or in-flight station amounts and
-- operators retain the exact processing cancellation/re-download actions.
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
  with candidates as materialized (
    select candidate.*
    from public.workforce_payout_payment_row_candidates(
      p_company_id, p_period_start, p_period_end, p_rows
    ) candidate
  ), pending_rows as (
    select candidate.workforce_id, candidate.station_id
    from candidates candidate
    where candidate.eligibility_code = 'publication_refresh_pending'
  ), ledger_entries as (
    select
      effective.credited_workforce_id as workforce_id,
      effective.station_id,
      effective.payment_item_id,
      'paid'::text as status,
      round(sum(effective.instruction_amount_snapshot), 2) as amount
    from public.workforce_payout_effective_paid_allocations effective
    join pending_rows pending
      on pending.workforce_id = effective.credited_workforce_id
     and pending.station_id = effective.station_id
    where effective.company_id = p_company_id
      and effective.period_start = p_period_start
      and effective.period_end = p_period_end
    group by effective.credited_workforce_id, effective.station_id,
      effective.payment_item_id

    union all

    select
      item.workforce_id,
      allocation.station_id,
      item.id as payment_item_id,
      item.status,
      round(sum(allocation.instruction_amount_snapshot), 2) as amount
    from public.workforce_payout_payment_items item
    join public.workforce_payout_payment_allocations allocation
      on allocation.company_id = item.company_id
     and allocation.payment_item_id = item.id
    join pending_rows pending
      on pending.workforce_id = item.workforce_id
     and pending.station_id = allocation.station_id
    where item.company_id = p_company_id
      and item.period_start = p_period_start
      and item.period_end = p_period_end
      and item.status <> 'paid'
    group by item.workforce_id, allocation.station_id, item.id, item.status
  ), processing_profiles as (
    select distinct item.workforce_id
    from public.workforce_payout_payment_items item
    join pending_rows pending
      on pending.workforce_id = item.workforce_id
    where item.company_id = p_company_id
      and item.period_start = p_period_start
      and item.period_end = p_period_end
      and item.status = 'processing'
  ), ledger as (
    select
      entry.workforce_id,
      entry.station_id,
      round(coalesce(sum(entry.amount) filter (where entry.status = 'paid'), 0), 2)
        as paid_amount,
      round(coalesce(sum(entry.amount) filter (where entry.status = 'processing'), 0), 2)
        as processing_amount,
      count(distinct entry.payment_item_id)::integer as history_count
    from ledger_entries entry
    group by entry.workforce_id, entry.station_id
  )
  select
    candidate.workforce_id,
    candidate.station_id,
    candidate.dropx_id,
    candidate.current_target_amount,
    case when candidate.eligibility_code = 'publication_refresh_pending'
      then coalesce(ledger.paid_amount, 0)::numeric(14,2)
      else candidate.paid_amount
    end,
    case when candidate.eligibility_code = 'publication_refresh_pending'
      then coalesce(ledger.processing_amount, 0)::numeric(14,2)
      else candidate.processing_amount
    end,
    candidate.balance_payable,
    candidate.available_to_pay,
    case when candidate.eligibility_code = 'publication_refresh_pending'
      then coalesce(ledger.history_count, 0)
      else candidate.history_count
    end,
    case
      when candidate.eligibility_code = 'publication_refresh_pending'
        and processing_profile.workforce_id is not null
      then 'Payment Processing'
      else candidate.payment_status
    end,
    candidate.eligible,
    candidate.eligibility_code,
    candidate.eligibility_message
  from candidates candidate
  left join ledger
    on ledger.workforce_id = candidate.workforce_id
   and ledger.station_id = candidate.station_id
  left join processing_profiles processing_profile
    on processing_profile.workforce_id = candidate.workforce_id
  order by candidate.workforce_id, candidate.station_id;
$function$;

revoke all on function public.workforce_preview_payout_payment_rows(uuid, date, date, jsonb)
  from public, anon, authenticated;
grant execute on function public.workforce_preview_payout_payment_rows(uuid, date, date, jsonb)
  to service_role;

-- Repair presently identifiable stale snapshots in bounded chunks. Current
-- rows carry updated_at, so changes made after the latest publication can be
-- queued exactly. Historical deletes cannot be reconstructed safely and are
-- intentionally left to normal republish/review rather than company-wide
-- blanket refreshes.
do $backfill_fact_refresh$
declare
  v_rows jsonb;
begin
  for v_rows in
    select jsonb_agg(to_jsonb(batch_row) order by batch_row.id)
    from (
      select attendance.*,
        ((row_number() over (
          partition by attendance.company_id, date_trunc('month', attendance.punch_date)
          order by attendance.id
        ) - 1) / 500)::integer as batch_no
      from public.attendance_daily attendance
      where attendance.updated_at is not null
        and exists (
          select 1
          from public.workforce_payout_publications publication
          where publication.company_id = attendance.company_id
            and publication.publication_kind = 'worksheet'
            and attendance.punch_date >= date_trunc('month', publication.period_start)::date
            and attendance.punch_date <= publication.period_end
            and attendance.updated_at > publication.published_at
        )
    ) batch_row
    group by batch_row.company_id, date_trunc('month', batch_row.punch_date), batch_row.batch_no
  loop
    perform public.enqueue_workforce_payout_attendance_fact_refresh(v_rows, true);
  end loop;

  for v_rows in
    select jsonb_agg(to_jsonb(batch_row) order by batch_row.id)
    from (
      select shipment.*,
        ((row_number() over (
          partition by shipment.company_id, date_trunc('month', shipment.work_date)
          order by shipment.id
        ) - 1) / 500)::integer as batch_no
      from public.cps_shipment_daily shipment
      where shipment.updated_at is not null
        and exists (
          select 1
          from public.workforce_payout_publications publication
          where publication.company_id = shipment.company_id
            and publication.publication_kind = 'worksheet'
            and shipment.work_date >= date_trunc('month', publication.period_start)::date
            and shipment.work_date <= publication.period_end
            and shipment.updated_at > publication.published_at
        )
    ) batch_row
    group by batch_row.company_id, date_trunc('month', batch_row.work_date), batch_row.batch_no
  loop
    perform public.enqueue_workforce_payout_shipment_fact_refresh(v_rows, true);
  end loop;
end
$backfill_fact_refresh$;

comment on function public.enqueue_workforce_payout_attendance_fact_refresh(jsonb, boolean) is
  'Queues exact immutable Workforce/location publication refreshes for changed biometric attendance facts.';
comment on function public.enqueue_workforce_payout_shipment_fact_refresh(jsonb, boolean) is
  'Queues exact immutable Workforce/location publication refreshes for changed mapped shipment facts.';

revoke all on function
  public.workforce_payout_method_uses_attendance(uuid, uuid, jsonb),
  public.enqueue_workforce_payout_attendance_fact_refresh(jsonb, boolean),
  public.enqueue_workforce_payout_shipment_fact_refresh(jsonb, boolean),
  public.queue_workforce_payout_attendance_fact_refresh(),
  public.queue_workforce_payout_shipment_fact_refresh()
from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
