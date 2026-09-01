-- Repair the Owner-approved expense request that remained in an intermediate
-- approval state. Payment details remain empty for the requester to submit.
begin;

update public.payment_requests
set
  status = 'approved',
  approval_status = 'FINAL_APPROVED',
  current_step_order = 2,
  current_approver_user_id = null,
  current_approver_role_id = null,
  current_approver_role_ids = '{}',
  updated_at = now()
where upper(btrim(request_no)) = '6XPPMWD0BG';

notify pgrst, 'reload schema';

commit;
