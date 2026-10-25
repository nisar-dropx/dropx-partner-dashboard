begin;

-- A People station-owner change already refreshes product scopes, the active
-- station responsibility and direct operational reporting relationships.
-- Open roster approvals, however, snapshot their approver when submitted.
-- Keep those still-pending snapshots aligned with the current station owner so
-- a former CLM cannot retain an inbox item or receive a later reminder.
create or replace function public.reconcile_open_station_manager_approvals(
  p_company_id uuid,
  p_station_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_station_id uuid;
  v_manager_user_id uuid;
  v_manager_person_id uuid;
begin
  if p_company_id is null or coalesce(cardinality(p_station_ids), 0) = 0 then
    return;
  end if;

  for v_station_id in
    select distinct station_id
    from unnest(p_station_ids) station_id
    join stations station
      on station.company_id = p_company_id
     and station.id = station_id
  loop
    v_manager_user_id := null;
    v_manager_person_id := null;

    select responsibility.assignee_user_id, engagement.person_id
      into v_manager_user_id, v_manager_person_id
    from station_responsibility_assignments responsibility
    join station_responsibility_roles responsibility_role
      on responsibility_role.company_id = responsibility.company_id
     and responsibility_role.id = responsibility.responsibility_role_id
     and responsibility_role.owning_product_code = 'operations'
     and responsibility_role.code in ('station_manager', 'cluster_manager')
    left join hr_work_assignments manager_assignment
      on manager_assignment.company_id = responsibility.company_id
     and manager_assignment.id = responsibility.assignment_id
    left join hr_engagements engagement
      on engagement.company_id = manager_assignment.company_id
     and engagement.id = manager_assignment.engagement_id
    join profiles manager_profile
      on manager_profile.company_id = responsibility.company_id
     and manager_profile.id = responsibility.assignee_user_id
     and manager_profile.is_active = true
    where responsibility.company_id = p_company_id
      and responsibility.station_id = v_station_id
      and responsibility.is_primary = true
      and responsibility.effective_from <= clock_timestamp()
      and (responsibility.effective_to is null or responsibility.effective_to >= clock_timestamp())
    order by case responsibility_role.code when 'station_manager' then 1 else 2 end,
             responsibility.effective_from desc,
             responsibility.id
    limit 1;

    -- Ambiguous or missing People ownership is surfaced as a configuration
    -- issue by the existing routing layer; never guess a replacement here.
    if v_manager_user_id is null then
      continue;
    end if;

    -- A shift swap can wait for the partner before it reaches the manager.
    -- Its manager step is nevertheless already materialised, so refresh both
    -- the step and the compatibility field on the parent request immediately.
    update hr_roster_swap_approval_steps approval_step
    set approver_user_id = v_manager_user_id,
        approver_person_id = v_manager_person_id,
        original_approver_person_id = coalesce(
          approval_step.original_approver_person_id,
          approval_step.approver_person_id
        ),
        resolved_via = 'fallback',
        fallback_reason = 'Re-routed to the current People station manager after the station ownership changed.',
        updated_at = clock_timestamp()
    from hr_roster_swap_requests request
    join hr_roster_entries requester_entry
      on requester_entry.company_id = request.company_id
     and requester_entry.id = request.requester_entry_id
    where approval_step.company_id = p_company_id
      and approval_step.request_id = request.id
      and requester_entry.location_id = v_station_id
      and approval_step.status = 'pending'
      and request.status in ('pending_partner', 'pending_manager')
      and lower(coalesce(approval_step.step_name, '')) like '%manager%'
      and approval_step.approver_user_id is distinct from v_manager_user_id;

    update hr_roster_swap_requests request
    set approver_user_id = v_manager_user_id,
        updated_at = clock_timestamp()
    from hr_roster_entries requester_entry
    where request.company_id = p_company_id
      and requester_entry.company_id = request.company_id
      and requester_entry.id = request.requester_entry_id
      and requester_entry.location_id = v_station_id
      and request.status in ('pending_partner', 'pending_manager')
      and request.approver_user_id is distinct from v_manager_user_id;

  end loop;
end;
$$;

create or replace function public.sync_open_station_manager_approvals()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_station_ids uuid[];
begin
  v_company_id := case when tg_op = 'DELETE' then old.company_id else new.company_id end;
  v_station_ids := array_remove(array[
    case when tg_op in ('UPDATE', 'DELETE') then old.station_id end,
    case when tg_op in ('INSERT', 'UPDATE') then new.station_id end
  ], null);

  perform public.reconcile_open_station_manager_approvals(v_company_id, v_station_ids);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_open_station_manager_approvals
  on public.station_responsibility_assignments;
create trigger trg_sync_open_station_manager_approvals
after insert or update of assignee_user_id, assignment_id, is_primary, effective_from, effective_to or delete
on public.station_responsibility_assignments
for each row execute function public.sync_open_station_manager_approvals();

-- Repair all currently open snapshots, including approvals which are still
-- waiting for a swap partner and have therefore not entered the mail queue.
do $$
declare
  company record;
begin
  for company in
    select company_id, array_agg(id order by id) station_ids
    from stations
    where is_active = true
    group by company_id
  loop
    perform public.reconcile_open_station_manager_approvals(
      company.company_id,
      company.station_ids
    );
  end loop;
end;
$$;

comment on function public.reconcile_open_station_manager_approvals(uuid, uuid[]) is
  'Refreshes open station-level roster-swap approvers from the current People-backed station responsibility; preserves decisions and records the prior person for audit.';

commit;
