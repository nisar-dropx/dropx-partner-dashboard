-- scripts/payment_requests_v1.sql's check constraints on payment_requests and
-- payment_request_approvals had both drifted out of sync with values the app
-- actually writes, ever since the script was last run against the live
-- database (it's a plain re-runnable setup script, not a tracked migration,
-- so nothing caught the drift automatically):
--
-- 1. payment_requests_payment_mode_check only allowed
--    ('account_transfer', 'online_payment') - missing 'upi_payment', which
--    155+ existing rows already use and payment-modes.ts has treated as a
--    first-class mode for a while. Re-running the old script reapplied the
--    narrower constraint and blocked every new UPI payment request.
-- 2. payment_request_approvals_action_check only allowed
--    ('approved', 'rejected', 'returned') - missing 'created', 'submitted',
--    'resubmitted', 'processing', 'processed', which together account for
--    roughly half of all existing approval log rows. Had this one also been
--    re-run, it would have blocked most of the approval/processing flow.
begin;

alter table public.payment_requests drop constraint if exists payment_requests_payment_mode_check;
alter table public.payment_requests
  add constraint payment_requests_payment_mode_check
  check (payment_mode in ('account_transfer', 'online_payment', 'upi_payment'));

alter table public.payment_request_approvals drop constraint if exists payment_request_approvals_action_check;
alter table public.payment_request_approvals
  add constraint payment_request_approvals_action_check
  check (action in ('approved', 'rejected', 'returned', 'created', 'submitted', 'resubmitted', 'processing', 'processed'));

commit;
