-- One-off (2026-09-30), requested by HR: payment request 5Z6YU30FP9 (KOZA,
-- Vehicle Service, Rs 7,500) was waiting on UJJAL DUTTA a second time - he
-- approved it at 11:24 before the head's flow restarted the request. Record the
-- Business Head step as covered by that approval and finish approval, so the
-- request moves to Finance / Accounts for payment processing.

begin;

do $$
declare
  v_req uuid := 'aa1b59fa-c5e0-4a71-98b4-bce458329520';
  v_user uuid;
  v_role uuid;
  v_company uuid;
begin
  select current_approver_user_id, current_approver_role_id, company_id into v_user, v_role, v_company
  from public.payment_requests
  where id = v_req and request_no = '5Z6YU30FP9' and current_step_order = total_steps and status not in ('approved', 'rejected')
  for update;
  if v_user is null then raise exception '5Z6YU30FP9 is no longer waiting at its final approval step; nothing changed.'; end if;
  if not exists (select 1 from public.payment_request_approvals where payment_request_id = v_req and action = 'approved' and approver_user_id = v_user) then
    raise exception 'The current approver has not approved this request before; nothing changed.';
  end if;

  insert into public.payment_request_approvals (request_id, payment_request_id, company_id, sequence_no, role_code, status, action,
    approver_user_id, approver_role_id, decided_by, decided_at, approval_cycle, remarks, comments, created_at)
  values (v_req, v_req, v_company,
    (select coalesce(max(sequence_no), 0) + 1 from public.payment_request_approvals where payment_request_id = v_req),
    'OPERATIONS_BH', 'approved', 'approved', v_user, v_role, v_user, now(),
    (select approval_cycle from public.payment_requests where id = v_req),
    'Covered by the same approver''s 11:24 approval (before the flow restart)',
    'Covered by the same approver''s 11:24 approval (before the flow restart)', now());

  update public.payment_requests
  set status = 'approved', approval_status = 'FINAL_APPROVED',
      current_approver_user_id = null, current_approver_role_id = null, current_approver_role_ids = '{}',
      updated_at = now()
  where id = v_req;
end $$;

commit;
