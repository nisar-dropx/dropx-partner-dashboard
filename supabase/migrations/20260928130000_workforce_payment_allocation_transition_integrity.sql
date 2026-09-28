begin;

alter table public.workforce_payment_allocations
  add column if not exists transition_restore_state jsonb;

alter table public.workforce_payment_allocations
  drop constraint if exists workforce_payment_allocations_transition_restore_check;
alter table public.workforce_payment_allocations
  add constraint workforce_payment_allocations_transition_restore_check
  check (
    transition_restore_state is null
    or jsonb_typeof(transition_restore_state) = 'object'
  );

comment on column public.workforce_payment_allocations.transition_restore_state is
  'Private pre-transition state used to reversibly apply corrected Workforce employment cutoffs.';

create or replace function public.reconcile_workforce_direct_payment_transition()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_cutoff date;
  v_terminal_status boolean := false;
  v_offboarding boolean := false;
  v_cutoff_state_changed boolean := false;
  v_old_designation public.designations%rowtype;
  v_new_designation public.designations%rowtype;
  v_old_designation_found boolean := false;
  v_new_designation_found boolean := false;
  v_designation_changed boolean := false;
  v_location_changed boolean := false;
  v_new_direct_eligible boolean := false;
  v_station_code text;
  v_current public.workforce_payment_allocations%rowtype;
  v_current_count integer := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    new.company_id::text || ':' || new.id::text,
    0
  ));

  v_terminal_status := lower(coalesce(new.lifecycle_status, '')) in (
    'inactive', 'offboarded', 'exited', 'terminated', 'resigned', 'settled'
  );
  v_offboarding := new.is_active = false
    or new.deleted_at is not null
    or new.deactivated_at is not null
    or new.last_working_date is not null
    or v_terminal_status;

  v_cutoff_state_changed := new.is_active is distinct from old.is_active
    or new.deleted_at is distinct from old.deleted_at
    or new.deactivated_at is distinct from old.deactivated_at
    or new.last_working_date is distinct from old.last_working_date
    or lower(coalesce(new.lifecycle_status, ''))
      is distinct from lower(coalesce(old.lifecycle_status, ''));

  if v_cutoff_state_changed then
    update public.workforce_payment_allocations allocation
    set effective_to = case
          when allocation.transition_restore_state ? 'effective_to'
            then (allocation.transition_restore_state ->> 'effective_to')::date
          else allocation.effective_to
        end,
        status = coalesce(
          nullif(allocation.transition_restore_state ->> 'status', ''),
          allocation.status
        ),
        change_reason = case
          when allocation.transition_restore_state ? 'change_reason'
            then nullif(allocation.transition_restore_state ->> 'change_reason', '')
          else allocation.change_reason
        end,
        transition_restore_state = null,
        updated_at = now()
    where allocation.company_id = new.company_id
      and allocation.workforce_id = new.id
      and allocation.transition_restore_state ->> 'kind' = 'employment_cutoff';
  end if;

  if v_offboarding then
    v_cutoff := coalesce(new.last_working_date, v_today);

    update public.workforce_payment_allocations allocation
    set transition_restore_state = coalesce(
          allocation.transition_restore_state,
          jsonb_build_object(
            'kind', 'employment_cutoff',
            'effective_to', allocation.effective_to,
            'status', allocation.status,
            'change_reason', allocation.change_reason
          )
        ),
        status = 'cancelled',
        change_reason = concat_ws(
          ' | ',
          nullif(btrim(allocation.change_reason), ''),
          'Automatically cancelled after the Workforce employment cutoff.'
        ),
        updated_at = now()
    where allocation.company_id = new.company_id
      and allocation.workforce_id = new.id
      and allocation.status <> 'cancelled'
      and allocation.effective_from > v_cutoff;

    update public.workforce_payment_allocations allocation
    set transition_restore_state = coalesce(
          allocation.transition_restore_state,
          jsonb_build_object(
            'kind', 'employment_cutoff',
            'effective_to', allocation.effective_to,
            'status', allocation.status,
            'change_reason', allocation.change_reason
          )
        ),
        effective_to = v_cutoff,
        status = 'closed',
        change_reason = concat_ws(
          ' | ',
          nullif(btrim(allocation.change_reason), ''),
          'Automatically closed at the Workforce employment cutoff.'
        ),
        updated_at = now()
    where allocation.company_id = new.company_id
      and allocation.workforce_id = new.id
      and allocation.status <> 'cancelled'
      and allocation.effective_from <= v_cutoff
      and (allocation.effective_to is null or allocation.effective_to > v_cutoff);

    return new;
  end if;

  if not exists (
    select 1
    from public.workforce_payment_allocations allocation
    where allocation.company_id = new.company_id
      and allocation.workforce_id = new.id
      and allocation.status <> 'cancelled'
      and (allocation.effective_to is null or allocation.effective_to >= v_today)
  ) then
    return new;
  end if;

  select designation.*
  into v_old_designation
  from public.designations designation
  where designation.company_id = old.company_id
    and (
      designation.id = old.designation_id
      or (
        old.designation_id is null
        and lower(btrim(coalesce(old.designation, ''))) in (
          lower(btrim(designation.code)),
          lower(btrim(designation.name))
        )
      )
    )
  order by (designation.id = old.designation_id) desc, designation.id
  limit 1;
  v_old_designation_found := found;

  select designation.*
  into v_new_designation
  from public.designations designation
  where designation.company_id = new.company_id
    and designation.is_active = true
    and (
      designation.id = new.designation_id
      or (
        new.designation_id is null
        and lower(btrim(coalesce(new.designation, ''))) in (
          lower(btrim(designation.code)),
          lower(btrim(designation.name))
        )
      )
    )
  order by (designation.id = new.designation_id) desc, designation.id
  limit 1;
  v_new_designation_found := found;

  if not v_new_designation_found then
    raise exception 'An active designation is required before changing Workforce direct payment allocation ownership.';
  end if;

  v_designation_changed := not v_old_designation_found
    or v_old_designation.id is distinct from v_new_designation.id;
  v_location_changed := new.location_id is distinct from old.location_id;

  if not v_designation_changed and not v_location_changed then
    return new;
  end if;

  v_new_direct_eligible := v_new_designation.is_field_operations = true
    and v_new_designation.provider_mapping_required = false;

  if v_designation_changed and not v_new_direct_eligible then
    v_cutoff := v_today - 1;

    update public.workforce_payment_allocations allocation
    set status = 'cancelled',
        change_reason = concat_ws(
          ' | ',
          nullif(btrim(allocation.change_reason), ''),
          'Automatically cancelled before a provider-required or non-Field-Operations designation took effect.'
        ),
        updated_at = now()
    where allocation.company_id = new.company_id
      and allocation.workforce_id = new.id
      and allocation.status <> 'cancelled'
      and allocation.effective_from > v_cutoff;

    update public.workforce_payment_allocations allocation
    set effective_to = v_cutoff,
        status = 'closed',
        change_reason = concat_ws(
          ' | ',
          nullif(btrim(allocation.change_reason), ''),
          'Automatically closed before a provider-required or non-Field-Operations designation took effect.'
        ),
        updated_at = now()
    where allocation.company_id = new.company_id
      and allocation.workforce_id = new.id
      and allocation.status <> 'cancelled'
      and allocation.effective_from <= v_cutoff
      and (allocation.effective_to is null or allocation.effective_to > v_cutoff);

    return new;
  end if;

  if not v_new_direct_eligible then
    raise exception 'Close the direct payment allocation before changing this Workforce assignment.';
  end if;

  select station.station_code
  into v_station_code
  from public.stations station
  where station.id = new.location_id
    and station.company_id = new.company_id
    and station.is_active = true;

  if not found then
    raise exception 'An active company location is required before changing Workforce direct payment allocation ownership.';
  end if;

  if exists (
    select 1
    from public.workforce_payment_allocations allocation
    where allocation.company_id = new.company_id
      and allocation.workforce_id = new.id
      and allocation.status <> 'cancelled'
      and allocation.effective_from > v_today
  ) then
    raise exception 'A future direct payment allocation already exists. Cancel it before changing the Workforce location or designation.';
  end if;

  select count(*)
  into v_current_count
  from public.workforce_payment_allocations allocation
  where allocation.company_id = new.company_id
    and allocation.workforce_id = new.id
    and allocation.status <> 'cancelled'
    and allocation.effective_from <= v_today
    and (allocation.effective_to is null or allocation.effective_to >= v_today);

  if v_current_count > 1 then
    raise exception 'Multiple direct payment allocations are effective today. Reconcile them before changing the Workforce assignment.';
  end if;
  if v_current_count = 0 then
    return new;
  end if;

  select allocation.*
  into v_current
  from public.workforce_payment_allocations allocation
  where allocation.company_id = new.company_id
    and allocation.workforce_id = new.id
    and allocation.status <> 'cancelled'
    and allocation.effective_from <= v_today
    and (allocation.effective_to is null or allocation.effective_to >= v_today)
  order by allocation.effective_from desc, allocation.created_at desc
  limit 1
  for update;

  if v_current.effective_from = v_today then
    update public.workforce_payment_allocations
    set station_id = new.location_id,
        station_code_snapshot = v_station_code,
        designation_id = v_new_designation.id,
        designation_code_snapshot = v_new_designation.code,
        designation_name_snapshot = v_new_designation.name,
        status = v_current.status,
        change_reason = concat_ws(
          ' | ',
          nullif(btrim(v_current.change_reason), ''),
          'Automatically aligned with the Workforce location or designation change.'
        ),
        updated_at = now()
    where id = v_current.id;
    return new;
  end if;

  update public.workforce_payment_allocations
  set effective_to = v_today - 1,
      status = 'closed',
      change_reason = concat_ws(
        ' | ',
        nullif(btrim(v_current.change_reason), ''),
        'Automatically versioned after a Workforce location or designation change.'
      ),
      updated_at = now()
  where id = v_current.id;

  insert into public.workforce_payment_allocations (
    company_id,
    workforce_id,
    station_id,
    station_code_snapshot,
    designation_id,
    designation_code_snapshot,
    designation_name_snapshot,
    payment_method_id,
    payment_values,
    payment_components,
    effective_from,
    effective_to,
    status,
    change_reason,
    created_by,
    updated_by
  ) values (
    v_current.company_id,
    v_current.workforce_id,
    new.location_id,
    v_station_code,
    v_new_designation.id,
    v_new_designation.code,
    v_new_designation.name,
    v_current.payment_method_id,
    v_current.payment_values,
    v_current.payment_components,
    v_today,
    v_current.effective_to,
    case when v_current.effective_to is null then 'active' else 'closed' end,
    'Automatically created after a Workforce location or designation change.',
    v_current.created_by,
    v_current.updated_by
  );

  return new;
end;
$$;

drop trigger if exists workforce_payment_allocation_transition_integrity
  on public.workforce;
create trigger workforce_payment_allocation_transition_integrity
before update of
  location_id,
  designation_id,
  designation,
  is_active,
  deleted_at,
  last_working_date,
  lifecycle_status,
  deactivated_at
on public.workforce
for each row execute function public.reconcile_workforce_direct_payment_transition();

comment on function public.reconcile_workforce_direct_payment_transition() is
  'Closes, cancels or effective-dates direct Workforce payment allocations atomically when employment, designation or station ownership changes.';

revoke all on function public.reconcile_workforce_direct_payment_transition()
  from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
