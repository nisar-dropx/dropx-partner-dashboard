-- Dark Store Site Summary snapshots for Live Performance portal
-- Written by workers/dark-store-ppi/site-summary-monitor.mjs on every poll.

create table if not exists public.ds_site_summary_snapshots (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null,
  station_code            text not null,
  fetched_at              timestamptz not null default now(),
  active_orders           int not null default 0,
  pending_acceptance      int not null default 0,
  breaching_count         int not null default 0,
  worst_elapsed_seconds   numeric(12,2),
  sla_seconds             int not null default 15,
  payload_json            jsonb not null default '{}'::jsonb,
  unique (company_id, station_code)
);

create table if not exists public.ds_site_summary_orders (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null,
  station_code            text not null,
  oid                     text not null,
  picker                  text,
  items                   int not null default 0,
  elapsed_seconds         numeric(12,2) not null default 0,
  pct_complete            numeric(6,2),
  status                  text,
  fetched_at              timestamptz not null default now(),
  unique (company_id, station_code, oid)
);

create index if not exists ds_site_summary_snapshots_lookup
  on public.ds_site_summary_snapshots (company_id, station_code, fetched_at desc);

create index if not exists ds_site_summary_orders_lookup
  on public.ds_site_summary_orders (company_id, station_code, fetched_at desc);

create index if not exists ds_site_summary_orders_elapsed
  on public.ds_site_summary_orders (company_id, station_code, elapsed_seconds desc);

alter table public.ds_site_summary_snapshots enable row level security;
alter table public.ds_site_summary_orders enable row level security;

revoke all on public.ds_site_summary_snapshots, public.ds_site_summary_orders from public, anon, authenticated;
grant all on public.ds_site_summary_snapshots, public.ds_site_summary_orders to service_role;
