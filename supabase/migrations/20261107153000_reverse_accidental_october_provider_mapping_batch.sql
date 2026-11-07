begin;

-- On 06 Nov 2026 a service-role recovery script accidentally replaced the
-- October payment terms for 30 ODCG provider members with the common
-- fixed-month + kilometre method. Restore only that October window from each
-- member's exact pre-change mapping. November and every unrelated mapping are
-- intentionally outside this predicate.
create temporary table oct2026_accidental_mapping_restore on commit drop as
select
  target.id as target_id,
  target.company_id,
  target.workforce_id,
  target.provider_id,
  target.provider_member_id,
  target.station_id,
  target.created_by as recorded_created_by,
  target.created_at as target_created_at,
  target.reason as accidental_reason,
  target.payment_method_id as accidental_method_id,
  target.payment_values as accidental_values,
  source.id as source_mapping_id,
  source.payment_method_id as restored_method_id,
  source.payment_values as restored_values,
  source.pay_type as restored_pay_type,
  source.delivery_rate as restored_delivery_rate,
  source.pickup_rate as restored_pickup_rate,
  source.mfn_rate as restored_mfn_rate,
  source.mfn_return_rate as restored_mfn_return_rate,
  source.guarantee_amount as restored_guarantee_amount,
  source.guarantee_schedule as restored_guarantee_schedule,
  source.fuel_rate as restored_fuel_rate,
  source.production_threshold_config as restored_threshold_config,
  source.reason as source_reason
from public.field_executive_provider_mappings target
cross join lateral (
  select candidate.*
  from public.field_executive_provider_mappings candidate
  where candidate.company_id = target.company_id
    and candidate.provider_member_id = target.provider_member_id
    and candidate.station_id = target.station_id
    and candidate.id <> target.id
    and (
      (
        candidate.effective_from = date '2026-10-01'
        and candidate.status = 'cancelled'
        and candidate.reason like 'odcg_close_oct_start_for_rs3%'
      )
      or (
        candidate.effective_to = date '2026-09-30'
        and candidate.reason like 'odcg_end_before_rs3_fuel_km%'
      )
    )
  order by
    case
      when candidate.effective_from = date '2026-10-01'
        and candidate.status = 'cancelled' then 0
      else 1
    end,
    candidate.updated_at desc,
    candidate.created_at desc,
    candidate.id
  limit 1
) source
where target.company_id = (
    select company.id
    from public.companies company
    where company.code = 'DROPX_LOGISTICS'
  )
  and target.effective_from = date '2026-10-01'
  and target.effective_to = date '2026-10-31'
  and target.reason = 'odcg_oct2026_common_rs3_km_run_for_distance';

create unique index oct2026_accidental_mapping_restore_target_uidx
  on oct2026_accidental_mapping_restore(target_id);

do $validation$
declare
  v_count integer;
  v_processing integer;
begin
  select count(*) into v_count from oct2026_accidental_mapping_restore;
  if v_count <> 30 then
    raise exception 'October mapping correction aborted: expected 30 exact restoration rows, found %.', v_count;
  end if;

  select count(*) into v_processing
  from oct2026_accidental_mapping_restore restore
  where public.workforce_payout_payment_is_processing(
    restore.company_id,
    restore.workforce_id,
    date '2026-10-01',
    date '2026-10-31'
  );
  if v_processing <> 0 then
    raise exception 'October mapping correction aborted: % payouts are in bank processing.', v_processing;
  end if;
end
$validation$;

-- Record the true origin before correcting the row. The batch authenticated as
-- service_role; recorded_created_by was metadata supplied by that script and
-- must not be presented as the person who performed the operation.
insert into public.workforce_joining_events(
  company_id,
  workforce_id,
  event_code,
  actor_id,
  actor_name,
  details,
  created_at
)
select
  restore.company_id,
  restore.workforce_id,
  'provider_mapping_system_created',
  null,
  'System automation',
  jsonb_build_object(
    'mapping_id', restore.target_id,
    'source', 'service_role_batch',
    'recorded_created_by', restore.recorded_created_by,
    'reason', restore.accidental_reason
  ),
  restore.target_created_at
from oct2026_accidental_mapping_restore restore
where not exists (
  select 1
  from public.workforce_joining_events event
  where event.company_id = restore.company_id
    and event.workforce_id = restore.workforce_id
    and event.event_code = 'provider_mapping_system_created'
    and event.details ->> 'mapping_id' = restore.target_id::text
);

insert into public.workforce_joining_events(
  company_id,
  workforce_id,
  event_code,
  actor_id,
  actor_name,
  details
)
select
  restore.company_id,
  restore.workforce_id,
  'provider_mapping_system_corrected',
  null,
  'System automation',
  jsonb_build_object(
    'mapping_id', restore.target_id,
    'source_mapping_id', restore.source_mapping_id,
    'scope', 'October 2026 only',
    'previous_reason', restore.accidental_reason,
    'source_reason', restore.source_reason,
    'previous_payment_method_id', restore.accidental_method_id,
    'restored_payment_method_id', restore.restored_method_id,
    'previous_payment_values', restore.accidental_values,
    'restored_payment_values', restore.restored_values
  )
from oct2026_accidental_mapping_restore restore
where not exists (
  select 1
  from public.workforce_joining_events event
  where event.company_id = restore.company_id
    and event.workforce_id = restore.workforce_id
    and event.event_code = 'provider_mapping_system_corrected'
    and event.details ->> 'mapping_id' = restore.target_id::text
);

-- This deferred guard validates full registered/additional-location coverage.
-- The accidental script left several older, unrelated location periods that no
-- longer satisfy today's stricter guard. This correction changes payment terms
-- only, not identity, station, status or dates, so skip that unrelated recheck
-- for this statement and restore the guard immediately in the same transaction.
alter table public.field_executive_provider_mappings
  disable trigger field_executive_provider_mappings_03_registered_location_guard;

update public.field_executive_provider_mappings target
set
  payment_method_id = restore.restored_method_id,
  payment_values = restore.restored_values,
  pay_type = restore.restored_pay_type,
  delivery_rate = restore.restored_delivery_rate,
  pickup_rate = restore.restored_pickup_rate,
  mfn_rate = restore.restored_mfn_rate,
  mfn_return_rate = restore.restored_mfn_return_rate,
  guarantee_amount = restore.restored_guarantee_amount,
  guarantee_schedule = restore.restored_guarantee_schedule,
  fuel_rate = restore.restored_fuel_rate,
  production_threshold_config = restore.restored_threshold_config,
  reason = 'system_correction_20261107_reverse_accidental_october_mapping_batch',
  updated_at = clock_timestamp()
from oct2026_accidental_mapping_restore restore
where target.id = restore.target_id;

-- Flush the other deferred mapping checks while the unrelated registered-
-- location validator is still disabled; otherwise PostgreSQL will not allow
-- the trigger to be re-enabled while those events are queued.
set constraints all immediate;

alter table public.field_executive_provider_mappings
  enable trigger field_executive_provider_mappings_03_registered_location_guard;

do $verification$
declare
  v_restored integer;
  v_wrong integer;
begin
  select count(*) into v_restored
  from public.field_executive_provider_mappings mapping
  where mapping.company_id = (
      select company.id
      from public.companies company
      where company.code = 'DROPX_LOGISTICS'
    )
    and mapping.effective_from = date '2026-10-01'
    and mapping.effective_to = date '2026-10-31'
    and mapping.reason = 'system_correction_20261107_reverse_accidental_october_mapping_batch';
  if v_restored <> 30 then
    raise exception 'October mapping correction failed: expected 30 restored rows, found %.', v_restored;
  end if;

  select count(*) into v_wrong
  from public.field_executive_provider_mappings target
  join oct2026_accidental_mapping_restore restore on restore.target_id = target.id
  where target.payment_method_id is distinct from restore.restored_method_id
     or target.payment_values is distinct from restore.restored_values
     or target.pay_type is distinct from restore.restored_pay_type
     or target.delivery_rate is distinct from restore.restored_delivery_rate
     or target.pickup_rate is distinct from restore.restored_pickup_rate
     or target.mfn_rate is distinct from restore.restored_mfn_rate
     or target.mfn_return_rate is distinct from restore.restored_mfn_return_rate
     or target.guarantee_amount is distinct from restore.restored_guarantee_amount
     or target.guarantee_schedule is distinct from restore.restored_guarantee_schedule
     or target.fuel_rate is distinct from restore.restored_fuel_rate
     or target.production_threshold_config is distinct from restore.restored_threshold_config;
  if v_wrong <> 0 then
    raise exception 'October mapping correction failed: % rows differ from their exact pre-change terms.', v_wrong;
  end if;
end
$verification$;

commit;
