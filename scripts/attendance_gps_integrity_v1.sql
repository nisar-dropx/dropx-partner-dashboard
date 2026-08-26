begin;

-- Station geofence radius (admin-editable only; default 50m)
alter table public.stations
  add column if not exists geofence_radius_m integer not null default 50;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'stations_geofence_radius_m_check'
      and conrelid = 'public.stations'::regclass
  ) then
    alter table public.stations
      add constraint stations_geofence_radius_m_check
      check (geofence_radius_m >= 10 and geofence_radius_m <= 5000);
  end if;
end $$;

-- GPS / integrity columns on punches
alter table public.attendance_punches
  add column if not exists source text not null default 'biometric',
  add column if not exists lat numeric(10, 7),
  add column if not exists lng numeric(10, 7),
  add column if not exists accuracy_m numeric(10, 2),
  add column if not exists altitude_m numeric(10, 2),
  add column if not exists selfie_path text,
  add column if not exists client_captured_at timestamptz,
  add column if not exists server_received_at timestamptz,
  add column if not exists integrity_score numeric(5, 2),
  add column if not exists integrity_signals jsonb not null default '{}'::jsonb,
  add column if not exists geofence_status text,
  add column if not exists distance_m numeric(10, 2),
  add column if not exists is_flagged boolean not null default false;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'attendance_punches_source_check'
      and conrelid = 'public.attendance_punches'::regclass
  ) then
    alter table public.attendance_punches
      add constraint attendance_punches_source_check
      check (source in ('biometric', 'app_gps'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'attendance_punches_geofence_status_check'
      and conrelid = 'public.attendance_punches'::regclass
  ) then
    alter table public.attendance_punches
      add constraint attendance_punches_geofence_status_check
      check (geofence_status is null or geofence_status in ('inside', 'outside', 'unknown'));
  end if;
end $$;

update public.attendance_punches
set source = 'biometric'
where source is null or btrim(source) = '';

create index if not exists attendance_punches_company_flagged_idx
  on public.attendance_punches(company_id, punch_date desc, is_flagged)
  where is_flagged = true;

create index if not exists attendance_punches_company_source_idx
  on public.attendance_punches(company_id, source, punch_date desc);

-- In-shift location heartbeats
create table if not exists public.attendance_location_samples (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  enrolment_id text not null,
  profile_type text,
  profile_id uuid,
  location_id uuid references public.stations(id) on delete set null,
  session_id text,
  lat numeric(10, 7) not null,
  lng numeric(10, 7) not null,
  accuracy_m numeric(10, 2),
  altitude_m numeric(10, 2),
  outside_zone boolean not null default false,
  distance_m numeric(10, 2),
  integrity_signals jsonb not null default '{}'::jsonb,
  client_captured_at timestamptz,
  server_received_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists attendance_location_samples_enrol_time_idx
  on public.attendance_location_samples(company_id, enrolment_id, server_received_at desc);

create index if not exists attendance_location_samples_outside_idx
  on public.attendance_location_samples(company_id, enrolment_id, outside_zone, server_received_at desc);

alter table public.attendance_location_samples enable row level security;

drop policy if exists "service_role_attendance_location_samples_all"
  on public.attendance_location_samples;
create policy "service_role_attendance_location_samples_all"
  on public.attendance_location_samples
  for all
  to service_role
  using (true)
  with check (true);

-- Integrity flags (open until resolved by manager/HR)
create table if not exists public.attendance_integrity_flags (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  enrolment_id text not null,
  profile_type text,
  profile_id uuid,
  punch_id uuid references public.attendance_punches(id) on delete set null,
  location_id uuid references public.stations(id) on delete set null,
  punch_date date not null,
  flag_type text not null,
  severity text not null default 'medium',
  message text not null,
  details jsonb not null default '{}'::jsonb,
  status text not null default 'open',
  resolved_at timestamptz,
  resolved_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attendance_integrity_flags_type_check check (
    flag_type in (
      'outside_geofence_punch',
      'outside_geofence_gt_2h',
      'biometric_phone_mismatch',
      'integrity_risk',
      'forgot_punch_out',
      'pending_selfie_punch'
    )
  ),
  constraint attendance_integrity_flags_status_check check (
    status in ('open', 'resolved', 'dismissed')
  ),
  constraint attendance_integrity_flags_severity_check check (
    severity in ('low', 'medium', 'high')
  )
);

create index if not exists attendance_integrity_flags_open_idx
  on public.attendance_integrity_flags(company_id, punch_date desc, status)
  where status = 'open';

create index if not exists attendance_integrity_flags_profile_idx
  on public.attendance_integrity_flags(company_id, profile_type, profile_id, punch_date desc);

create unique index if not exists attendance_integrity_flags_open_unique
  on public.attendance_integrity_flags(company_id, enrolment_id, punch_date, flag_type)
  where status = 'open';

alter table public.attendance_integrity_flags enable row level security;

drop policy if exists "service_role_attendance_integrity_flags_all"
  on public.attendance_integrity_flags;
create policy "service_role_attendance_integrity_flags_all"
  on public.attendance_integrity_flags
  for all
  to service_role
  using (true)
  with check (true);

-- Support selfie + location packages for review
create table if not exists public.attendance_location_reviews (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  flag_id uuid references public.attendance_integrity_flags(id) on delete set null,
  punch_id uuid references public.attendance_punches(id) on delete set null,
  enrolment_id text not null,
  profile_type text not null,
  profile_id uuid not null,
  punch_date date not null,
  selfie_path text not null,
  lat numeric(10, 7) not null,
  lng numeric(10, 7) not null,
  accuracy_m numeric(10, 2),
  client_captured_at timestamptz,
  server_received_at timestamptz not null default now(),
  remarks text,
  status text not null default 'pending',
  review_remarks text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attendance_location_reviews_status_check check (
    status in ('pending', 'approved', 'returned', 'rejected')
  )
);

create index if not exists attendance_location_reviews_company_status_idx
  on public.attendance_location_reviews(company_id, status, punch_date desc);

create index if not exists attendance_location_reviews_profile_idx
  on public.attendance_location_reviews(company_id, profile_type, profile_id, punch_date desc);

create unique index if not exists attendance_location_reviews_open_unique
  on public.attendance_location_reviews (
    company_id,
    profile_type,
    profile_id,
    punch_date,
    (coalesce(flag_id, '00000000-0000-0000-0000-000000000000'::uuid))
  )
  where status in ('pending', 'returned');

alter table public.attendance_location_reviews enable row level security;

drop policy if exists "service_role_attendance_location_reviews_all"
  on public.attendance_location_reviews;
create policy "service_role_attendance_location_reviews_all"
  on public.attendance_location_reviews
  for all
  to service_role
  using (true)
  with check (true);

-- Admin page for integrity review queue
insert into public.app_pages (company_id, code, name, sort_order, is_active, created_at)
select companies.id, 'attendance_integrity', 'Attendance Integrity', 130, true, now()
from public.companies
where not exists (
  select 1
  from public.app_pages pages
  where pages.company_id = companies.id
    and pages.code = 'attendance_integrity'
);

-- Expand notification event check without wiping existing production event codes
do $$
declare
  allowed text;
begin
  if to_regclass('public.mob_app_notification_rules') is null then
    return;
  end if;

  select string_agg(quote_literal(code), ', ' order by code)
  into allowed
  from (
    select distinct event_code as code
    from public.mob_app_notification_rules
    where event_code is not null and btrim(event_code) <> ''
    union
    select unnest(array[
      'attendance_punch_in',
      'attendance_punch_out',
      'profile_submitted',
      'profile_approved',
      'profile_returned',
      'attendance_regularization_submitted',
      'attendance_location_flagged',
      'attendance_forgot_punch_out',
      'advance_request_raised',
      'advance_request_approved',
      'advance_request_rejected',
      'exit_request_raised',
      'exit_request_approved',
      'exit_request_rejected'
    ])
  ) codes;

  if allowed is null or btrim(allowed) = '' then
    allowed := '''attendance_punch_in'', ''attendance_punch_out'', ''profile_submitted'', ''profile_approved'', ''profile_returned'', ''attendance_regularization_submitted'', ''attendance_location_flagged'', ''attendance_forgot_punch_out'', ''advance_request_raised'', ''advance_request_approved'', ''advance_request_rejected'', ''exit_request_raised'', ''exit_request_approved'', ''exit_request_rejected''';
  end if;

  alter table public.mob_app_notification_rules
    drop constraint if exists mob_app_notification_rules_event_check;

  execute format(
    'alter table public.mob_app_notification_rules
       add constraint mob_app_notification_rules_event_check
       check (event_code in (%s))',
    allowed
  );
exception
  when undefined_table then null;
  when undefined_object then null;
end $$;

commit;
