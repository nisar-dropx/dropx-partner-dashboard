-- Requesters can cancel their own payment request before anyone approves it, or after it is
-- returned to them (e.g. returned as a duplicate). The cancellation is recorded in the approval
-- history, so the action check needs 'cancelled'. payment_requests_status_check already allows
-- the 'cancelled' status.
begin;

alter table public.payment_request_approvals drop constraint if exists payment_request_approvals_action_check;
alter table public.payment_request_approvals
  add constraint payment_request_approvals_action_check
  check (action in ('approved', 'rejected', 'returned', 'created', 'submitted', 'resubmitted', 'processing', 'processed', 'cancelled'));

commit;
