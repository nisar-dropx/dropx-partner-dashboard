-- Record which app an advance request was raised from, so approvers can tell
-- at a glance whether a request came through the workforce-facing One App
-- (Connect) or a future Ops/HRMS-initiated path, without guessing from the
-- station/requester alone. Surfaced in the advance request emails.

alter table public.payment_advance_requests
  add column if not exists source_app text not null default 'one_app'
  check (source_app in ('ops', 'one_app', 'hrms'));

notify pgrst, 'reload schema';
