-- Payment requests and payment advance requests had no reminder mechanism
-- (payment_requests: a one-shot unthreaded email on submit/approve/reject/
-- return only; payment_advance_requests: no email at all, only in-app push).
-- This adds one continuous email thread per request: the initial email,
-- every reminder, and the final approve/reject/return notice are all replies
-- to the same original message - never a fresh, separate email.
--
-- Threading state is stored directly on each request row rather than a
-- separate thread table, since a payment (advance) request only ever has one
-- active "waiting for a decision" conversation at a time (unlike dropx-hrms's
-- multi-step workflows, which can have several concurrent per-step threads).

alter table public.payment_requests
  add column if not exists email_root_message_id text,
  add column if not exists email_last_message_id text,
  add column if not exists email_send_count integer not null default 0,
  add column if not exists email_next_reminder_at timestamptz;

alter table public.payment_advance_requests
  add column if not exists email_root_message_id text,
  add column if not exists email_last_message_id text,
  add column if not exists email_send_count integer not null default 0,
  add column if not exists email_next_reminder_at timestamptz;

create index if not exists payment_requests_email_due_idx
  on public.payment_requests (email_next_reminder_at)
  where email_next_reminder_at is not null;

create index if not exists payment_advance_requests_email_due_idx
  on public.payment_advance_requests (email_next_reminder_at)
  where email_next_reminder_at is not null;

notify pgrst, 'reload schema';
