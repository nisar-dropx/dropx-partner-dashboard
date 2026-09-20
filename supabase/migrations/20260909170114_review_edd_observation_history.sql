-- Aggregate audit only; no package/customer data and no changes to source tables.
create table public.ops_review_edd_observations (
  company_id uuid not null,
  station_id uuid not null references public.stations(id),
  station_code text not null,
  work_date date not null,
  captured_slot timestamptz not null,
  observed_at timestamptz not null,
  source_at timestamptz,
  backlog_at timestamptz,
  performance_at timestamptz,
  counts jsonb not null check (jsonb_typeof(counts) = 'object'),
  rules_version integer not null default 1 check (rules_version = 1),
  primary key (company_id, station_id, work_date, captured_slot),
  check (work_date = (observed_at at time zone 'Asia/Kolkata')::date),
  check (observed_at >= captured_slot and observed_at < captured_slot + interval '5 minutes')
);
-- The station FK also needs an index for updates/deletes of parent station rows.
create index ops_review_edd_observations_station_idx on public.ops_review_edd_observations(station_id);
alter table public.ops_review_edd_observations enable row level security;
revoke all on public.ops_review_edd_observations from public, anon, authenticated;
revoke all on public.ops_review_edd_observations from service_role;
grant select, insert on public.ops_review_edd_observations to service_role;
comment on table public.ops_review_edd_observations is 'OpsPulse-only append-only EDD observations. Server review scope gate required. Missing past intervals are not inferred.';
