-- Fix ambiguous request_id in hr_decide_expense_claim_request (RETURNS TABLE out var vs column).

begin;

create or replace function public.hr_decide_expense_claim_request(
  p_company_id uuid,
  p_request_id uuid,
  p_actor_user_id uuid,
  p_action text,
  p_note text default null
) returns table(request_id uuid, request_status text)
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_request public.hr_expense_claim_requests%rowtype;
  v_assignee public.hr_expense_claim_request_assignees%rowtype;
begin
  if p_action not in ('approved','rejected') then raise exception 'Invalid pre-request decision.'; end if;
  if p_action='rejected' and length(trim(coalesce(p_note,'')))<3 then raise exception 'A reason is required when rejecting.'; end if;

  select claim_request.* into v_request
  from public.hr_expense_claim_requests claim_request
  where claim_request.company_id=p_company_id and claim_request.id=p_request_id
  for update;
  if not found or v_request.status<>'pending' then raise exception 'This reimbursement request is no longer awaiting approval.'; end if;

  select assignee.* into v_assignee
  from public.hr_expense_claim_request_assignees assignee
  where assignee.company_id=p_company_id
    and assignee.request_id=p_request_id
    and assignee.approver_user_id=p_actor_user_id
    and assignee.status='pending'
  for update;
  if not found then raise exception 'This reimbursement request is assigned to another approver.'; end if;

  update public.hr_expense_claim_request_assignees assignee
  set status=p_action,
      decision_note=nullif(trim(coalesce(p_note,'')),''),
      decided_at=now(),
      updated_at=now()
  where assignee.id=v_assignee.id;

  update public.hr_expense_claim_request_assignees assignee
  set status='skipped', updated_at=now()
  where assignee.company_id=p_company_id
    and assignee.request_id=p_request_id
    and assignee.status='pending'
    and assignee.id<>v_assignee.id;

  update public.hr_expense_claim_requests claim_request
  set status=p_action,
      decided_by=p_actor_user_id,
      decided_at=now(),
      decision_note=nullif(trim(coalesce(p_note,'')),''),
      updated_at=now()
  where claim_request.id=p_request_id;

  return query select p_request_id, p_action::text;
end $$;

grant execute on function public.hr_decide_expense_claim_request(uuid,uuid,uuid,text,text) to service_role;

commit;
