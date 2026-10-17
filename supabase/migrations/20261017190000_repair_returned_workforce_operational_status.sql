begin;

set local lock_timeout = '5s';

-- Returning a registration for correction used to disable the operational
-- profile as a side effect. Repair only rows whose immutable request-tracker
-- history proves that exact transition. A current status filter alone is not
-- sufficient because some Returned profiles were already inactive or were
-- legitimately deactivated later.
lock table public.workforce in share row exclusive mode;

create temporary table returned_workforce_operational_repair_targets
on commit drop
as
select distinct on (workforce_profile.id)
  workforce_profile.id,
  workforce_profile.company_id,
  return_event.id::text as return_audit_event_id,
  return_event.recorded_at as return_audit_recorded_at,
  return_event.transaction_id as return_audit_transaction_id
from public.workforce workforce_profile
join public.request_tracker_events return_event
  on return_event.company_id = workforce_profile.company_id
 and return_event.kind = 'workforce_onboarding'
 and return_event.source_table = 'workforce'
 and return_event.source_id = workforce_profile.id::text
 and return_event.source_row_id = workforce_profile.id::text
 and return_event.operation = 'update'
where workforce_profile.is_active is false
  and lower(btrim(coalesce(workforce_profile.onboarding_status, ''))) = 'returned'
  and lower(btrim(coalesce(workforce_profile.lifecycle_status, ''))) = 'onboarding'
  and workforce_profile.deleted_at is null
  and workforce_profile.deactivated_at is null
  and workforce_profile.last_working_date is null
  and return_event.before_data @> '{"is_active": true}'::jsonb
  and return_event.after_data @> '{"is_active": false}'::jsonb
  and lower(btrim(coalesce(return_event.before_data ->> 'onboarding_status', '')))
    in ('under_review', 'returned')
  and lower(btrim(coalesce(return_event.after_data ->> 'onboarding_status', ''))) = 'returned'
  and (
    return_event.changed_fields @> array['is_active', 'profile_returned_at']::text[]
    or (
      -- Five rows were disabled by the superseded 20261015170000 repair.
      -- Use their immutable production audit IDs and company, not the
      -- database-local transaction ID alone, so this branch is a no-op in an
      -- unrelated environment.
      return_event.company_id::text = '43866344-b550-4e8a-9a2d-9d23f3d8a997'
      and return_event.id::text in (
        '6a5c1edc-81d1-4263-b019-1913b7bf2cb3',
        '10a5f7b0-bc9f-4053-b76f-870e2ec54a55',
        '9d4e0541-17bf-4be5-b309-28bf33fc9cbc',
        'c01ac382-9725-4155-bfa1-d9339701001c',
        '06b0282c-c20c-44f6-a8c3-e3940627f7c8'
      )
      and return_event.transaction_id = 18788344
      and lower(btrim(coalesce(return_event.executor, ''))) = 'postgres'
      and lower(btrim(coalesce(return_event.before_data ->> 'onboarding_status', ''))) = 'returned'
      and lower(btrim(coalesce(return_event.after_data ->> 'onboarding_status', ''))) = 'returned'
      and cardinality(return_event.changed_fields) = 2
      and return_event.changed_fields @> array['is_active', 'updated_at']::text[]
      and return_event.changed_fields <@ array['is_active', 'updated_at']::text[]
    )
  )
  and not exists (
    select 1
    from public.request_tracker_events later_status_event
    where later_status_event.company_id = workforce_profile.company_id
      and later_status_event.kind = 'workforce_onboarding'
      and later_status_event.source_table = 'workforce'
      and later_status_event.source_id = workforce_profile.id::text
      and later_status_event.source_row_id = workforce_profile.id::text
      and later_status_event.operation = 'update'
      and later_status_event.changed_fields @> array['is_active']::text[]
      and (
        later_status_event.recorded_at > return_event.recorded_at
        or (
          later_status_event.recorded_at = return_event.recorded_at
          and later_status_event.id <> return_event.id
        )
      )
  )
order by
  workforce_profile.id,
  return_event.recorded_at desc,
  return_event.transaction_id desc,
  return_event.id::text desc;

insert into public.workforce_onboarding_events (
  company_id,
  field_executive_id,
  workforce_id,
  event_code,
  from_status,
  to_status,
  source_portal,
  remarks,
  metadata
)
select
  repair_target.company_id,
  null,
  repair_target.id,
  'returned_operational_status_repaired',
  'returned',
  'returned',
  'system',
  'Restored the operational status that was disabled when registration was returned for correction.',
  jsonb_build_object(
    'reason', 'return_review_changed_operational_status',
    'previous_is_active', false,
    'restored_is_active', true,
    'return_audit_event_id', repair_target.return_audit_event_id,
    'return_audit_recorded_at', repair_target.return_audit_recorded_at,
    'return_audit_transaction_id', repair_target.return_audit_transaction_id,
    'repair_migration', '20261017190000_repair_returned_workforce_operational_status'
  )
from returned_workforce_operational_repair_targets repair_target
where not exists (
  select 1
  from public.workforce_onboarding_events existing_repair
  where existing_repair.workforce_id = repair_target.id
    and existing_repair.event_code = 'returned_operational_status_repaired'
    and existing_repair.metadata ->> 'repair_migration' =
      '20261017190000_repair_returned_workforce_operational_status'
);

update public.workforce workforce_profile
set is_active = true,
    updated_at = clock_timestamp()
from returned_workforce_operational_repair_targets repair_target
where workforce_profile.id = repair_target.id
  and workforce_profile.is_active is false
  and lower(btrim(coalesce(workforce_profile.onboarding_status, ''))) = 'returned'
  and lower(btrim(coalesce(workforce_profile.lifecycle_status, ''))) = 'onboarding'
  and workforce_profile.deleted_at is null
  and workforce_profile.deactivated_at is null
  and workforce_profile.last_working_date is null;

commit;
