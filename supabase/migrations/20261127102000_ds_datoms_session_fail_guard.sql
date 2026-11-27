-- Consecutive Datoms auth failures — stop login storms and alert ops over WhatsApp.
alter table public.ds_datoms_session
  add column if not exists login_fail_count integer not null default 0;

alter table public.ds_datoms_session
  add column if not exists ops_alerted_at timestamptz;

comment on column public.ds_datoms_session.login_fail_count is
  'Consecutive Datoms auth/login failures. Reset to 0 on success. At 3, login stops and ops is alerted.';

comment on column public.ds_datoms_session.ops_alerted_at is
  'When WhatsApp ops alert was last sent for Datoms auth failure (dedupe).';
