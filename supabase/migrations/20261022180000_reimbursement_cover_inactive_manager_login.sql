-- When the live People reporting manager has no active DropX One login
-- (profiles.is_active = false), still resolve their person id and honour an
-- active acting cover before refusing the claim. This unblocks reportees of
-- managers who were deactivated while cover points at the next manager.

create or replace function public.hr_enforce_reimbursement_people_manager_chain()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_claim public.hr_expense_claims%rowtype;
  v_manager_position integer;
  v_subject_assignment_id uuid;
  v_manager_assignment_id uuid;
  v_manager_person_id uuid;
  v_manager_user_id uuid;
  v_cover_person_id uuid;
  v_cover_user_id uuid;
  v_cover_reason text;
  v_original_person_id uuid := new.approver_person_id;
  v_today date := (clock_timestamp() at time zone 'Asia/Kolkata')::date;
  v_index integer;
begin
  if coalesce(new.stage_code, case
    when lower(coalesce(new.step_name, '')) like '%finance%' then 'finance'
    when lower(coalesce(new.step_name, '')) like '%policy%exception%' or lower(coalesce(new.step_name, '')) like '%policy%excess%' then 'policy_exception'
    else 'manager'
  end) <> 'manager' then
    return new;
  end if;

  if tg_op = 'UPDATE' and old.decided_at is not null then
    return new;
  end if;

  select * into v_claim
  from public.hr_expense_claims
  where company_id = new.company_id and id = new.claim_id;
  if not found then
    raise exception 'The reimbursement claim for this approval step was not found.';
  end if;

  select count(*) + 1 into v_manager_position
  from public.hr_expense_approval_steps step
  where step.company_id = new.company_id
    and step.claim_id = new.claim_id
    and step.step_order < new.step_order
    and coalesce(step.stage_code, case
      when lower(coalesce(step.step_name, '')) like '%finance%' then 'finance'
      when lower(coalesce(step.step_name, '')) like '%policy%exception%' or lower(coalesce(step.step_name, '')) like '%policy%excess%' then 'policy_exception'
      else 'manager'
    end) = 'manager';

  if v_manager_position > 2 then
    new.status := 'skipped';
    new.decision_note := coalesce(new.decision_note, 'Skipped — reimbursement policy permits at most two People manager approvals.');
    new.decided_at := coalesce(new.decided_at, clock_timestamp());
    new.fallback_reason := coalesce(new.fallback_reason, 'Additional manager layer is not part of the reimbursement policy.');
    return new;
  end if;

  v_subject_assignment_id := v_claim.assignment_id;
  for v_index in 1..v_manager_position loop
    v_manager_assignment_id := null;
    select relationship.manager_assignment_id into v_manager_assignment_id
    from public.hr_reporting_relationships relationship
    where relationship.company_id = new.company_id
      and relationship.subject_assignment_id = v_subject_assignment_id
      and relationship.relationship_type = 'solid_line'
      and relationship.is_primary
      and relationship.effective_from <= v_today
      and (relationship.effective_to is null or relationship.effective_to >= v_today)
    order by relationship.effective_from desc
    limit 1;

    if v_manager_assignment_id is null then
      exit;
    end if;
    v_subject_assignment_id := v_manager_assignment_id;
  end loop;

  if v_manager_assignment_id is null then
    if v_manager_position = 1 then
      raise exception 'Configure an active People reporting manager before submitting a reimbursement.';
    end if;
    new.status := 'skipped';
    new.decision_note := coalesce(new.decision_note, 'Skipped — no second reporting-manager layer exists in People.');
    new.decided_at := coalesce(new.decided_at, clock_timestamp());
    new.fallback_reason := coalesce(new.fallback_reason, 'No second People reporting-manager layer.');
    return new;
  end if;

  -- Person first (even when login is inactive), then optional active login.
  select engagement.person_id into v_manager_person_id
  from public.hr_work_assignments assignment
  join public.hr_engagements engagement
    on engagement.company_id = assignment.company_id
   and engagement.id = assignment.engagement_id
   and engagement.status = 'active'
  join public.hr_people person
    on person.company_id = engagement.company_id
   and person.id = engagement.person_id
   and person.status = 'active'
  where assignment.company_id = new.company_id
    and assignment.id = v_manager_assignment_id
    and assignment.is_primary
    and assignment.effective_from <= v_today
    and (assignment.effective_to is null or assignment.effective_to >= v_today)
  limit 1;

  if v_manager_person_id is null then
    if v_manager_position = 1 then
      raise exception 'Configure an active People reporting manager before submitting a reimbursement.';
    end if;
    new.status := 'skipped';
    new.decision_note := coalesce(new.decision_note, 'Skipped — no second reporting-manager layer exists in People.');
    new.decided_at := coalesce(new.decided_at, clock_timestamp());
    new.fallback_reason := coalesce(new.fallback_reason, 'No second People reporting-manager layer.');
    return new;
  end if;

  select profile.id into v_manager_user_id
  from public.hr_user_person_links link
  join public.profiles profile
    on profile.company_id = link.company_id
   and profile.id = link.user_id
   and profile.is_active
  where link.company_id = new.company_id
    and link.person_id = v_manager_person_id
    and link.status = 'active'
  limit 1;

  -- Active acting / leave cover replaces the live manager for open steps,
  -- including when the covered manager's DropX One login is inactive.
  select cover.delegate_person_id, cover.reason
    into v_cover_person_id, v_cover_reason
  from public.hr_approval_delegations cover
  where cover.company_id = new.company_id
    and cover.approver_person_id = v_manager_person_id
    and cover.is_active
    and cover.effective_from <= v_today
    and cover.effective_to >= v_today
    and (cover.workflow_code is null or cover.workflow_code = 'reimbursement')
  order by (cover.workflow_code is not null) desc, cover.effective_from desc
  limit 1;

  if v_cover_person_id is not null then
    select profile.id into v_cover_user_id
    from public.hr_user_person_links link
    join public.profiles profile
      on profile.company_id = link.company_id
     and profile.id = link.user_id
     and profile.is_active
    where link.company_id = new.company_id
      and link.person_id = v_cover_person_id
      and link.status = 'active'
    limit 1;

    if v_cover_user_id is not null then
      new.approver_user_id := v_cover_user_id;
      new.approver_person_id := v_cover_person_id;
      new.step_name := case when v_manager_position = 1 then 'Reporting manager approval' else 'Next reporting manager approval' end;
      new.resolved_via := 'delegation';
      new.original_approver_person_id := coalesce(new.original_approver_person_id, v_manager_person_id);
      new.fallback_reason := coalesce(v_cover_reason, 'Acting cover from Approval Workflow Master.');
      return new;
    end if;
  end if;

  if v_manager_user_id is null then
    if v_manager_position = 1 then
      raise exception 'The People reporting manager needs an active DropX One login before submitting a reimbursement.';
    end if;
    new.status := 'skipped';
    new.decision_note := coalesce(new.decision_note, 'Skipped — the second People reporting manager has no active DropX One login.');
    new.decided_at := coalesce(new.decided_at, clock_timestamp());
    new.fallback_reason := coalesce(new.fallback_reason, 'Second People reporting manager has no active DropX One login.');
    return new;
  end if;

  if new.approver_user_id is distinct from v_manager_user_id or new.approver_person_id is distinct from v_manager_person_id then
    new.approver_user_id := v_manager_user_id;
    new.approver_person_id := v_manager_person_id;
    new.step_name := case when v_manager_position = 1 then 'Reporting manager approval' else 'Next reporting manager approval' end;
    new.resolved_via := 'fallback';
    new.original_approver_person_id := coalesce(new.original_approver_person_id, v_original_person_id);
    new.fallback_reason := 'Re-routed to the current People reporting manager by reimbursement policy.';
  end if;
  return new;
end;
$function$;
