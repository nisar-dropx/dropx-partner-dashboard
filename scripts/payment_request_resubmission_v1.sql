begin;

alter table public.payment_requests
  add column if not exists approval_cycle integer not null default 1;

alter table public.payment_request_approvals
  add column if not exists approval_cycle integer not null default 1;

alter table public.payment_requests drop constraint if exists payment_requests_status_check;
alter table public.payment_requests
  add constraint payment_requests_status_check
  check (
    lower(status) in (
      'pending', 'resubmitted', 'approved', 'processing', 'processed',
      'rejected', 'returned', 'cancelled'
    ) or upper(status) like '%_APPROVED'
  );

alter table public.payment_request_approvals drop constraint if exists payment_request_approvals_action_check;
alter table public.payment_request_approvals
  add constraint payment_request_approvals_action_check
  check (action in ('created', 'submitted', 'approved', 'rejected', 'returned', 'resubmitted', 'processing', 'processed', 'cancelled'));

create index if not exists payment_request_approvals_cycle_idx
  on public.payment_request_approvals (company_id, payment_request_id, approval_cycle, created_at);

commit;
