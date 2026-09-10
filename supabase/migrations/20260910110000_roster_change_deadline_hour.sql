-- Day-before clock lock for Connect swaps, OpsPulse and People roster edits.
-- HR configures this on Rostering Policy; default 16:00 IST (4:00 PM).

alter table public.hr_company_settings
  add column if not exists roster_change_deadline_hour smallint not null default 16;

alter table public.hr_company_settings
  drop constraint if exists hr_company_settings_roster_change_deadline_hour_check;

alter table public.hr_company_settings
  add constraint hr_company_settings_roster_change_deadline_hour_check
  check (roster_change_deadline_hour between 0 and 23);

comment on column public.hr_company_settings.roster_change_deadline_hour is
  'Hour of day (0-23) IST on the calendar day before a roster date when Connect swaps and Ops/People roster edits close. Default 16 (4:00 PM).';
