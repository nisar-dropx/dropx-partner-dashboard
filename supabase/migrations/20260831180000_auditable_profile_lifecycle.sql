begin;

-- Lifecycle state is intentionally separate from onboarding state. Moving a
-- designation or profile between registers must never suspend a person.
create table if not exists public.people_profile_lifecycle_status (
  company_id uuid not null references public.companies(id) on delete cascade,
  profile_type text not null,
  profile_id uuid not null,
  status text not null default 'active',
  reason text,
  suspended_from timestamptz,
  suspended_until timestamptz,
  changed_by uuid references public.profiles(id) on delete set null,
  changed_at timestamptz not null default now(),
  primary key (company_id, profile_type, profile_id),
  constraint people_profile_lifecycle_type_check
    check (profile_type in ('employee','contractor','workforce','field_executive','vendor','worker')),
  constraint people_profile_lifecycle_status_check
    check (status in ('active','suspended','offboarded')),
  constraint people_profile_lifecycle_suspension_window_check
    check (status <> 'suspended' or (suspended_from is not null and suspended_until is not null and suspended_until > suspended_from))
);

create table if not exists public.people_profile_lifecycle_history (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  profile_type text not null,
  profile_id uuid not null,
  from_status text,
  to_status text not null,
  reason text not null,
  effective_from timestamptz not null default now(),
  effective_until timestamptz,
  changed_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint people_profile_lifecycle_history_type_check
    check (profile_type in ('employee','contractor','workforce','field_executive','vendor','worker')),
  constraint people_profile_lifecycle_history_from_status_check
    check (from_status is null or from_status in ('active','suspended','offboarded')),
  constraint people_profile_lifecycle_history_to_status_check
    check (to_status in ('active','suspended','offboarded'))
);

create index if not exists people_profile_lifecycle_status_expiry_idx
  on public.people_profile_lifecycle_status(status, suspended_until)
  where status = 'suspended';

create index if not exists people_profile_lifecycle_history_profile_idx
  on public.people_profile_lifecycle_history(company_id, profile_type, profile_id, created_at desc);

alter table public.people_profile_lifecycle_status enable row level security;
alter table public.people_profile_lifecycle_history enable row level security;

-- Contractors are operationally active after completed onboarding unless an
-- explicit lifecycle record says they are suspended or offboarded.
create or replace function public.enforce_people_contractor_active_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  lifecycle_status_value text;
  suspended_until_value timestamptz;
begin
  if new.deleted_at is not null then
    new.is_active := false;
    return new;
  end if;

  if lower(coalesce(new.onboarding_status, '')) = 'active' then
    select status.status, status.suspended_until
      into lifecycle_status_value, suspended_until_value
    from public.people_profile_lifecycle_status status
    where status.company_id = new.company_id
      and status.profile_type = 'contractor'
      and status.profile_id = new.id;

    if lifecycle_status_value = 'offboarded'
       or (lifecycle_status_value = 'suspended' and suspended_until_value > now()) then
      new.is_active := false;
    else
      new.is_active := true;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists contractors_enforce_people_active_state on public.contractors;
create trigger contractors_enforce_people_active_state
before insert or update of designation, onboarding_status, is_active, deleted_at
on public.contractors
for each row execute function public.enforce_people_contractor_active_state();

create or replace function public.change_contractor_lifecycle_status(
  p_company_id uuid,
  p_contractor_id uuid,
  p_status text,
  p_reason text,
  p_suspended_until timestamptz default null,
  p_changed_by uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  contractor_row public.contractors%rowtype;
  previous_status text;
  requested_status text := lower(btrim(coalesce(p_status, '')));
  reason_value text := btrim(coalesce(p_reason, ''));
  changed_at_value timestamptz := now();
begin
  if requested_status not in ('active','suspended') then
    raise exception 'Choose Active or Suspended.';
  end if;
  if reason_value = '' then
    raise exception 'A reason is required for every status change.';
  end if;
  if requested_status = 'suspended'
     and (p_suspended_until is null or p_suspended_until <= changed_at_value) then
    raise exception 'Suspension end time must be in the future.';
  end if;

  select * into contractor_row
  from public.contractors
  where company_id = p_company_id and id = p_contractor_id
  for update;

  if contractor_row.id is null then
    raise exception 'Independent Contractor was not found.';
  end if;
  if contractor_row.deleted_at is not null then
    raise exception 'An offboarded Independent Contractor cannot be reactivated here.';
  end if;
  if requested_status = 'active'
     and lower(coalesce(contractor_row.onboarding_status, '')) <> 'active' then
    raise exception 'Complete onboarding before activating this profile.';
  end if;

  select status into previous_status
  from public.people_profile_lifecycle_status
  where company_id = p_company_id
    and profile_type = 'contractor'
    and profile_id = p_contractor_id
  for update;
  previous_status := coalesce(previous_status, case when contractor_row.is_active then 'active' else 'suspended' end);

  if previous_status = 'offboarded' then
    raise exception 'An offboarded Independent Contractor cannot be reactivated here.';
  end if;

  insert into public.people_profile_lifecycle_status (
    company_id, profile_type, profile_id, status, reason,
    suspended_from, suspended_until, changed_by, changed_at
  ) values (
    p_company_id, 'contractor', p_contractor_id, requested_status, reason_value,
    case when requested_status = 'suspended' then changed_at_value else null end,
    case when requested_status = 'suspended' then p_suspended_until else null end,
    p_changed_by, changed_at_value
  )
  on conflict (company_id, profile_type, profile_id) do update set
    status = excluded.status,
    reason = excluded.reason,
    suspended_from = excluded.suspended_from,
    suspended_until = excluded.suspended_until,
    changed_by = excluded.changed_by,
    changed_at = excluded.changed_at;

  update public.contractors
  set is_active = requested_status = 'active', updated_at = changed_at_value
  where company_id = p_company_id and id = p_contractor_id;

  insert into public.people_profile_lifecycle_history (
    company_id, profile_type, profile_id, from_status, to_status, reason,
    effective_from, effective_until, changed_by
  ) values (
    p_company_id, 'contractor', p_contractor_id, previous_status, requested_status,
    reason_value, changed_at_value,
    case when requested_status = 'suspended' then p_suspended_until else null end,
    p_changed_by
  );

  return jsonb_build_object(
    'profile_id', p_contractor_id,
    'previous_status', previous_status,
    'status', requested_status,
    'suspended_until', case when requested_status = 'suspended' then p_suspended_until else null end
  );
end;
$$;

create or replace function public.reactivate_expired_profile_suspensions()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  restored_count integer := 0;
  expired_row record;
begin
  for expired_row in
    select company_id, profile_type, profile_id
    from public.people_profile_lifecycle_status
    where status = 'suspended' and suspended_until <= now()
    for update
  loop
    update public.people_profile_lifecycle_status status
    set status = 'active',
        reason = 'Automatic reactivation after suspension period ended',
        suspended_from = null,
        suspended_until = null,
        changed_by = null,
        changed_at = now()
    where status.company_id = expired_row.company_id
      and status.profile_type = expired_row.profile_type
      and status.profile_id = expired_row.profile_id;

    insert into public.people_profile_lifecycle_history (
      company_id, profile_type, profile_id, from_status, to_status, reason,
      effective_from, changed_by
    ) values (
      expired_row.company_id, expired_row.profile_type, expired_row.profile_id,
      'suspended', 'active', 'Automatic reactivation after suspension period ended',
      now(), null
    );

    if expired_row.profile_type = 'contractor' then
    update public.contractors contractor
    set is_active = true, updated_at = now()
      where contractor.company_id = expired_row.company_id
      and contractor.id = expired_row.profile_id
      and contractor.deleted_at is null
      and lower(coalesce(contractor.onboarding_status, '')) = 'active'
      and not contractor.is_active;
      if found then restored_count := restored_count + 1; end if;
    end if;
  end loop;

  return restored_count;
end;
$$;

-- No current contractor was intentionally suspended in the old model. Treat
-- every completed, non-deleted contractor as active and create the baseline.
update public.contractors
set is_active = true, updated_at = now()
where lower(coalesce(onboarding_status, '')) = 'active'
  and deleted_at is null
  and not is_active;

insert into public.people_profile_lifecycle_status (
  company_id, profile_type, profile_id, status, reason, changed_at
)
select company_id, 'contractor', id, 'active', 'Baseline after lifecycle repair', now()
from public.contractors
where lower(coalesce(onboarding_status, '')) = 'active'
  and deleted_at is null
on conflict (company_id, profile_type, profile_id) do nothing;

revoke all on function public.enforce_people_contractor_active_state() from public, anon, authenticated;
revoke all on function public.change_contractor_lifecycle_status(uuid, uuid, text, text, timestamptz, uuid) from public, anon, authenticated;
revoke all on function public.reactivate_expired_profile_suspensions() from public, anon, authenticated;
grant execute on function public.change_contractor_lifecycle_status(uuid, uuid, text, text, timestamptz, uuid) to service_role;
grant execute on function public.reactivate_expired_profile_suspensions() to service_role;

comment on table public.people_profile_lifecycle_status is
  'Current auditable People profile lifecycle state, kept separate from onboarding and register routing.';
comment on table public.people_profile_lifecycle_history is
  'Immutable history for suspend/reactivate/offboard lifecycle decisions, including reason and effective dates.';

notify pgrst, 'reload schema';

commit;
