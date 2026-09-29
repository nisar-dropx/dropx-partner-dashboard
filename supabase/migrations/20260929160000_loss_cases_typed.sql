-- Typed, deduplicated loss cases (replaces per-run loss_report_rows JSON copies).
-- One row per case per report, updated in place by nl-loss-cloak-worker; unchanged
-- pulls write nothing (content_hash). Dashboard reads by (report, station_code).
begin;

create table if not exists public.loss_cases (
  report text not null check (report in ('nl', 'slp_initial', 'slp_final')),
  case_key text not null,
  run_id uuid,
  tid text,
  tid_approximate boolean not null default false,
  station_code text,
  amount numeric(14,2),
  case_status text,
  category text,
  sub_category text,
  impact_date date,
  closed_date date,
  da_name text,
  remarks text,
  period text,
  extra jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (report, case_key)
);
create index if not exists loss_cases_report_station_idx on public.loss_cases (report, station_code);
create index if not exists loss_cases_report_run_idx on public.loss_cases (report, run_id);
alter table public.loss_cases enable row level security;

alter table public.loss_report_runs add column if not exists content_hash text;
alter table public.loss_report_runs add column if not exists checked_at timestamptz;

commit;
