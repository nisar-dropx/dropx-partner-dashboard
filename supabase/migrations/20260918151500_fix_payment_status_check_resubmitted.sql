-- A third stale value in scripts/payment_requests_v1.sql's constraints,
-- caught when the script was actually run: payment_requests_status_check
-- listed ('pending','approved','processing','processed','rejected',
-- 'returned','cancelled') plus an escape hatch for any '..._APPROVED' role
-- suffix, but was missing the plain 'resubmitted' status (3 existing rows),
-- which doesn't match either.
begin;

alter table public.payment_requests drop constraint if exists payment_requests_status_check;
alter table public.payment_requests
  add constraint payment_requests_status_check
  check (status in ('pending', 'approved', 'processing', 'processed', 'rejected', 'returned', 'cancelled', 'resubmitted') or status like '%\_APPROVED' escape '\');

commit;
