-- Pre-request: allow multiple finance-head assignees (Nisar + Jamsheer + RM).
-- Claimant may withdraw/cancel a pending reimbursement request.
-- Claim L2 returns to reporting-chain Managing Partner (not finance head).

begin;

alter table public.hr_expense_claim_request_assignees
  drop constraint if exists hr_expense_claim_request_assignees_company_id_request_id_assignee_role_key;

alter table public.hr_expense_claim_requests
  drop constraint if exists hr_expense_claim_requests_status_check;

alter table public.hr_expense_claim_requests
  add constraint hr_expense_claim_requests_status_check
  check (status in ('pending','approved','rejected','cancelled','withdrawn'));

create or replace function public.hr_withdraw_expense_claim_request(
  p_company_id uuid,
  p_request_id uuid,
  p_actor_user_id uuid,
  p_note text default null
) returns table(request_id uuid, request_status text)
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_request public.hr_expense_claim_requests%rowtype;
begin
  select claim_request.* into v_request
  from public.hr_expense_claim_requests claim_request
  where claim_request.company_id=p_company_id and claim_request.id=p_request_id
  for update;
  if not found then raise exception 'Reimbursement request was not found.'; end if;
  if v_request.status <> 'pending' then raise exception 'Only a pending reimbursement request can be withdrawn.'; end if;
  if v_request.claimant_user_id is distinct from p_actor_user_id then
    raise exception 'You can withdraw only your own reimbursement request.';
  end if;
  if v_request.consumed_claim_id is not null then
    raise exception 'This request already has a claim and cannot be withdrawn.';
  end if;
  if length(trim(coalesce(p_note,''))) < 3 then
    raise exception 'A reason is required to withdraw this reimbursement request.';
  end if;

  update public.hr_expense_claim_request_assignees assignee
  set status='skipped', updated_at=now()
  where assignee.company_id=p_company_id
    and assignee.request_id=p_request_id
    and assignee.status='pending';

  update public.hr_expense_claim_requests claim_request
  set status='withdrawn',
      decided_by=p_actor_user_id,
      decided_at=now(),
      decision_note=trim(p_note),
      updated_at=now()
  where claim_request.id=p_request_id;

  return query select p_request_id, 'withdrawn'::text;
end $$;

grant execute on function public.hr_withdraw_expense_claim_request(uuid,uuid,uuid,text) to service_role;

update public.hr_approval_workflow_catalog
set description = 'Employee and contractor expense claims. Level 1 is the immediate reporting manager. Level 2 follows the reporting chain (for example Managing Partner). Pre-request eligibility is separate: reporting manager or finance owners.',
    no_route_fallback_name = 'Reporting manager chain from reimbursement policy',
    updated_at = now()
where workflow_code = 'reimbursement';

-- Point seeded reimbursement L2 back to Managing Partner via reporting chain when that designation exists.
with managing_partner as (
  select company_id, id as designation_id
  from public.designations
  where is_active
    and (
      upper(replace(coalesce(code, ''), '-', '_')) in ('MANAGING_PARTNER', 'MP')
      or lower(name) like '%managing partner%'
    )
)
update public.hr_approval_workflow_routes route
set
  level_2_designation_id = managing_partner.designation_id,
  level_2_search_scope = 'reporting_chain',
  level_2_fallback_mode = 'next_reporting_manager',
  level_2_fallback_person_id = null,
  updated_at = now()
from managing_partner
where route.company_id = managing_partner.company_id
  and route.workflow_code = 'reimbursement'
  and route.is_active
  and route.requester_person_id is null
  and route.level_2_required;

commit;
