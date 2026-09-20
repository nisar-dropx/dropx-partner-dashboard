-- When National Head / Business Head approves a reimbursement claim (L1),
-- skip remaining Managing Partner (L2) steps and send the claim to Payments.
-- Applies at decide-time (in-flight) and documents the AWM catalog rule.

begin;

update public.hr_approval_workflow_catalog
set description = 'Employee and contractor expense claims. Level 1 is the immediate reporting manager. Level 2 follows the reporting chain (for example Managing Partner), except when Level 1 is National Head or Business Head — that approval is final and Managing Partner is skipped. Pre-request eligibility is separate: reporting manager or finance owners.',
    no_route_fallback_name = 'Reporting manager chain from reimbursement policy',
    updated_at = now()
where workflow_code = 'reimbursement';

create or replace function public.hr_expense_claim_send_to_payment(
  p_company_id uuid,
  p_claim_id uuid,
  p_actor_user_id uuid
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_claim public.hr_expense_claims%rowtype;
  v_payment_head public.payment_heads%rowtype;
  v_payment_id uuid;
  v_request_no text;
  v_worker_name text;
  v_email text;
  v_mobile text;
  v_bank text;
  v_ifsc text;
  v_location_code text;
  v_actor_name text;
  v_actor_role text;
begin
  select claim.* into v_claim
  from public.hr_expense_claims claim
  where claim.company_id = p_company_id and claim.id = p_claim_id
  for update;
  if not found then raise exception 'Reimbursement claim was not found.'; end if;
  if v_claim.status <> 'pending_approval' then raise exception 'This claim is no longer awaiting approval.'; end if;
  if v_claim.payment_request_id is not null then return v_claim.payment_request_id; end if;
  if exists (
    select 1 from public.hr_expense_approval_steps step
    where step.company_id = p_company_id and step.claim_id = p_claim_id and step.status in ('pending', 'waiting')
  ) then
    raise exception 'This claim still has open approval steps.';
  end if;

  select profile.full_name, coalesce(profile.role::text, 'Approver')
  into v_actor_name, v_actor_role
  from public.profiles profile
  where profile.id = p_actor_user_id;

  select head.* into v_payment_head
  from public.payment_heads head
  where head.company_id = p_company_id and head.id = v_claim.payment_head_id and head.is_active;
  if not found or cardinality(v_payment_head.payment_process_role_ids) = 0 then
    raise exception 'The reimbursement payment processor roles are not configured.';
  end if;

  if v_claim.worker_type = 'employee' then
    select employee.full_name, employee.email, employee.mobile, employee.bank_account_no, employee.ifsc
    into v_worker_name, v_email, v_mobile, v_bank, v_ifsc
    from public.employees employee
    where employee.id = v_claim.employee_id;
  else
    select contractor.full_name, contractor.email, contractor.mobile, contractor.bank_account_no, contractor.ifsc_code
    into v_worker_name, v_email, v_mobile, v_bank, v_ifsc
    from public.contractors contractor
    where contractor.id = v_claim.contractor_id;
  end if;

  select station.station_code into v_location_code
  from public.stations station
  where station.id = v_claim.location_id;

  v_payment_id := gen_random_uuid();
  v_request_no := 'ER' || to_char(clock_timestamp(), 'YYMMDD') || upper(substr(replace(v_payment_id::text, '-', ''), 1, 4));

  if nullif(trim(coalesce(v_bank, '')), '') is null or nullif(trim(coalesce(v_ifsc, '')), '') is null then
    raise exception 'Bank account and IFSC must be completed before this reimbursement can be sent to Payments.';
  end if;

  insert into public.payment_requests(
    id, company_id, request_no, location_id, location_code, station_code, payment_head_id, category, work_date,
    requested_for_name, amount, amount_requested, payment_mode, bank_account_no, ifsc, account_holder_name,
    contact_no, email, remarks, status, approval_status, current_step, current_step_order,
    current_approver_user_id, current_approver_role_id, current_approver_role_ids, final_approval_role_ids,
    payment_process_role_ids, requested_by, source_type, source_id, source_system, source_record_id, details
  )
  values (
    v_payment_id, p_company_id, v_request_no, v_claim.location_id, coalesce(v_location_code, 'HO'), coalesce(v_location_code, 'HO'),
    v_claim.payment_head_id, 'employee_reimbursement', current_date, v_worker_name, v_claim.total_claimed, v_claim.total_claimed,
    'account_transfer', v_bank, v_ifsc, v_worker_name, v_mobile, v_email,
    'Approved reimbursement ' || v_claim.claim_no || ': ' || v_claim.purpose,
    'approved', 'APPROVED', 'PAYMENT', 1, null, null, '{}'::uuid[], '{}'::uuid[],
    v_payment_head.payment_process_role_ids, v_claim.claimant_user_id, 'employee_reimbursement', v_claim.id,
    'PEOPLE_HRMS_REIMBURSEMENT', v_claim.id::text,
    jsonb_build_object('claim_no', v_claim.claim_no, 'purpose', v_claim.purpose, 'worker_type', v_claim.worker_type)
  );

  insert into public.payment_request_approvals(
    company_id, request_id, payment_request_id, sequence_no, role_code, status, decided_by, decided_at,
    remarks, approver_user_id, action, comments, created_at
  )
  values (
    p_company_id, v_payment_id, v_payment_id, 1, 'MANAGER', 'approved', p_actor_user_id, now(),
    'Final manager approval for ' || v_claim.claim_no, p_actor_user_id, 'approved',
    'Final manager approval for ' || v_claim.claim_no, now()
  );

  update public.hr_expense_claims
  set status = 'approved_for_payment',
      total_approved = total_claimed,
      current_step = null,
      decided_at = now(),
      payment_request_id = v_payment_id,
      updated_at = now()
  where id = p_claim_id;

  insert into public.hr_expense_events(company_id, claim_id, event_type, from_status, to_status, actor_user_id, actor_name, actor_role, comments, metadata)
  values (
    p_company_id, p_claim_id, 'sent_to_payment', 'pending_approval', 'approved_for_payment',
    p_actor_user_id, coalesce(v_actor_name, 'System'), coalesce(v_actor_role, 'Approver'),
    'All approvals completed. Sent to Payments.',
    jsonb_build_object('payment_request_id', v_payment_id, 'request_no', v_request_no)
  );

  return v_payment_id;
end $$;

grant execute on function public.hr_expense_claim_send_to_payment(uuid, uuid, uuid) to service_role;

create or replace function public.hr_decide_expense_claim(
  p_company_id uuid,
  p_claim_id uuid,
  p_actor_user_id uuid,
  p_action text,
  p_note text default null
)
returns table(claim_id uuid, claim_status text, next_approver_user_id uuid, payment_request_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_claim public.hr_expense_claims%rowtype;
  v_step public.hr_expense_approval_steps%rowtype;
  v_next public.hr_expense_approval_steps%rowtype;
  v_actor_name text;
  v_actor_role text;
  v_payment_id uuid;
  v_actor_is_final_manager boolean := false;
begin
  if p_action not in ('approved', 'returned', 'rejected') then raise exception 'Invalid decision.'; end if;
  if p_action in ('returned', 'rejected') and length(trim(coalesce(p_note, ''))) < 3 then raise exception 'A reason is required.'; end if;

  select claim.* into v_claim
  from public.hr_expense_claims claim
  where claim.company_id = p_company_id and claim.id = p_claim_id
  for update;
  if not found or v_claim.status <> 'pending_approval' then raise exception 'This claim is no longer awaiting approval.'; end if;

  select step.* into v_step
  from public.hr_expense_approval_steps step
  where step.company_id = p_company_id and step.claim_id = p_claim_id and step.status = 'pending'
  order by step.step_order
  limit 1
  for update;
  if not found or v_step.approver_user_id <> p_actor_user_id then raise exception 'This approval step is assigned to another user.'; end if;

  select profile.full_name, coalesce(profile.role::text, 'Approver')
  into v_actor_name, v_actor_role
  from public.profiles profile
  where profile.id = p_actor_user_id;

  if p_action = 'returned' then
    update public.hr_expense_approval_steps
    set status = 'returned', decision_note = trim(p_note), decided_by = p_actor_user_id, decided_at = now(), updated_at = now()
    where id = v_step.id;
    update public.hr_expense_claims
    set status = 'returned', return_reason = trim(p_note), current_step = null, updated_at = now()
    where id = p_claim_id;
    insert into public.hr_expense_events(company_id, claim_id, event_type, from_status, to_status, actor_user_id, actor_name, actor_role, comments)
    values (p_company_id, p_claim_id, 'returned', 'pending_approval', 'returned', p_actor_user_id, v_actor_name, v_actor_role, trim(p_note));
    return query select p_claim_id, 'returned'::text, null::uuid, null::uuid;
    return;
  elsif p_action = 'rejected' then
    update public.hr_expense_approval_steps
    set status = 'rejected', decision_note = trim(p_note), decided_by = p_actor_user_id, decided_at = now(), updated_at = now()
    where id = v_step.id;
    update public.hr_expense_claims
    set status = 'rejected', rejection_reason = trim(p_note), current_step = null, decided_at = now(), updated_at = now()
    where id = p_claim_id;
    insert into public.hr_expense_events(company_id, claim_id, event_type, from_status, to_status, actor_user_id, actor_name, actor_role, comments)
    values (p_company_id, p_claim_id, 'rejected', 'pending_approval', 'rejected', p_actor_user_id, v_actor_name, v_actor_role, trim(p_note));
    return query select p_claim_id, 'rejected'::text, null::uuid, null::uuid;
    return;
  end if;

  update public.hr_expense_approval_steps
  set status = 'approved',
      decision_note = nullif(trim(coalesce(p_note, '')), ''),
      decided_by = p_actor_user_id,
      decided_at = now(),
      updated_at = now()
  where id = v_step.id;

  insert into public.hr_expense_events(company_id, claim_id, event_type, from_status, to_status, actor_user_id, actor_name, actor_role, comments, metadata)
  values (
    p_company_id, p_claim_id, 'approved', 'pending_approval', 'pending_approval',
    p_actor_user_id, v_actor_name, v_actor_role, nullif(trim(coalesce(p_note, '')), ''),
    jsonb_build_object('step_order', v_step.step_order, 'step_name', v_step.step_name)
  );

  -- National Head / Business Head approval is final for the manager chain —
  -- skip remaining Managing Partner (and any later waiting) steps.
  select exists (
    select 1
    from public.hr_user_person_links link
    join public.hr_engagements engagement
      on engagement.company_id = link.company_id
     and engagement.person_id = link.person_id
     and engagement.status = 'active'
    join public.hr_work_assignments assignment
      on assignment.company_id = engagement.company_id
     and assignment.engagement_id = engagement.id
     and assignment.is_primary
     and assignment.effective_to is null
    join public.designations designation
      on designation.id = assignment.designation_id
    where link.company_id = p_company_id
      and link.user_id = p_actor_user_id
      and link.status = 'active'
      and (
        upper(replace(coalesce(designation.code, ''), '-', '_')) in ('NH', 'BH', 'BUSINESS_HEAD', 'NATIONAL_HEAD')
        or lower(designation.name) like '%national head%'
        or lower(designation.name) like '%business head%'
      )
  ) into v_actor_is_final_manager;

  if v_actor_is_final_manager then
    update public.hr_expense_approval_steps step
    set status = 'skipped',
        decision_note = coalesce(step.decision_note, 'Skipped — National/Business Head approval is final'),
        updated_at = now()
    where step.company_id = p_company_id
      and step.claim_id = p_claim_id
      and step.status = 'waiting';

    insert into public.hr_expense_events(company_id, claim_id, event_type, from_status, to_status, actor_user_id, actor_name, actor_role, comments, metadata)
    values (
      p_company_id, p_claim_id, 'step_skipped', 'pending_approval', 'pending_approval',
      p_actor_user_id, v_actor_name, v_actor_role,
      'Managing Partner step skipped after National/Business Head approval.',
      jsonb_build_object('reason', 'nh_bh_final_manager')
    );
  end if;

  select step.* into v_next
  from public.hr_expense_approval_steps step
  where step.company_id = p_company_id and step.claim_id = p_claim_id and step.status = 'waiting'
  order by step.step_order
  limit 1
  for update;

  if found then
    update public.hr_expense_approval_steps set status = 'pending', updated_at = now() where id = v_next.id;
    update public.hr_expense_claims set current_step = v_next.step_order, updated_at = now() where id = p_claim_id;
    return query select p_claim_id, 'pending_approval'::text, v_next.approver_user_id, null::uuid;
    return;
  end if;

  v_payment_id := public.hr_expense_claim_send_to_payment(p_company_id, p_claim_id, p_actor_user_id);
  return query select p_claim_id, 'approved_for_payment'::text, null::uuid, v_payment_id;
end $$;

grant execute on function public.hr_decide_expense_claim(uuid, uuid, uuid, text, text) to service_role;

-- In-flight: skip Managing Partner after NH/BH already approved, then send ready claims to Payments.
with nh_bh_users as (
  select distinct link.company_id, link.user_id
  from public.hr_user_person_links link
  join public.hr_engagements engagement
    on engagement.company_id = link.company_id
   and engagement.person_id = link.person_id
   and engagement.status = 'active'
  join public.hr_work_assignments assignment
    on assignment.company_id = engagement.company_id
   and assignment.engagement_id = engagement.id
   and assignment.is_primary
   and assignment.effective_to is null
  join public.designations designation
    on designation.id = assignment.designation_id
  where link.status = 'active'
    and (
      upper(replace(coalesce(designation.code, ''), '-', '_')) in ('NH', 'BH', 'BUSINESS_HEAD', 'NATIONAL_HEAD')
      or lower(designation.name) like '%national head%'
      or lower(designation.name) like '%business head%'
    )
),
claims_with_nh_bh as (
  select distinct step.company_id, step.claim_id
  from public.hr_expense_approval_steps step
  join nh_bh_users actor
    on actor.company_id = step.company_id
   and actor.user_id = step.approver_user_id
  join public.hr_expense_claims claim
    on claim.company_id = step.company_id
   and claim.id = step.claim_id
   and claim.status = 'pending_approval'
  where step.status = 'approved'
),
mp_users as (
  select distinct link.company_id, link.user_id
  from public.hr_user_person_links link
  join public.hr_engagements engagement
    on engagement.company_id = link.company_id
   and engagement.person_id = link.person_id
   and engagement.status = 'active'
  join public.hr_work_assignments assignment
    on assignment.company_id = engagement.company_id
   and assignment.engagement_id = engagement.id
   and assignment.is_primary
   and assignment.effective_to is null
  join public.designations designation
    on designation.id = assignment.designation_id
  where link.status = 'active'
    and (
      upper(replace(coalesce(designation.code, ''), '-', '_')) in ('MP', 'MANAGING_PARTNER')
      or lower(designation.name) like '%managing partner%'
    )
)
update public.hr_expense_approval_steps step
set status = 'skipped',
    decision_note = coalesce(step.decision_note, 'Skipped — National/Business Head approval is final'),
    updated_at = now()
from claims_with_nh_bh claim
where step.company_id = claim.company_id
  and step.claim_id = claim.claim_id
  and step.status in ('waiting', 'pending')
  and (
    lower(coalesce(step.step_name, '')) like '%managing partner%'
    or exists (
      select 1 from mp_users mp
      where mp.company_id = step.company_id and mp.user_id = step.approver_user_id
    )
  );

do $$
declare
  r record;
  v_actor uuid;
  v_payment uuid;
begin
  for r in
    select claim.company_id, claim.id as claim_id
    from public.hr_expense_claims claim
    where claim.status = 'pending_approval'
      and claim.payment_request_id is null
      and not exists (
        select 1 from public.hr_expense_approval_steps step
        where step.company_id = claim.company_id
          and step.claim_id = claim.id
          and step.status in ('pending', 'waiting')
      )
      and exists (
        select 1 from public.hr_expense_approval_steps step
        where step.company_id = claim.company_id
          and step.claim_id = claim.id
          and step.status = 'skipped'
          and coalesce(step.decision_note, '') like '%National/Business Head%'
      )
  loop
    select step.decided_by into v_actor
    from public.hr_expense_approval_steps step
    where step.company_id = r.company_id
      and step.claim_id = r.claim_id
      and step.status = 'approved'
    order by step.step_order desc
    limit 1;

    if v_actor is null then
      continue;
    end if;

    begin
      v_payment := public.hr_expense_claim_send_to_payment(r.company_id, r.claim_id, v_actor);
    exception when others then
      raise notice 'Could not finalize reimbursement claim %: %', r.claim_id, sqlerrm;
    end;
  end loop;
end $$;

commit;
