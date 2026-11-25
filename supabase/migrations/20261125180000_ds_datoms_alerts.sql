-- Dark Store Datoms L2/L3 cold-chain alerts (Cloudflare worker ingest + OpsPulse live page).

create table if not exists public.ds_datoms_alerts (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null,
  dedupe_key      text not null,
  station_code    text not null,
  entity_id       text,
  generated_at    timestamptz not null,
  rule_name       text,
  level           text not null check (level in ('L2', 'L3')),
  title           text,
  site_name       text,
  asset_name      text,
  room_type       text,
  alert_text      text,
  caption         text,
  payload_json    jsonb not null default '{}'::jsonb,
  card_svg        text,
  notified_at     timestamptz,
  created_at      timestamptz not null default now(),
  unique (company_id, dedupe_key)
);

create index if not exists ds_datoms_alerts_lookup
  on public.ds_datoms_alerts (company_id, generated_at desc);

create index if not exists ds_datoms_alerts_station
  on public.ds_datoms_alerts (company_id, station_code, generated_at desc);

alter table public.ds_datoms_alerts enable row level security;

revoke all on public.ds_datoms_alerts from public, anon, authenticated;
grant all on public.ds_datoms_alerts to service_role;
