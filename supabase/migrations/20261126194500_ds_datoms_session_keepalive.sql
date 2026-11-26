-- Track Datoms session keep-alive pings (authenticated API use without re-login).
alter table public.ds_datoms_session
  add column if not exists last_keepalive_at timestamptz;

comment on column public.ds_datoms_session.last_keepalive_at is
  'Last successful authenticated Datoms API call using the stored token (idle keep-alive).';
