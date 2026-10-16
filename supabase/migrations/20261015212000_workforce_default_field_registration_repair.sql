begin;

-- A defaulted or pre-submission profile field is not proof that the person
-- completed registration. In particular, older imports stored
-- `is_handicapped = false` before the final registration submission, which
-- caused the first evidence repair to leave some auto-promoted rows Active.
--
-- Keep the repair limited to approval-managed profiles with known onboarding
-- provenance and no durable submission/review/approval evidence. Operational
-- enablement remains independent and is intentionally preserved.
lock table public.workforce in share row exclusive mode;

create temporary table workforce_default_field_registration_repair_targets
on commit drop
as
select
  workforce_profile.id,
  workforce_profile.company_id,
  workforce_profile.source_profile_type,
  workforce_profile.source_profile_id,
  workforce_profile.onboarding_status as previous_onboarding_status,
  workforce_profile.lifecycle_status as previous_lifecycle_status,
  workforce_profile.is_active as previous_is_active,
  workforce_profile.updated_at as previous_updated_at
from public.workforce workforce_profile
where workforce_profile.is_active is true
  and coalesce(workforce_profile.approval_required, true) is true
  and lower(btrim(coalesce(workforce_profile.onboarding_status, ''))) = 'active'
  and lower(btrim(coalesce(workforce_profile.lifecycle_status, ''))) = 'active'
  and workforce_profile.deleted_at is null
  and workforce_profile.deactivated_at is null
  and workforce_profile.onboarding_submitted_at is null
  and workforce_profile.onboarding_reviewed_at is null
  and workforce_profile.onboarding_approved_at is null
  and workforce_profile.onboarding_activated_at is null
  and (
    (
      workforce_profile.migration_state = 'mirrored'
      and workforce_profile.source_profile_type in (
        'contractor',
        'employee',
        'field_executive',
        'vendor',
        'worker'
      )
    )
    or exists (
      select 1
      from public.workforce_onboarding_events request_event
      where request_event.company_id = workforce_profile.company_id
        and request_event.event_code = 'onboarding_requested'
        and (
          request_event.workforce_id = workforce_profile.id
          or request_event.field_executive_id = workforce_profile.id
          or (
            workforce_profile.source_profile_id is not null
            and request_event.field_executive_id = workforce_profile.source_profile_id
          )
        )
    )
  )
  and not exists (
    select 1
    from public.workforce_onboarding_events onboarding_event
    where onboarding_event.company_id = workforce_profile.company_id
      and onboarding_event.event_code in (
        'candidate_submitted',
        'returned_for_correction',
        'onboarding_rejected',
        'ho_approved_and_activated'
      )
      and (
        onboarding_event.workforce_id = workforce_profile.id
        or onboarding_event.field_executive_id = workforce_profile.id
        or (
          workforce_profile.source_profile_id is not null
          and onboarding_event.field_executive_id = workforce_profile.source_profile_id
        )
      )
  )
  and not exists (
    select 1
    from public.mob_app_notifications notification
    where notification.company_id = workforce_profile.company_id
      and notification.event_code = 'profile_submitted'
      and (
        (
          notification.recipient_profile_type = 'workforce'
          and notification.recipient_account_id = workforce_profile.id
        )
        or (
          workforce_profile.source_profile_type <> 'canonical'
          and workforce_profile.source_profile_id is not null
          and notification.recipient_profile_type = workforce_profile.source_profile_type
          and notification.recipient_account_id = workforce_profile.source_profile_id
        )
      )
  );

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
  'registration_status_repaired',
  repair_target.previous_onboarding_status,
  'pending',
  'system',
  'Restored Pending because no registration-submission evidence was found.',
  jsonb_build_object(
    'reason', 'default_profile_fields_are_not_submission_evidence',
    'previous_onboarding_status', repair_target.previous_onboarding_status,
    'previous_lifecycle_status', repair_target.previous_lifecycle_status,
    'previous_is_active', repair_target.previous_is_active,
    'previous_updated_at', repair_target.previous_updated_at,
    'source_profile_type', repair_target.source_profile_type,
    'source_profile_id', repair_target.source_profile_id,
    'repair_migration', '20261015212000_workforce_default_field_registration_repair'
  )
from workforce_default_field_registration_repair_targets repair_target
where not exists (
  select 1
  from public.workforce_onboarding_events existing_repair
  where existing_repair.workforce_id = repair_target.id
    and existing_repair.event_code = 'registration_status_repaired'
    and existing_repair.metadata ->> 'repair_migration' =
      '20261015212000_workforce_default_field_registration_repair'
);

update public.workforce workforce_profile
set onboarding_status = 'pending',
    lifecycle_status = 'onboarding',
    updated_at = now()
from workforce_default_field_registration_repair_targets repair_target
where workforce_profile.id = repair_target.id;

-- Prevent the same invalid state from being written again. The operational
-- enabled flag remains independent; only an attempted Active registration
-- requires durable submission or approval evidence.
create or replace function public.workforce_enforce_active_status_invariant()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_onboarding_status text := lower(btrim(coalesce(new.onboarding_status, '')));
  v_lifecycle_status text := lower(btrim(coalesce(new.lifecycle_status, '')));
  v_has_registration_evidence boolean := false;
begin
  if new.is_active is true
    and (
      v_onboarding_status in ('cancelled', 'rejected')
      or new.deleted_at is not null
      or new.deactivated_at is not null
      or v_lifecycle_status in (
        'inactive',
        'deactivated',
        'offboarded',
        'closed',
        'exited',
        'terminated',
        'resigned',
        'settled',
        'cancelled'
      )
    )
  then
    raise exception using
      errcode = '23514',
      constraint = 'workforce_active_status_invariant',
      message = 'Enabled Workforce profiles must not be rejected, cancelled, archived or exited';
  end if;

  if coalesce(new.approval_required, true) is true
    and v_onboarding_status = 'active'
  then
    v_has_registration_evidence :=
      new.onboarding_submitted_at is not null
      or new.onboarding_reviewed_at is not null
      or new.onboarding_approved_at is not null
      or new.onboarding_activated_at is not null
      or exists (
        select 1
        from public.workforce_onboarding_events onboarding_event
        where onboarding_event.company_id = new.company_id
          and onboarding_event.event_code in (
            'candidate_submitted',
            'ho_approved_and_activated'
          )
          and (
            onboarding_event.workforce_id = new.id
            or onboarding_event.field_executive_id = new.id
            or (
              new.source_profile_id is not null
              and onboarding_event.field_executive_id = new.source_profile_id
            )
          )
      )
      or exists (
        select 1
        from public.mob_app_notifications notification
        where notification.company_id = new.company_id
          and notification.event_code = 'profile_submitted'
          and (
            (
              notification.recipient_profile_type = 'workforce'
              and notification.recipient_account_id = new.id
            )
            or (
              new.source_profile_type <> 'canonical'
              and new.source_profile_id is not null
              and notification.recipient_profile_type = new.source_profile_type
              and notification.recipient_account_id = new.source_profile_id
            )
          )
      );

    if not v_has_registration_evidence then
      raise exception using
        errcode = '23514',
        constraint = 'workforce_registration_completion_evidence',
        message = 'Active Workforce registration requires completed registration evidence';
    end if;
  end if;

  return new;
end;
$function$;

comment on function public.workforce_enforce_active_status_invariant() is
  'Keeps operational enablement independent and prevents approval-managed Workforce registrations from becoming Active without durable submission or approval evidence.';

notify pgrst, 'reload schema';

commit;
