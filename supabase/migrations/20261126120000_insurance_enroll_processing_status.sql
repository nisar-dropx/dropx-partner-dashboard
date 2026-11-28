-- Marsh enroll jobs stay in "processing" for up to 7 days while waiting for ecards.
-- The original check constraint omitted that status, so the worker update was ignored
-- and jobs bounced between running and queued.

begin;

alter table public.insurance_enroll_jobs
  drop constraint if exists insurance_enroll_jobs_status_check;

alter table public.insurance_enroll_jobs
  add constraint insurance_enroll_jobs_status_check
  check (status in ('queued', 'running', 'processing', 'succeeded', 'failed', 'skipped'));

-- Keep the open-job uniqueness across processing as well as queued/running.
drop index if exists public.insurance_enroll_jobs_open_uidx;
create unique index insurance_enroll_jobs_open_uidx
  on public.insurance_enroll_jobs (company_id, pan, policy_type)
  where status in ('queued', 'running', 'processing');

commit;
