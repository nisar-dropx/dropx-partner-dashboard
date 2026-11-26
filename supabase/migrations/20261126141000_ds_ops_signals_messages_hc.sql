-- Dark Store ops signal rules (spikes), message urgency/frequency policies, HC planning targets.

create table if not exists public.ds_ops_signal_rules (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null,
  station_code      text, -- null = company default
  metric            text not null check (metric in ('active_orders', 'orders_per_hour', 'pending_acceptance')),
  baseline_days     int not null default 7 check (baseline_days between 1 and 28),
  threshold_pct     numeric(8,2) not null default 40 check (threshold_pct >= 0),
  min_samples       int not null default 3 check (min_samples >= 1),
  enabled           boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (company_id, station_code, metric)
);

create table if not exists public.ds_message_types (
  code              text primary key,
  label             text not null,
  description       text,
  workspace         text not null default 'dark_store',
  created_at        timestamptz not null default now()
);

create table if not exists public.ds_message_policies (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null,
  message_type      text not null references public.ds_message_types(code),
  urgency           text not null check (urgency in ('critical', 'high', 'normal', 'info')),
  frequency         text not null check (frequency in ('immediate', 'cooldown', 'digest', 'mute')),
  cooldown_minutes  int not null default 5 check (cooldown_minutes >= 0),
  quiet_start_minute int, -- minutes since midnight IST; null = no quiet hours
  quiet_end_minute   int,
  threshold_seconds numeric(12,2), -- e.g. acceptance SLA
  enabled           boolean not null default true,
  version           int not null default 1,
  updated_at        timestamptz not null default now(),
  unique (company_id, message_type)
);

create table if not exists public.ds_message_send_log (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null,
  message_type      text not null,
  station_code      text,
  policy_version    int not null default 1,
  sent_at           timestamptz not null default now(),
  dedupe_key        text,
  meta_json         jsonb not null default '{}'::jsonb
);

create index if not exists ds_message_send_log_lookup
  on public.ds_message_send_log (company_id, message_type, station_code, sent_at desc);

create table if not exists public.ds_hc_planning_targets (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null,
  station_code      text, -- null = company default
  orders_per_associate_hour numeric(10,2) not null default 12 check (orders_per_associate_hour > 0),
  target_ppt_seconds numeric(10,2),
  enabled           boolean not null default true,
  updated_at        timestamptz not null default now(),
  unique (company_id, station_code)
);

alter table public.ds_ops_signal_rules enable row level security;
alter table public.ds_message_types enable row level security;
alter table public.ds_message_policies enable row level security;
alter table public.ds_message_send_log enable row level security;
alter table public.ds_hc_planning_targets enable row level security;

revoke all on public.ds_ops_signal_rules, public.ds_message_types, public.ds_message_policies,
  public.ds_message_send_log, public.ds_hc_planning_targets
  from public, anon, authenticated;
grant all on public.ds_ops_signal_rules, public.ds_message_types, public.ds_message_policies,
  public.ds_message_send_log, public.ds_hc_planning_targets to service_role;

-- Seed message type catalogue (global codes).
insert into public.ds_message_types (code, label, description) values
  ('site_summary_acceptance', 'Site Summary acceptance SLA', 'Pending acceptance beyond configured seconds'),
  ('datoms_l2', 'Datoms L2 cold chain', 'Datoms temperature / door L2 alert'),
  ('datoms_l3', 'Datoms L3 cold chain', 'Datoms temperature / door L3 alert'),
  ('shift_noshow', 'Shift no-show', 'Rostered associate not punched in'),
  ('shift_no_roster', 'Missing roster', 'Store has no approved roster for the day'),
  ('shift_not_started', 'Shift ops not started', 'SI checklist not started for shift'),
  ('ops_incomplete', 'Store ops incomplete', 'Yesterday store-ops report incomplete'),
  ('report_bot_cold_chain', 'Report Bot cold chain', 'Report Bot cold_chain category'),
  ('report_bot_infrastructure', 'Report Bot infrastructure', 'Report Bot infrastructure category'),
  ('report_bot_workforce', 'Report Bot workforce', 'Report Bot workforce category')
on conflict (code) do nothing;

-- Seed DropX company defaults (behaviour-neutral with current env/constants).
insert into public.ds_message_policies (
  company_id, message_type, urgency, frequency, cooldown_minutes, threshold_seconds, enabled, version
) values
  ('43866344-b550-4e8a-9a2d-9d23f3d8a997', 'site_summary_acceptance', 'high', 'cooldown', 5, 15, true, 1),
  ('43866344-b550-4e8a-9a2d-9d23f3d8a997', 'datoms_l2', 'high', 'immediate', 0, null, true, 1),
  ('43866344-b550-4e8a-9a2d-9d23f3d8a997', 'datoms_l3', 'critical', 'immediate', 0, null, true, 1),
  ('43866344-b550-4e8a-9a2d-9d23f3d8a997', 'shift_noshow', 'high', 'cooldown', 15, null, true, 1),
  ('43866344-b550-4e8a-9a2d-9d23f3d8a997', 'shift_no_roster', 'normal', 'cooldown', 120, null, true, 1),
  ('43866344-b550-4e8a-9a2d-9d23f3d8a997', 'shift_not_started', 'high', 'cooldown', 60, null, true, 1),
  ('43866344-b550-4e8a-9a2d-9d23f3d8a997', 'ops_incomplete', 'normal', 'digest', 1440, null, true, 1),
  ('43866344-b550-4e8a-9a2d-9d23f3d8a997', 'report_bot_cold_chain', 'critical', 'immediate', 0, null, true, 1),
  ('43866344-b550-4e8a-9a2d-9d23f3d8a997', 'report_bot_infrastructure', 'high', 'immediate', 0, null, true, 1),
  ('43866344-b550-4e8a-9a2d-9d23f3d8a997', 'report_bot_workforce', 'high', 'immediate', 0, null, true, 1)
on conflict (company_id, message_type) do nothing;

insert into public.ds_ops_signal_rules (company_id, station_code, metric, baseline_days, threshold_pct, min_samples, enabled)
values
  ('43866344-b550-4e8a-9a2d-9d23f3d8a997', null, 'active_orders', 7, 40, 3, true),
  ('43866344-b550-4e8a-9a2d-9d23f3d8a997', null, 'orders_per_hour', 7, 40, 3, true),
  ('43866344-b550-4e8a-9a2d-9d23f3d8a997', null, 'pending_acceptance', 7, 50, 3, true)
on conflict (company_id, station_code, metric) do nothing;

insert into public.ds_hc_planning_targets (company_id, station_code, orders_per_associate_hour, target_ppt_seconds, enabled)
values ('43866344-b550-4e8a-9a2d-9d23f3d8a997', null, 12, 90, true)
on conflict (company_id, station_code) do nothing;
