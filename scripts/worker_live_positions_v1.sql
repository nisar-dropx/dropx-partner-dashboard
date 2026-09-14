begin;

-- Cheap, high-frequency "where is this worker right now" feed for a live map — deliberately
-- separate from attendance_location_samples, which is a compliance/anti-fraud audit trail
-- (geofence + integrity flags + continuous-outside-zone duration) and needs history, not just
-- a current point. One row per worker, upserted in place, so table size stays constant no
-- matter how often it's pinged — unlike attendance_location_samples, which grows forever.
create table if not exists public.worker_live_positions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  profile_type text not null,
  account_id uuid not null,
  lat numeric(10, 7) not null,
  lng numeric(10, 7) not null,
  accuracy_m numeric(10, 2),
  captured_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint worker_live_positions_profile_type_check check (
    profile_type in ('employee', 'contractor')
  )
);

-- The upsert target: one row per worker. Also serves as the live-map "list everyone" lookup.
create unique index if not exists worker_live_positions_worker_idx
  on public.worker_live_positions(company_id, profile_type, account_id);

alter table public.worker_live_positions enable row level security;

drop policy if exists "service_role_worker_live_positions_all"
  on public.worker_live_positions;
create policy "service_role_worker_live_positions_all"
  on public.worker_live_positions
  for all
  to service_role
  using (true)
  with check (true);

-- Compound index for the compliance heartbeat's own hot lookups (rate-limit check and
-- continuousOutsideMs's history scan both filter on exactly these columns) — this table has
-- no retention cleanup today and grows unbounded, so this index matters more over time, not
-- less. attendance_location_samples_enrol_time_idx (from attendance_gps_integrity_v1.sql)
-- already covers this; this is the equivalent covering the rate-limit check specifically.
create index if not exists attendance_location_samples_company_time_idx
  on public.attendance_location_samples(company_id, server_received_at desc);

commit;
