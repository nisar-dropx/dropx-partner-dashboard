-- Distributed login lease so Vercel cron / manual poll / worker never stampede /accounts/login.
alter table public.ds_datoms_session
  add column if not exists login_lock_until timestamptz;

comment on column public.ds_datoms_session.login_lock_until is
  'Exclusive lease while a process is attempting Datoms /accounts/login. Prevents parallel logins.';
