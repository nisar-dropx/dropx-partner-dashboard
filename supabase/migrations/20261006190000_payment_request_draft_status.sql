-- Ad hoc replacement requests are saved as 'draft' until their answers and
-- evidence are stored, then promoted to 'pending' (20261005212916). The status
-- check predates that and rejected the first insert, so no ad hoc expense or
-- payment request could be raised.
begin;

alter table public.payment_requests drop constraint if exists payment_requests_status_check;
alter table public.payment_requests
  add constraint payment_requests_status_check
  check (status in ('draft', 'pending', 'approved', 'processing', 'processed', 'rejected', 'returned', 'cancelled', 'resubmitted') or status like '%\_APPROVED' escape '\');

commit;
