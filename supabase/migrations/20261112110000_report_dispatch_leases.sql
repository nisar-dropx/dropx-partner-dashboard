-- Service-role-only run table already has RLS and restricted grants.
alter table public.report_bot_lm_dispatch_runs
 add column if not exists lease_token uuid,
 add column if not exists lease_until timestamptz;
comment on column public.report_bot_lm_dispatch_runs.lease_until is
 'Fenced six-minute dispatch ownership; retries may claim only expired or released runs.';
