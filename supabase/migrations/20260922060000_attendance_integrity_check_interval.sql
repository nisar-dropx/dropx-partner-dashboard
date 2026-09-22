-- Makes the DropX One Android app's location/internet/developer-mode integrity check
-- interval a real, admin-editable HRMS setting instead of a hardcoded client-side constant.
-- Previously TrackingInterruptionReporter's threshold and any repeat-notification interval
-- lived only in Java source; this column is the single source of truth the app reads via
-- configureAttendance()'s response, alongside outside_station_allowance_minutes' existing
-- pattern on the same table.
begin;

alter table public.hr_company_settings
  add column if not exists integrity_check_interval_seconds integer not null default 30;

alter table public.hr_company_settings drop constraint if exists hr_company_settings_integrity_check_interval_range;
alter table public.hr_company_settings
  add constraint hr_company_settings_integrity_check_interval_range
  check (integrity_check_interval_seconds between 15 and 600);

comment on column public.hr_company_settings.integrity_check_interval_seconds is
  'How often (seconds) the DropX One Android app re-checks and, if a problem persists, re-notifies the worker and re-logs to HRMS for: location turned off, internet turned off, developer mode / USB debugging / mock location enabled. Editable from Attendance Integrity settings.';

commit;
