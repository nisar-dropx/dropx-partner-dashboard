-- DATOMS Operations Hub: L1 alerts, poll cursor, things snapshot, report cache.

alter table public.ds_datoms_alerts
  drop constraint if exists ds_datoms_alerts_level_check;

alter table public.ds_datoms_alerts
  add constraint ds_datoms_alerts_level_check check (level in ('L1', 'L2', 'L3'));

alter table public.ds_datoms_session
  add column if not exists last_events_poll_at timestamptz,
  add column if not exists last_things_poll_at timestamptz,
  add column if not exists last_reports_poll_at timestamptz;

create table if not exists public.ds_datoms_things_snapshot (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null,
  thing_id        text not null,
  station_code    text,
  name            text not null default '',
  category        text,
  site_name       text,
  online          boolean,
  metrics_json    jsonb not null default '{}'::jsonb,
  status_json     jsonb not null default '{}'::jsonb,
  raw_json        jsonb not null default '{}'::jsonb,
  observed_at     timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (company_id, thing_id)
);

create index if not exists ds_datoms_things_station
  on public.ds_datoms_things_snapshot (company_id, station_code, name);

create index if not exists ds_datoms_things_observed
  on public.ds_datoms_things_snapshot (company_id, observed_at desc);

alter table public.ds_datoms_things_snapshot enable row level security;
revoke all on public.ds_datoms_things_snapshot from public, anon, authenticated;
grant all on public.ds_datoms_things_snapshot to service_role;

create table if not exists public.ds_datoms_report_cache (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null,
  report_key      text not null,
  station_code    text,
  title           text,
  kind            text not null default 'table',
  payload_json    jsonb not null default '{}'::jsonb,
  observed_at     timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (company_id, report_key)
);

create index if not exists ds_datoms_report_station
  on public.ds_datoms_report_cache (company_id, station_code, observed_at desc);

alter table public.ds_datoms_report_cache enable row level security;
revoke all on public.ds_datoms_report_cache from public, anon, authenticated;
grant all on public.ds_datoms_report_cache to service_role;
