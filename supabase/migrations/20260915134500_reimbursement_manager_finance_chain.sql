-- Reimbursement claims follow the reporting hierarchy and always end with a
-- distinct Finance policy decision. Only that Finance approval may release a
-- claim into Payment Processing.

begin;

alter table public.hr_expense_approval_steps
  add column if not exists stage_code text;

alter table public.hr_expense_approval_steps
  drop constraint if exists hr_expense_approval_steps_stage_code_check;
alter table public.hr_expense_approval_steps
  add constraint hr_expense_approval_steps_stage_code_check
  check (stage_code is null or stage_code in ('manager', 'policy_exception', 'finance'));

comment on column public.hr_expense_approval_steps.stage_code is
  'Stable approval responsibility used by workflow logic; display labels remain editable.';

update public.hr_expense_approval_steps
set stage_code = case
  when lower(coalesce(step_name, '')) like '%finance%' then 'finance'
  when lower(coalesce(step_name, '')) like '%policy%exception%' or lower(coalesce(step_name, '')) like '%policy%excess%' then 'policy_exception'
  else 'manager'
end
where stage_code is null;

do $$
declare
  v_company record;
  v_finance_designation_id uuid;
  v_finance_person_id uuid;
begin
  for v_company in
    select distinct company_id
    from public.hr_approval_workflow_routes
    where workflow_code = 'reimbursement' and is_active
  loop
    select designation.id into v_finance_designation_id
    from public.designations designation
    where designation.company_id = v_company.company_id
      and designation.is_active
      and (
        upper(replace(coalesce(designation.code, ''), '-', '_')) in ('FINMGR', 'FINANCE_MANAGER')
        or lower(designation.name) = 'finance manager'
      )
    order by case when upper(replace(coalesce(designation.code, ''), '-', '_')) = 'FINMGR' then 0 else 1 end,
             designation.name, designation.id
    limit 1;

    if v_finance_designation_id is null then
      raise exception 'An active Finance Manager designation is required before reimbursement routes can be upgraded.';
    end if;

    select engagement.person_id into v_finance_person_id
    from public.hr_work_assignments assignment
    join public.hr_engagements engagement
      on engagement.company_id = assignment.company_id
     and engagement.id = assignment.engagement_id
     and engagement.status = 'active'
    join public.hr_user_person_links link
      on link.company_id = engagement.company_id
     and link.person_id = engagement.person_id
     and link.status = 'active'
    join public.profiles profile
      on profile.company_id = link.company_id
     and profile.id = link.user_id
     and profile.is_active
    where assignment.company_id = v_company.company_id
      and assignment.designation_id = v_finance_designation_id
      and assignment.is_primary
      and assignment.effective_from <= current_date
      and (assignment.effective_to is null or assignment.effective_to >= current_date)
    order by assignment.effective_from desc, engagement.person_id
    limit 1;

    if v_finance_person_id is null then
      raise exception 'An active Finance Manager with a One/People login is required before reimbursement routes can be upgraded.';
    end if;

    update public.hr_approval_workflow_routes
    set level_1_search_scope = 'immediate_reporting_manager',
        level_1_fallback_mode = 'next_reporting_manager',
        level_2_required = true,
        level_2_search_scope = 'reporting_chain',
        level_2_fallback_mode = 'next_reporting_manager',
        hr_final_required = true,
        hr_final_designation_id = v_finance_designation_id,
        hr_final_search_scope = 'same_location',
        hr_final_fallback_mode = 'specific_person',
        hr_final_fallback_person_id = v_finance_person_id,
        skip_managing_partner_after_senior_head = false,
        updated_at = now()
    where company_id = v_company.company_id
      and workflow_code = 'reimbursement'
      and is_active;
  end loop;
end $$;

update public.hr_approval_workflow_catalog
set description = 'Reimbursement claim: first reporting manager, second reporting manager when present, configured policy-exception approver when required, then Finance approval. Managing Partner participates only when they are an actual reporting-manager layer. Finance approval releases the eligible amount into Payment Processing.',
    no_route_fallback_name = 'Blocked until a reimbursement route and Finance final approver are configured',
    updated_at = now()
where workflow_code = 'reimbursement';

create or replace function public.hr_expense_stage_for_step(p_company_id uuid, p_step jsonb)
returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    nullif(p_step->>'stage_code', ''),
    case
      when exists (
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
         and assignment.effective_from <= current_date
         and (assignment.effective_to is null or assignment.effective_to >= current_date)
        join public.designations designation on designation.id = assignment.designation_id
        where link.company_id = p_company_id
          and link.user_id = nullif(p_step->>'approver_user_id', '')::uuid
          and link.status = 'active'
          and (
            upper(replace(coalesce(designation.code, ''), '-', '_')) in ('FINMGR', 'FINANCE_MANAGER')
            or lower(designation.name) = 'finance manager'
          )
      ) then 'finance'
      when lower(coalesce(p_step->>'step_name', '')) like '%policy%exception%'
        or lower(coalesce(p_step->>'step_name', '')) like '%policy%excess%' then 'policy_exception'
      else 'manager'
    end
  )
$$;

create or replace function public.hr_submit_expense_claim(
  p_company_id uuid,
  p_claim_id uuid,
  p_worker_type text,
  p_worker_id uuid,
  p_claimant_person_id uuid,
  p_claimant_user_id uuid,
  p_assignment_id uuid,
  p_location_id uuid,
  p_designation_id uuid,
  p_policy_id uuid,
  p_payment_head_id uuid,
  p_purpose text,
  p_trip_from date,
  p_trip_to date,
  p_items jsonb,
  p_steps jsonb,
  p_claim_request_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_claim_id uuid := coalesce(p_claim_id, gen_random_uuid());
  v_claim_no text;
  v_total numeric(12,2);
  v_item jsonb;
  v_step jsonb;
  v_request public.hr_expense_claim_requests%rowtype;
  v_snapshot jsonb;
  v_item_amount numeric;
  v_eligible_amount numeric;
begin
  if p_worker_type not in ('employee', 'contractor') then raise exception 'Unsupported worker type.'; end if;
  if length(trim(coalesce(p_purpose, ''))) < 3 then raise exception 'Purpose must contain at least 3 characters.'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Add at least one expense item.'; end if;
  if jsonb_typeof(p_steps) <> 'array' or jsonb_array_length(p_steps) = 0 then raise exception 'No approval step is configured.'; end if;
  if not exists (
    select 1 from jsonb_array_elements(p_steps) step
    where public.hr_expense_stage_for_step(p_company_id, step) = 'finance'
  ) then raise exception 'A final Finance approval step is required.'; end if;
  select coalesce(sum((item->>'amount')::numeric), 0) into v_total from jsonb_array_elements(p_items) item;
  if v_total <= 0 then raise exception 'Claim total must be greater than zero.'; end if;

  if p_claim_request_id is null then raise exception 'Submit a reimbursement claim only against an approved request.'; end if;
  select * into v_request from public.hr_expense_claim_requests
  where company_id = p_company_id and id = p_claim_request_id for update;
  if not found then raise exception 'Reimbursement request was not found.'; end if;
  if v_request.status <> 'approved' then raise exception 'Only an approved reimbursement request can be claimed.'; end if;
  if v_request.consumed_claim_id is not null then raise exception 'This reimbursement request already has a claim.'; end if;
  if v_request.worker_type <> p_worker_type
     or (p_worker_type = 'employee' and v_request.employee_id is distinct from p_worker_id)
     or (p_worker_type = 'contractor' and v_request.contractor_id is distinct from p_worker_id) then
    raise exception 'This reimbursement request belongs to another person.';
  end if;

  v_claim_no := 'ER-' || to_char(clock_timestamp(), 'YYYYMMDD') || '-' || upper(substr(replace(v_claim_id::text, '-', ''), 1, 8));
  insert into public.hr_expense_claims(
    id, company_id, claim_no, worker_type, employee_id, contractor_id, claimant_person_id, claimant_user_id,
    assignment_id, location_id, designation_id, policy_id, payment_head_id, purpose, trip_from, trip_to,
    total_claimed, status, current_step, submitted_at, claim_request_id
  ) values (
    v_claim_id, p_company_id, v_claim_no, p_worker_type,
    case when p_worker_type = 'employee' then p_worker_id end,
    case when p_worker_type = 'contractor' then p_worker_id end,
    p_claimant_person_id, p_claimant_user_id, p_assignment_id, p_location_id, p_designation_id,
    p_policy_id, p_payment_head_id, trim(p_purpose), p_trip_from, p_trip_to, v_total, 'pending_approval',
    1, now(), p_claim_request_id
  );

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_item_amount := (v_item->>'amount')::numeric;
    v_snapshot := case when jsonb_typeof(v_item->'finance_policy_snapshot') = 'object' then v_item->'finance_policy_snapshot' end;
    v_eligible_amount := least(v_item_amount, greatest(0, coalesce(nullif(v_snapshot->>'eligible_amount', '')::numeric, v_item_amount)));
    insert into public.hr_expense_items(
      id, company_id, claim_id, category_id, expense_date, merchant, description, amount, quantity,
      approved_amount, finance_policy_snapshot, sort_order
    ) values (
      coalesce(nullif(v_item->>'id', '')::uuid, gen_random_uuid()), p_company_id, v_claim_id,
      (v_item->>'category_id')::uuid, (v_item->>'expense_date')::date,
      nullif(trim(v_item->>'merchant'), ''), trim(v_item->>'description'), v_item_amount,
      nullif(v_item->>'quantity', '')::numeric, v_eligible_amount, v_snapshot,
      coalesce((v_item->>'sort_order')::integer, 100)
    );
  end loop;

  for v_step in select * from jsonb_array_elements(p_steps) loop
    insert into public.hr_expense_approval_steps(
      company_id, claim_id, step_order, step_name, stage_code, approver_user_id, approver_person_id,
      status, route_id, resolved_via, original_approver_person_id, fallback_reason
    ) values (
      p_company_id, v_claim_id, (v_step->>'step_order')::smallint, v_step->>'step_name', public.hr_expense_stage_for_step(p_company_id, v_step),
      (v_step->>'approver_user_id')::uuid, nullif(v_step->>'approver_person_id', '')::uuid,
      case when (v_step->>'step_order')::smallint = 1 then 'pending' else 'waiting' end,
      nullif(v_step->>'route_id', '')::uuid, nullif(v_step->>'resolved_via', ''),
      nullif(v_step->>'original_approver_person_id', '')::uuid, nullif(v_step->>'fallback_reason', '')
    );
  end loop;

  update public.hr_expense_claim_requests set consumed_claim_id = v_claim_id, updated_at = now()
  where id = p_claim_request_id;
  insert into public.hr_expense_events(company_id, claim_id, event_type, to_status, actor_user_id, actor_name, comments, metadata)
  values (
    p_company_id, v_claim_id, 'submitted', 'pending_approval', p_claimant_user_id, null, 'Claim submitted',
    jsonb_build_object('total', v_total, 'item_count', jsonb_array_length(p_items), 'claim_request_id', p_claim_request_id)
  );
  return v_claim_id;
end $$;

create or replace function public.hr_resubmit_expense_claim(
  p_company_id uuid,
  p_claim_id uuid,
  p_worker_type text,
  p_worker_id uuid,
  p_actor_user_id uuid,
  p_policy_id uuid,
  p_payment_head_id uuid,
  p_purpose text,
  p_trip_from date,
  p_trip_to date,
  p_items jsonb,
  p_steps jsonb
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_claim public.hr_expense_claims%rowtype;
  v_total numeric(12,2);
  v_item jsonb;
  v_step jsonb;
  v_snapshot jsonb;
  v_item_amount numeric;
  v_eligible_amount numeric;
begin
  select * into v_claim from public.hr_expense_claims where company_id = p_company_id and id = p_claim_id for update;
  if not found or v_claim.status <> 'returned' then raise exception 'Only a returned reimbursement can be resubmitted.'; end if;
  if v_claim.worker_type <> p_worker_type
     or (p_worker_type = 'employee' and v_claim.employee_id <> p_worker_id)
     or (p_worker_type = 'contractor' and v_claim.contractor_id <> p_worker_id) then
    raise exception 'This reimbursement belongs to another person.';
  end if;
  if length(trim(coalesce(p_purpose, ''))) < 3 then raise exception 'Purpose must contain at least 3 characters.'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Add at least one expense item.'; end if;
  if jsonb_typeof(p_steps) <> 'array' or jsonb_array_length(p_steps) = 0 then raise exception 'No approval step is configured.'; end if;
  if not exists (
    select 1 from jsonb_array_elements(p_steps) step
    where public.hr_expense_stage_for_step(p_company_id, step) = 'finance'
  ) then raise exception 'A final Finance approval step is required.'; end if;
  select coalesce(sum((item->>'amount')::numeric), 0) into v_total from jsonb_array_elements(p_items) item;
  if v_total <= 0 then raise exception 'Claim total must be greater than zero.'; end if;

  delete from public.hr_expense_approval_steps where company_id = p_company_id and claim_id = p_claim_id;
  delete from public.hr_expense_items where company_id = p_company_id and claim_id = p_claim_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_item_amount := (v_item->>'amount')::numeric;
    v_snapshot := case when jsonb_typeof(v_item->'finance_policy_snapshot') = 'object' then v_item->'finance_policy_snapshot' end;
    v_eligible_amount := least(v_item_amount, greatest(0, coalesce(nullif(v_snapshot->>'eligible_amount', '')::numeric, v_item_amount)));
    insert into public.hr_expense_items(
      id, company_id, claim_id, category_id, expense_date, merchant, description, amount, quantity,
      approved_amount, finance_policy_snapshot, sort_order
    ) values (
      coalesce(nullif(v_item->>'id', '')::uuid, gen_random_uuid()), p_company_id, p_claim_id,
      (v_item->>'category_id')::uuid, (v_item->>'expense_date')::date,
      nullif(trim(v_item->>'merchant'), ''), trim(v_item->>'description'), v_item_amount,
      nullif(v_item->>'quantity', '')::numeric, v_eligible_amount, v_snapshot,
      coalesce((v_item->>'sort_order')::integer, 100)
    );
  end loop;

  for v_step in select * from jsonb_array_elements(p_steps) loop
    insert into public.hr_expense_approval_steps(
      company_id, claim_id, step_order, step_name, stage_code, approver_user_id, approver_person_id,
      status, route_id, resolved_via, original_approver_person_id, fallback_reason
    ) values (
      p_company_id, p_claim_id, (v_step->>'step_order')::smallint, v_step->>'step_name', public.hr_expense_stage_for_step(p_company_id, v_step),
      (v_step->>'approver_user_id')::uuid, nullif(v_step->>'approver_person_id', '')::uuid,
      case when (v_step->>'step_order')::smallint = 1 then 'pending' else 'waiting' end,
      nullif(v_step->>'route_id', '')::uuid, nullif(v_step->>'resolved_via', ''),
      nullif(v_step->>'original_approver_person_id', '')::uuid, nullif(v_step->>'fallback_reason', '')
    );
  end loop;

  update public.hr_expense_claims
  set policy_id = p_policy_id, payment_head_id = p_payment_head_id, purpose = trim(p_purpose),
      trip_from = p_trip_from, trip_to = p_trip_to, total_claimed = v_total, total_approved = null,
      status = 'pending_approval', current_step = 1, submitted_at = now(), decided_at = null,
      return_reason = null, rejection_reason = null, revision_no = revision_no + 1, updated_at = now()
  where id = p_claim_id;
  insert into public.hr_expense_events(company_id, claim_id, event_type, from_status, to_status, actor_user_id, comments, metadata)
  values (
    p_company_id, p_claim_id, 'resubmitted', 'returned', 'pending_approval', p_actor_user_id,
    'Claim corrected and resubmitted',
    jsonb_build_object('total', v_total, 'item_count', jsonb_array_length(p_items), 'revision_no', v_claim.revision_no + 1)
  );
  return p_claim_id;
end $$;

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
  v_payable_total numeric(12,2);
begin
  select claim.* into v_claim from public.hr_expense_claims claim
  where claim.company_id = p_company_id and claim.id = p_claim_id for update;
  if not found then raise exception 'Reimbursement claim was not found.'; end if;
  if v_claim.status <> 'pending_approval' then raise exception 'This claim is no longer awaiting approval.'; end if;
  if v_claim.payment_request_id is not null then return v_claim.payment_request_id; end if;
  if exists (
    select 1 from public.hr_expense_approval_steps step
    where step.company_id = p_company_id and step.claim_id = p_claim_id and step.status in ('pending', 'waiting')
  ) then raise exception 'This claim still has open approval steps.'; end if;
  if not exists (
    select 1 from public.hr_expense_approval_steps step
    where step.company_id = p_company_id and step.claim_id = p_claim_id
      and step.stage_code = 'finance' and step.status = 'approved'
  ) then raise exception 'Finance approval is required before Payment Processing.'; end if;

  select coalesce(sum(coalesce(item.approved_amount,
    nullif(item.finance_policy_snapshot->>'eligible_amount', '')::numeric, item.amount)), 0)
  into v_payable_total
  from public.hr_expense_items item
  where item.company_id = p_company_id and item.claim_id = p_claim_id;
  if v_payable_total <= 0 then raise exception 'The policy-eligible reimbursement amount must be greater than zero.'; end if;

  select profile.full_name, coalesce(profile.role::text, 'Finance') into v_actor_name, v_actor_role
  from public.profiles profile where profile.id = p_actor_user_id;
  select head.* into v_payment_head from public.payment_heads head
  where head.company_id = p_company_id and head.id = v_claim.payment_head_id and head.is_active;
  if not found or cardinality(v_payment_head.payment_process_role_ids) = 0 then
    raise exception 'The reimbursement payment processor roles are not configured.';
  end if;

  if v_claim.worker_type = 'employee' then
    select employee.full_name, employee.email, employee.mobile, employee.bank_account_no, employee.ifsc
    into v_worker_name, v_email, v_mobile, v_bank, v_ifsc
    from public.employees employee where employee.id = v_claim.employee_id;
  else
    select contractor.full_name, contractor.email, contractor.mobile, contractor.bank_account_no, contractor.ifsc_code
    into v_worker_name, v_email, v_mobile, v_bank, v_ifsc
    from public.contractors contractor where contractor.id = v_claim.contractor_id;
  end if;
  select station.station_code into v_location_code from public.stations station where station.id = v_claim.location_id;

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
  ) values (
    v_payment_id, p_company_id, v_request_no, v_claim.location_id, coalesce(v_location_code, 'HO'), coalesce(v_location_code, 'HO'),
    v_claim.payment_head_id, 'employee_reimbursement', current_date, v_worker_name, v_payable_total, v_payable_total,
    'account_transfer', v_bank, v_ifsc, v_worker_name, v_mobile, v_email,
    'Finance-approved reimbursement ' || v_claim.claim_no || ': ' || v_claim.purpose,
    'approved', 'APPROVED', 'PAYMENT', 1, null, null, '{}'::uuid[], '{}'::uuid[],
    v_payment_head.payment_process_role_ids, v_claim.claimant_user_id, 'employee_reimbursement', v_claim.id,
    'PEOPLE_HRMS_REIMBURSEMENT', v_claim.id::text,
    jsonb_build_object(
      'claim_no', v_claim.claim_no, 'purpose', v_claim.purpose, 'worker_type', v_claim.worker_type,
      'claimed_total', v_claim.total_claimed, 'policy_payable_total', v_payable_total,
      'released_by_finance_user_id', p_actor_user_id
    )
  );

  insert into public.payment_request_approvals(
    company_id, request_id, payment_request_id, sequence_no, role_code, status, decided_by, decided_at,
    remarks, approver_user_id, action, comments, created_at
  ) values (
    p_company_id, v_payment_id, v_payment_id, 1, 'FINANCE', 'approved', p_actor_user_id, now(),
    'Finance approved ' || v_claim.claim_no || ' for Payment Processing', p_actor_user_id, 'approved',
    'Finance approved policy-eligible reimbursement amount ' || v_payable_total::text, now()
  );

  update public.hr_expense_claims
  set status = 'approved_for_payment', total_approved = v_payable_total, current_step = null,
      decided_at = now(), payment_request_id = v_payment_id, updated_at = now()
  where id = p_claim_id;
  insert into public.hr_expense_events(company_id, claim_id, event_type, from_status, to_status, actor_user_id, actor_name, actor_role, comments, metadata)
  values (
    p_company_id, p_claim_id, 'sent_to_payment', 'pending_approval', 'approved_for_payment',
    p_actor_user_id, coalesce(v_actor_name, 'Finance'), coalesce(v_actor_role, 'Finance'),
    'Finance approved the claim and released it to Payment Processing.',
    jsonb_build_object('payment_request_id', v_payment_id, 'request_no', v_request_no,
      'claimed_total', v_claim.total_claimed, 'policy_payable_total', v_payable_total)
  );
  return v_payment_id;
end $$;

create or replace function public.hr_decide_expense_claim(
  p_company_id uuid,
  p_claim_id uuid,
  p_actor_user_id uuid,
  p_action text,
  p_note text default null
) returns table(claim_id uuid, claim_status text, next_approver_user_id uuid, payment_request_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_claim public.hr_expense_claims%rowtype;
  v_step public.hr_expense_approval_steps%rowtype;
  v_next public.hr_expense_approval_steps%rowtype;
  v_actor_name text;
  v_actor_role text;
  v_payment_id uuid;
  v_actor_person_id uuid;
  v_has_policy_exception boolean;
begin
  if p_action not in ('approved', 'returned', 'rejected') then raise exception 'Invalid decision.'; end if;
  if p_action in ('returned', 'rejected') and length(trim(coalesce(p_note, ''))) < 3 then raise exception 'A reason is required.'; end if;

  select claim.* into v_claim from public.hr_expense_claims claim
  where claim.company_id = p_company_id and claim.id = p_claim_id for update;
  if not found or v_claim.status <> 'pending_approval' then raise exception 'This claim is no longer awaiting approval.'; end if;
  select step.* into v_step from public.hr_expense_approval_steps step
  where step.company_id = p_company_id and step.claim_id = p_claim_id and step.status = 'pending'
  order by step.step_order limit 1 for update;
  if not found or v_step.approver_user_id <> p_actor_user_id then raise exception 'This approval step is assigned to another user.'; end if;

  select person_id into v_actor_person_id from public.hr_user_person_links
  where company_id = p_company_id and user_id = p_actor_user_id and status = 'active';
  if v_actor_person_id is not null and v_actor_person_id = v_claim.claimant_person_id then
    raise exception 'Self-approval is not allowed.';
  end if;

  select exists (
    select 1 from public.hr_expense_items item
    where item.company_id = p_company_id and item.claim_id = p_claim_id
      and item.finance_policy_snapshot->>'excess_action' = 'special_approval'
      and coalesce(nullif(item.finance_policy_snapshot->>'excess_amount', '')::numeric, 0) > 0
  ) into v_has_policy_exception;
  if p_action = 'approved'
     and v_has_policy_exception
     and v_step.stage_code in ('policy_exception', 'finance')
     and length(trim(coalesce(p_note, ''))) < 3 then
    raise exception 'Record the policy-exception decision before approving.';
  end if;

  select profile.full_name, coalesce(profile.role::text, 'Approver') into v_actor_name, v_actor_role
  from public.profiles profile where profile.id = p_actor_user_id;

  if p_action = 'returned' then
    update public.hr_expense_approval_steps
    set status = 'returned', decision_note = trim(p_note), decided_by = p_actor_user_id, decided_at = now(), updated_at = now()
    where id = v_step.id;
    update public.hr_expense_claims set status = 'returned', return_reason = trim(p_note), current_step = null, updated_at = now()
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
  set status = 'approved', decision_note = nullif(trim(coalesce(p_note, '')), ''),
      decided_by = p_actor_user_id, decided_at = now(), updated_at = now()
  where id = v_step.id;
  insert into public.hr_expense_events(company_id, claim_id, event_type, from_status, to_status, actor_user_id, actor_name, actor_role, comments, metadata)
  values (
    p_company_id, p_claim_id, 'approved', 'pending_approval', 'pending_approval',
    p_actor_user_id, v_actor_name, v_actor_role, nullif(trim(coalesce(p_note, '')), ''),
    jsonb_build_object('step_order', v_step.step_order, 'step_name', v_step.step_name, 'stage_code', v_step.stage_code)
  );

  select step.* into v_next from public.hr_expense_approval_steps step
  where step.company_id = p_company_id and step.claim_id = p_claim_id and step.status = 'waiting'
  order by step.step_order limit 1 for update;
  if found then
    update public.hr_expense_approval_steps set status = 'pending', updated_at = now() where id = v_next.id;
    update public.hr_expense_claims set current_step = v_next.step_order, updated_at = now() where id = p_claim_id;
    return query select p_claim_id, 'pending_approval'::text, v_next.approver_user_id, null::uuid;
    return;
  end if;

  if v_step.stage_code <> 'finance' then
    raise exception 'The final approval must be completed by Finance before Payment Processing.';
  end if;
  v_payment_id := public.hr_expense_claim_send_to_payment(p_company_id, p_claim_id, p_actor_user_id);
  return query select p_claim_id, 'approved_for_payment'::text, null::uuid, v_payment_id;
end $$;

revoke all on function public.hr_submit_expense_claim(uuid, uuid, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, date, date, jsonb, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.hr_resubmit_expense_claim(uuid, uuid, text, uuid, uuid, uuid, uuid, text, date, date, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.hr_expense_claim_send_to_payment(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.hr_decide_expense_claim(uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.hr_expense_stage_for_step(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.hr_submit_expense_claim(uuid, uuid, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, date, date, jsonb, jsonb, uuid) to service_role;
grant execute on function public.hr_resubmit_expense_claim(uuid, uuid, text, uuid, uuid, uuid, uuid, text, date, date, jsonb, jsonb) to service_role;
grant execute on function public.hr_expense_claim_send_to_payment(uuid, uuid, uuid) to service_role;
grant execute on function public.hr_decide_expense_claim(uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.hr_expense_stage_for_step(uuid, jsonb) to service_role;

commit;
