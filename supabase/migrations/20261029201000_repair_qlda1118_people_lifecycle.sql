begin;

-- QLDA1118 was included in the 31 Aug history-verified restoration, but a
-- later employee/contractor canonicalization left the Employee, Person and
-- Engagement rows inactive. There is no suspension/offboarding action, exit
-- case, end date or closed assignment. Repair the canonical People records;
-- downstream recovery directories will then include the person normally.
do $$
declare
  v_company_id uuid;
  v_employee_id uuid;
  v_person_id uuid;
  v_engagement_id uuid;
  v_now timestamptz := now();
  v_already_repaired boolean;
begin
  select e.company_id, e.id
    into v_company_id, v_employee_id
  from public.employees e
  join public.companies c
    on c.id = e.company_id
   and c.code = 'DROPX_LOGISTICS'
  join public.stations s
    on s.company_id = e.company_id
   and s.id = e.location_id
   and s.station_code = 'QLDA'
  where e.employee_code = 'QLDA1118'
    and e.full_name = 'MUZAMMIL MK'
    and e.deleted_at is null;

  if v_employee_id is null then
    raise exception 'QLDA1118 / MUZAMMIL MK was not found at QLDA; aborting lifecycle repair';
  end if;

  select p.id, g.id
    into v_person_id, v_engagement_id
  from public.hr_engagements g
  join public.hr_people p
    on p.company_id = g.company_id
   and p.id = g.person_id
  where g.company_id = v_company_id
    and g.worker_type = 'employee'
    and g.employee_id = v_employee_id
    and p.legacy_source_id = v_employee_id
    and p.legacy_source_type in ('employee', 'contractor');

  if v_person_id is null or v_engagement_id is null then
    raise exception 'QLDA1118 canonical Person or Engagement is missing; aborting lifecycle repair';
  end if;

  if exists (
    select 1
    from public.hr_people p
    where p.company_id = v_company_id
      and p.legacy_source_type = 'employee'
      and p.legacy_source_id = v_employee_id
      and p.id <> v_person_id
  ) then
    raise exception 'QLDA1118 already has a different Employee-linked Person; aborting lifecycle repair';
  end if;

  v_already_repaired := exists (
    select 1
    from public.hr_worker_lifecycle_events e
    where e.company_id = v_company_id
      and e.worker_type = 'employee'
      and e.worker_id = v_employee_id
      and e.event_type = 'access_reconciled'
      and e.metadata ->> 'source' = 'qlda1118_canonical_lifecycle_repair'
  );

  if v_already_repaired then
    if not exists (
      select 1
      from public.employees e
      join public.hr_people p
        on p.company_id = e.company_id
       and p.id = v_person_id
       and p.legacy_source_type = 'employee'
       and p.legacy_source_id = e.id
       and p.status = 'active'
      join public.hr_engagements g
        on g.company_id = e.company_id
       and g.id = v_engagement_id
       and g.status = 'active'
       and g.end_date is null
      where e.company_id = v_company_id
        and e.id = v_employee_id
        and e.is_active
        and e.people_lifecycle_status = 'active'
        and e.last_working_date is null
    ) then
      raise exception 'QLDA1118 repair marker exists but canonical lifecycle is not active';
    end if;
    return;
  end if;

  if not exists (
    select 1
    from public.employees e
    where e.company_id = v_company_id
      and e.id = v_employee_id
      and not e.is_active
      and e.people_lifecycle_status = 'suspended'
      and e.last_working_date is null
      and e.suspension_reason is null
      and e.suspended_at is null
  ) then
    raise exception 'QLDA1118 is no longer in the verified stale-suspension state; aborting repair';
  end if;

  if exists (
    select 1
    from public.hr_exit_cases x
    where x.company_id = v_company_id
      and x.employee_id = v_employee_id
      and x.status not in ('rejected', 'withdrawn', 'cancelled')
  ) then
    raise exception 'QLDA1118 has an exit case and must not be reactivated automatically';
  end if;

  if not exists (
    select 1
    from public.hr_work_assignments a
    where a.company_id = v_company_id
      and a.engagement_id = v_engagement_id
      and a.location_id = (select id from public.stations where company_id = v_company_id and station_code = 'QLDA')
      and a.is_primary
      and a.effective_to is null
  ) then
    raise exception 'QLDA1118 has no open primary QLDA assignment; aborting repair';
  end if;

  if not exists (
    select 1
    from public.hr_worker_lifecycle_events e
    where e.company_id = v_company_id
      and e.worker_type = 'employee'
      and e.worker_id = v_employee_id
      and e.event_type = 'access_reconciled'
      and e.to_status = 'active'
      and e.metadata ->> 'source' = 'history_verified_production_repair'
  ) then
    raise exception 'QLDA1118 lacks the prior verified-active repair evidence; aborting repair';
  end if;

  if exists (
    select 1
    from public.hr_worker_lifecycle_events later
    where later.company_id = v_company_id
      and later.worker_type = 'employee'
      and later.worker_id = v_employee_id
      and later.event_type in ('suspended', 'offboarding_started', 'offboarded')
      and later.created_at > (
        select max(prior.created_at)
        from public.hr_worker_lifecycle_events prior
        where prior.company_id = v_company_id
          and prior.worker_type = 'employee'
          and prior.worker_id = v_employee_id
          and prior.event_type = 'access_reconciled'
          and prior.to_status = 'active'
          and prior.metadata ->> 'source' = 'history_verified_production_repair'
      )
  ) then
    raise exception 'QLDA1118 has a later suspension/offboarding action; aborting repair';
  end if;

  update public.employees
  set is_active = true,
      people_lifecycle_status = 'active',
      suspension_reason = null,
      suspended_at = null,
      suspended_by = null,
      reactivated_at = v_now,
      last_working_date = null,
      deactivated_at = null,
      deactivated_by = null,
      updated_at = v_now
  where company_id = v_company_id
    and id = v_employee_id;

  update public.hr_people
  set legacy_source_type = 'employee',
      legacy_source_id = v_employee_id,
      status = 'active',
      updated_at = v_now
  where company_id = v_company_id
    and id = v_person_id;

  update public.hr_engagements
  set status = 'active',
      end_date = null,
      updated_at = v_now
  where company_id = v_company_id
    and id = v_engagement_id;

  insert into public.hr_worker_lifecycle_events (
    company_id, worker_type, worker_id, event_type, from_status, to_status,
    reason, metadata
  ) values (
    v_company_id,
    'employee',
    v_employee_id,
    'access_reconciled',
    'suspended',
    'active',
    'Completed the verified 31 Aug restoration after employee/contractor canonicalization left the active assignment hidden',
    jsonb_build_object(
      'source', 'qlda1118_canonical_lifecycle_repair',
      'employee_code', 'QLDA1118',
      'station_code', 'QLDA',
      'preserve_history', true
    )
  );
end $$;

commit;
