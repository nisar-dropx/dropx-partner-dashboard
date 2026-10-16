begin;

-- `is_active` only controls operational availability. Registration completion
-- must come from the registration workflow itself, never from that flag. Keep
-- this definition here (rather than trusting an earlier migration) so a
-- partially upgraded database cannot retain the superseded auto-promotion
-- trigger from 20261015170000.
lock table public.workforce in share row exclusive mode;

create or replace function public.workforce_enforce_active_status_invariant()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_onboarding_status text := lower(btrim(coalesce(new.onboarding_status, '')));
  v_lifecycle_status text := lower(btrim(coalesce(new.lifecycle_status, '')));
begin
  -- Enabled profiles may still be Pending, Under Review, Returned or Approved.
  -- Reject only combinations that are unambiguously terminal.
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

  return new;
end;
$function$;

drop trigger if exists workforce_zz_active_status_invariant on public.workforce;
create trigger workforce_zz_active_status_invariant
before insert or update of
  is_active,
  onboarding_status,
  lifecycle_status,
  deleted_at,
  deactivated_at
on public.workforce
for each row execute function public.workforce_enforce_active_status_invariant();

comment on function public.workforce_enforce_active_status_invariant() is
  'Validates terminal Workforce states without treating the operational enabled flag as registration completion.';

-- The superseded migration promoted every enabled Pending profile to Active.
-- Repair only rows with positive registration provenance: mirrored profiles
-- created by the legacy-register cutover, or profiles with an explicit
-- onboarding request. A null submission-owned `is_handicapped` field plus no
-- completion timestamp/event/notification distinguishes unfinished app
-- registration from completed profiles. Unlinked legacy Active profiles are
-- deliberately left alone.
create temporary table workforce_registration_evidence_repair_targets
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
  and workforce_profile.is_handicapped is null
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
  'Restored Pending because the profile was promoted without registration-submission evidence.',
  jsonb_build_object(
    'reason', 'legacy_pending_profile_auto_promoted',
    'previous_onboarding_status', repair_target.previous_onboarding_status,
    'previous_lifecycle_status', repair_target.previous_lifecycle_status,
    'previous_is_active', repair_target.previous_is_active,
    'previous_updated_at', repair_target.previous_updated_at,
    'source_profile_type', repair_target.source_profile_type,
    'source_profile_id', repair_target.source_profile_id,
    'repair_migration', '20261015190000_workforce_registration_evidence_repair'
  )
from workforce_registration_evidence_repair_targets repair_target
where not exists (
  select 1
  from public.workforce_onboarding_events existing_repair
  where existing_repair.workforce_id = repair_target.id
    and existing_repair.event_code = 'registration_status_repaired'
    and existing_repair.metadata ->> 'repair_migration' =
      '20261015190000_workforce_registration_evidence_repair'
);

update public.workforce workforce_profile
set onboarding_status = 'pending',
    lifecycle_status = 'onboarding',
    updated_at = now()
from workforce_registration_evidence_repair_targets repair_target
where workforce_profile.id = repair_target.id;

notify pgrst, 'reload schema';

commit;
