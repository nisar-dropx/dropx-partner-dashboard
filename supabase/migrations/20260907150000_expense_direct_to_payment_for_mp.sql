-- Managing Partner / top-level expense claims: allow empty approval steps and
-- create the claim ready for immediate send-to-payment (finance in Payments).

begin;

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
  v_direct boolean := false;
begin
  if p_worker_type not in ('employee', 'contractor') then raise exception 'Unsupported worker type.'; end if;
  if length(trim(coalesce(p_purpose, ''))) < 3 then raise exception 'Purpose must contain at least 3 characters.'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Add at least one expense item.'; end if;
  if jsonb_typeof(p_steps) <> 'array' then raise exception 'Approval steps payload is invalid.'; end if;
  v_direct := jsonb_array_length(p_steps) = 0;
  select coalesce(sum((item->>'amount')::numeric), 0) into v_total from jsonb_array_elements(p_items) item;
  if v_total <= 0 then raise exception 'Claim total must be greater than zero.'; end if;

  if p_claim_request_id is null then
    raise exception 'Submit a reimbursement claim only against an approved request.';
  end if;
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
    case when v_direct then null else 1 end, now(), p_claim_request_id
  );
  for v_item in select * from jsonb_array_elements(p_items) loop
    insert into public.hr_expense_items(id, company_id, claim_id, category_id, expense_date, merchant, description, amount, sort_order)
    values(
      coalesce(nullif(v_item->>'id', '')::uuid, gen_random_uuid()), p_company_id, v_claim_id, (v_item->>'category_id')::uuid,
      (v_item->>'expense_date')::date, nullif(trim(v_item->>'merchant'), ''), trim(v_item->>'description'),
      (v_item->>'amount')::numeric, coalesce((v_item->>'sort_order')::integer, 100)
    );
  end loop;
  for v_step in select * from jsonb_array_elements(p_steps) loop
    insert into public.hr_expense_approval_steps(company_id, claim_id, step_order, step_name, approver_user_id, approver_person_id, status)
    values(
      p_company_id, v_claim_id, (v_step->>'step_order')::smallint, v_step->>'step_name',
      (v_step->>'approver_user_id')::uuid, nullif(v_step->>'approver_person_id', '')::uuid,
      case when (v_step->>'step_order')::smallint = 1 then 'pending' else 'waiting' end
    );
  end loop;
  update public.hr_expense_claim_requests
  set consumed_claim_id = v_claim_id, updated_at = now()
  where id = p_claim_request_id;
  insert into public.hr_expense_events(company_id, claim_id, event_type, to_status, actor_user_id, actor_name, comments, metadata)
  values(
    p_company_id, v_claim_id, 'submitted', 'pending_approval', p_claimant_user_id, null,
    case when v_direct then 'Claim submitted for direct finance payment' else 'Claim submitted' end,
    jsonb_build_object(
      'total', v_total,
      'item_count', jsonb_array_length(p_items),
      'claim_request_id', p_claim_request_id,
      'direct_to_payment', v_direct
    )
  );
  return v_claim_id;
end $$;

grant execute on function public.hr_submit_expense_claim(
  uuid, uuid, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, date, date, jsonb, jsonb, uuid
) to service_role;

update public.hr_approval_workflow_catalog
set description = 'Employee and contractor expense claims. Level 1 is the immediate reporting manager. Level 2 follows the reporting chain (for example Managing Partner), except when Level 1 is National Head or Business Head — that approval is final and Managing Partner is skipped. Managing Partner / top-level requesters skip manager approval and go directly to Payments/finance. Pre-request eligibility is separate: reporting manager or finance owners.',
    updated_at = now()
where workflow_code = 'reimbursement';

commit;
