begin;

-- Serialize the one-time repair with profile writers so no active/pending row
-- can commit between the repair scan and installation of the invariant trigger.
lock table public.workforce in share row exclusive mode;

-- A small set of canonical Workforce rows were left with the activation flag
-- set while their onboarding tuple still described the pre-activation state.
-- Repair only the unambiguous drift: the row is available, is already marked
-- active, and has not entered an exit lifecycle.
update public.workforce workforce_profile
set onboarding_status = 'active',
    lifecycle_status = 'active',
    updated_at = now()
where workforce_profile.is_active is true
  and workforce_profile.deleted_at is null
  and workforce_profile.deactivated_at is null
  and lower(btrim(coalesce(workforce_profile.onboarding_status, ''))) = 'pending'
  and lower(btrim(coalesce(workforce_profile.lifecycle_status, ''))) in (
    '',
    'onboarding',
    'active'
  );

-- Do not let an explicit review rejection, cancellation or completed exit keep
-- an operationally active flag. This intentionally does not guess at unknown
-- legacy status values; the forward trigger below prevents new drift.
update public.workforce workforce_profile
set is_active = false,
    updated_at = now()
where workforce_profile.is_active is true
  and (
    workforce_profile.deleted_at is not null
    or workforce_profile.deactivated_at is not null
    or lower(btrim(coalesce(workforce_profile.onboarding_status, ''))) in (
      'under_review',
      'returned',
      'approved',
      'rejected',
      'cancelled'
    )
    or lower(btrim(coalesce(workforce_profile.lifecycle_status, ''))) in (
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
  );

create or replace function public.workforce_enforce_active_status_invariant()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_onboarding_status text := lower(btrim(coalesce(new.onboarding_status, '')));
  v_lifecycle_status text := lower(btrim(coalesce(new.lifecycle_status, '')));
begin
  -- Route/import writers may copy an already-active source profile into the
  -- Workforce table while relying on the table's pending/onboarding defaults.
  -- Canonicalize that exact legacy tuple instead of rejecting an otherwise
  -- valid active person. Review/returned/terminal states are never promoted.
  if new.is_active is true
    and v_onboarding_status = 'pending'
    and v_lifecycle_status in ('', 'active', 'onboarding')
    and new.deleted_at is null
    and new.deactivated_at is null
  then
    new.onboarding_status := 'active';
    new.lifecycle_status := 'active';
    v_onboarding_status := 'active';
    v_lifecycle_status := 'active';
  end if;

  if new.is_active is true
    and (
      v_onboarding_status <> 'active'
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
      message = 'Active Workforce profiles require active onboarding and a non-terminal lifecycle';
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
  'Prevents an active canonical Workforce flag from diverging from onboarding, lifecycle, deletion or deactivation state.';

notify pgrst, 'reload schema';

commit;
