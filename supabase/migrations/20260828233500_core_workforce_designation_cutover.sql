begin;

-- DA, WM, ODCD and DCD are operational Workforce designations. Their physical
-- destination is stored in Workforce Master; application code does not carry a
-- role-code routing list. Reconciliation keeps inactive legacy rows only as
-- compatibility references for downstream records.
do $$
declare
  designation_row record;
  workforce_register_id uuid;
  reconciliation jsonb;
begin
  for designation_row in
    select designation.id, designation.company_id, designation.code
    from public.designations designation
    where designation.is_active
      and upper(btrim(designation.code)) in ('DA', 'WM', 'ODCD', 'DCD')
    order by designation.company_id, designation.code
  loop
    select register.id
    into workforce_register_id
    from public.workforce_register_master register
    where register.company_id = designation_row.company_id
      and register.code = 'workforce'
      and register.table_name = 'workforce'
      and register.is_active;

    if workforce_register_id is null then
      raise exception 'Active Workforce register is missing for company %.', designation_row.company_id;
    end if;

    reconciliation := public.set_designation_register_route(
      designation_row.company_id,
      designation_row.id,
      workforce_register_id,
      true,
      null,
      true
    );

    if coalesce(reconciliation ->> 'status', '') <> 'complete'
      or coalesce((reconciliation #>> '{reconciliation,failed}')::integer, 0) <> 0 then
      raise exception 'Workforce cutover failed for designation %: %',
        designation_row.code,
        reconciliation;
    end if;
  end loop;
end;
$$;

-- Reconciliation copies source state before retiring the legacy row. Normalize
-- the canonical active flag from the lifecycle fields after every source has
-- been processed so a later inactive compatibility mirror cannot hide an
-- otherwise active account.
update public.workforce workforce_profile
set is_active = case
      when workforce_profile.deleted_at is not null then false
      when workforce_profile.deactivated_at is not null then false
      when workforce_profile.lifecycle_status = 'exited' then false
      when workforce_profile.onboarding_status = 'active' then true
      when workforce_profile.lifecycle_status = 'active' then true
      else false
    end,
    synced_at = now(),
    updated_at = now()
from public.designations designation
where designation.id = workforce_profile.designation_id
  and designation.company_id = workforce_profile.company_id
  and upper(btrim(designation.code)) in ('DA', 'WM', 'ODCD', 'DCD');

-- Guard the finished state. A failed or partial cutover rolls back atomically.
do $$
begin
  if exists (
    select 1
    from public.designations designation
    left join public.designation_register_routes route
      on route.designation_id = designation.id
     and route.company_id = designation.company_id
    left join public.workforce_register_master register
      on register.id = route.register_id
     and register.company_id = route.company_id
    where designation.is_active
      and upper(btrim(designation.code)) in ('DA', 'WM', 'ODCD', 'DCD')
      and (
        not coalesce(route.registration_enabled, false)
        or route.reconciliation_status <> 'complete'
        or register.code <> 'workforce'
        or register.table_name <> 'workforce'
      )
  ) then
    raise exception 'One or more core Workforce designations are not fully routed to Workforce.';
  end if;
end;
$$;

notify pgrst, 'reload schema';

commit;
