begin;

-- A dispatch route chooses its WhatsApp destination independently from its
-- live source scope. This supports station War Rooms, regional internal groups,
-- and XPT-to-base-station routing without group-name or station-code logic.
alter table public.report_bot_lm_dispatch_routes
  alter column location_id drop not null,
  add column if not exists scope_type text not null default 'station',
  add column if not exists source_location_ids uuid[] not null default '{}',
  add column if not exists source_region_codes text[] not null default '{}',
  add column if not exists formats text[] not null default '{}',
  add column if not exists schedule_start text,
  add column if not exists schedule_end text,
  add column if not exists interval_minutes integer,
  add column if not exists source_rule text not null default 'current_report';

update public.report_bot_lm_dispatch_routes
set source_location_ids = array[location_id]
where cardinality(source_location_ids) = 0 and location_id is not null;

update public.report_bot_lm_dispatch_routes
set formats = array[case when format = 'table' then 'text' else format end]
where cardinality(formats) = 0;

alter table public.report_bot_lm_dispatch_routes
  drop constraint if exists report_bot_lm_dispatch_routes_times_check,
  add constraint report_bot_lm_dispatch_routes_times_check check(cardinality(times) between 1 and 96),
  add constraint report_bot_lm_dispatch_routes_scope_type_check check(scope_type in ('station','region')),
  add constraint report_bot_lm_dispatch_routes_scope_check check(
    (scope_type = 'station' and cardinality(source_location_ids) between 1 and 100 and cardinality(source_region_codes) = 0)
    or
    (scope_type = 'region' and cardinality(source_region_codes) between 1 and 25 and cardinality(source_location_ids) = 0)
  ),
  add constraint report_bot_lm_dispatch_routes_formats_check check(
    cardinality(formats) between 1 and 3 and formats <@ array['text','photo','excel']::text[]
  ),
  add constraint report_bot_lm_dispatch_routes_schedule_check check(
    (schedule_start is null and schedule_end is null and interval_minutes is null)
    or
    (schedule_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      and schedule_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      and interval_minutes between 5 and 720)
  ),
  add constraint report_bot_lm_dispatch_routes_source_rule_check check(
    source_rule in ('current_report','today_edd_at_station_never_attempted')
  );

create table if not exists public.report_bot_lm_dispatch_run_outputs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.report_bot_lm_dispatch_runs(id) on delete cascade,
  output_key text not null,
  status text not null default 'processing',
  receipt_id text,
  detail text,
  updated_at timestamptz not null default now(),
  unique(run_id, output_key)
);

alter table public.report_bot_lm_dispatch_run_outputs enable row level security;
revoke all on public.report_bot_lm_dispatch_run_outputs from public, anon, authenticated;
grant select,insert,update,delete on public.report_bot_lm_dispatch_run_outputs to service_role;

notify pgrst,'reload schema';
commit;
