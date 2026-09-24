begin;

-- "Tech issue" carry-forward flow for Executive Reconciliation: when an
-- associate's cash entry can't be completed because of a technical problem
-- (device/app/network, not "will submit later" which is cod_cash_entry_
-- exceptions), the station raises it once with remarks + a photo, and it
-- stays open EVERY DAY until someone resolves it - not just the day it was
-- raised. Unlike cod_cash_entry_exceptions (which is business_date-scoped
-- and re-created per day), this table intentionally has no business_date in
-- its "is this still open" identity: a row's open/resolved state is looked
-- up per (company_id, location_id, provider_employee_id) regardless of the
-- current business_date, so the same incident naturally shows as open on
-- day 2, day 3, etc. without any daily copy/rollover job.
create table if not exists public.cod_tech_issues (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  location_id uuid not null,
  station_code text not null,
  provider_employee_id text not null,
  associate_name text not null,
  opened_business_date date not null,
  status text not null default 'Open' check (status in ('Open', 'Resolved')),
  remarks text not null,
  photo_storage_bucket text,
  photo_storage_path text,
  created_by uuid,
  created_by_name text,
  created_at timestamptz not null default now(),
  resolved_by uuid,
  resolved_by_name text,
  resolved_at timestamptz,
  updated_at timestamptz not null default now()
);

-- At most one OPEN tech issue per associate per location at a time - a new
-- report for the same associate while one is already open should update the
-- existing one, not create a duplicate (mirrors cod_cash_entry_exceptions'
-- own upsert-by-open-row pattern).
create unique index if not exists cod_tech_issues_open_unique_idx
  on public.cod_tech_issues (company_id, location_id, provider_employee_id)
  where status = 'Open';

create index if not exists cod_tech_issues_company_location_idx
  on public.cod_tech_issues (company_id, location_id, status);

alter table public.cod_tech_issues enable row level security;

drop policy if exists cod_tech_issues_service_role on public.cod_tech_issues;
create policy cod_tech_issues_service_role on public.cod_tech_issues
  for all to service_role using (true) with check (true);

commit;
