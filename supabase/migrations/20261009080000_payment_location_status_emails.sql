-- Station payment lifecycle emails are event-driven and retried by cron until
-- SMTP accepts them. These timestamps make the retry queue idempotent.
alter table public.payment_requests
  add column if not exists details_required_email_sent_at timestamptz,
  add column if not exists processed_email_sent_at timestamptz;

create index if not exists payment_requests_details_required_email_due_idx
  on public.payment_requests (company_id, updated_at)
  where details_required_email_sent_at is null
    and upper(coalesce(approval_status, '')) = 'FINAL_APPROVED';

create index if not exists payment_requests_processed_email_due_idx
  on public.payment_requests (company_id, updated_at)
  where processed_email_sent_at is null
    and upper(coalesce(status, '')) = 'PROCESSED';
