-- NL / SLP loss reports for Ops Pulse → Team Ops → Losses.
-- Written by nl-loss-cloak-worker (COMPANY_SUPABASE_URL = this dashboard DB), read by
-- src/lib/ops-pulse/loss-reports.ts. Worker session tables live in the worker DB
-- (nl_loss-cloak-worker/sql/worker-db.sql), not here.
begin;

-- One row per worker pull. The dashboard shows the latest 'completed' run per report.
create table if not exists public.loss_report_runs (
  id uuid primary key default gen_random_uuid(),
  report text not null check (report in ('nl', 'slp_initial', 'slp_final')),
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  source_file text,
  source_week text,
  source_created_at text,
  period_label text,
  source_total_count integer,
  headers jsonb not null default '[]'::jsonb,
  station_column text,
  amount_column text,
  reference_column text,
  total_rows integer not null default 0,
  total_amount numeric(14,2) not null default 0,
  error text,
  triggered_by text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists loss_report_runs_report_idx
  on public.loss_report_runs (report, status, started_at desc);
alter table public.loss_report_runs enable row level security;

create table if not exists public.loss_report_rows (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.loss_report_runs(id) on delete cascade,
  report text not null,
  station_code text,
  amount numeric(14,2),
  reference text,
  raw jsonb not null default '{}'::jsonb
);
create index if not exists loss_report_rows_run_station_idx
  on public.loss_report_rows (run_id, station_code);
alter table public.loss_report_rows enable row level security;

create table if not exists public.loss_report_station_totals (
  run_id uuid not null references public.loss_report_runs(id) on delete cascade,
  report text not null,
  station_code text not null,
  row_count integer not null default 0,
  total_amount numeric(14,2) not null default 0,
  primary key (run_id, station_code)
);
alter table public.loss_report_station_totals enable row level security;

-- Service role only (worker + dashboard server). No client policies on purpose.
commit;
