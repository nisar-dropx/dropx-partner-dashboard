begin;

-- `is_active` is an operational enabled flag. Registration status is a
-- separate workflow: an administrator may enable a reserved DropX ID while
-- its registration is still Pending. Never infer registration completion
-- from this flag.
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
  -- This trigger validates impossible terminal combinations only. It must not
  -- promote Pending, Under Review, Returned or Approved registrations.
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

-- The superseded trigger changed Pending to Active whenever an administrator
-- enabled a profile. Restore only profiles with positive onboarding-request
-- evidence and the durable signature of never completing the Connect profile
-- submission: no submission timestamp/event/notification and the submission-
-- owned `is_handicapped` field is still NULL. Existing completed registrations
-- are deliberately preserved even when older routes did not stamp every newer
-- audit column.
create temporary table workforce_registration_status_repair_targets
on commit drop
as
select
  workforce_profile.id,
  workforce_profile.company_id,
  workforce_profile.onboarding_status as previous_onboarding_status,
  workforce_profile.lifecycle_status as previous_lifecycle_status,
  workforce_profile.is_active as previous_is_active,
  workforce_profile.updated_at as previous_updated_at
from public.workforce workforce_profile
where workforce_profile.is_active is true
  and workforce_profile.source_profile_type = 'canonical'
  and workforce_profile.source_profile_id = workforce_profile.id
  and lower(btrim(coalesce(workforce_profile.onboarding_status, ''))) = 'active'
  and lower(btrim(coalesce(workforce_profile.lifecycle_status, ''))) = 'active'
  and coalesce(workforce_profile.approval_required, true) is true
  and workforce_profile.is_handicapped is null
  and workforce_profile.onboarding_submitted_at is null
  and workforce_profile.onboarding_reviewed_at is null
  and workforce_profile.onboarding_approved_at is null
  and workforce_profile.onboarding_activated_at is null
  and workforce_profile.deleted_at is null
  and workforce_profile.deactivated_at is null
  and not exists (
    select 1
    from public.workforce_onboarding_events onboarding_event
    where (
      onboarding_event.workforce_id = workforce_profile.id
      or onboarding_event.field_executive_id = workforce_profile.id
    )
      and onboarding_event.event_code in ('candidate_submitted', 'ho_approved_and_activated')
  )
  and not exists (
    select 1
    from public.mob_app_notifications notification
    where notification.company_id = workforce_profile.company_id
      and notification.recipient_profile_type = 'workforce'
      and notification.recipient_account_id = workforce_profile.id
      and notification.event_code = 'profile_submitted'
  )
  and exists (
    select 1
    from public.workforce_onboarding_events onboarding_event
    where (
      onboarding_event.workforce_id = workforce_profile.id
      or onboarding_event.field_executive_id = workforce_profile.id
    )
      and onboarding_event.event_code = 'onboarding_requested'
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
  'Restored Pending because registration was never submitted.',
  jsonb_build_object(
    'reason', 'enabled_before_registration_submission',
    'previous_onboarding_status', repair_target.previous_onboarding_status,
    'previous_lifecycle_status', repair_target.previous_lifecycle_status,
    'previous_is_active', repair_target.previous_is_active,
    'previous_updated_at', repair_target.previous_updated_at,
    'repair_migration', '20261015183000_workforce_registration_status_independence'
  )
from workforce_registration_status_repair_targets repair_target
where not exists (
  select 1
  from public.workforce_onboarding_events existing_repair
  where existing_repair.workforce_id = repair_target.id
    and existing_repair.event_code = 'registration_status_repaired'
    and existing_repair.metadata ->> 'repair_migration' =
      '20261015183000_workforce_registration_status_independence'
);

update public.workforce workforce_profile
set onboarding_status = 'pending',
    lifecycle_status = 'onboarding',
    updated_at = now()
from workforce_registration_status_repair_targets repair_target
where workforce_profile.id = repair_target.id;

notify pgrst, 'reload schema';

commit;
