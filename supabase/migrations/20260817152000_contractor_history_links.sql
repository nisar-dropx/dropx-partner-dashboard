alter table public.attendance_daily
  add column if not exists contractor_id uuid references public.contractors(id) on delete set null;

alter table public.attendance_punches
  add column if not exists contractor_id uuid references public.contractors(id) on delete set null;

alter table public.biometric_alerts
  add column if not exists contractor_id uuid references public.contractors(id) on delete set null;

alter table public.biometric_enrolments
  add column if not exists contractor_id uuid references public.contractors(id) on delete set null;

alter table public.workforce_profile_change_requests
  add column if not exists contractor_id uuid references public.contractors(id) on delete cascade;

alter table public.workforce_onboarding_events
  drop constraint if exists workforce_onboarding_events_field_executive_id_fkey;
alter table public.workforce_onboarding_events
  alter column field_executive_id drop not null;
alter table public.workforce_onboarding_events
  add constraint workforce_onboarding_events_field_executive_id_fkey
  foreign key (field_executive_id) references public.field_executives(id) on delete set null;

alter table public.workforce_profile_change_requests
  drop constraint if exists workforce_profile_change_requests_field_executive_id_fkey;
alter table public.workforce_profile_change_requests
  alter column field_executive_id drop not null;
alter table public.workforce_profile_change_requests
  add constraint workforce_profile_change_requests_field_executive_id_fkey
  foreign key (field_executive_id) references public.field_executives(id) on delete set null;
