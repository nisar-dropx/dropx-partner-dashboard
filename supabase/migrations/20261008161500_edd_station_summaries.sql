-- EDDs tab: read stored per-station counts instead of the package ledger (outage 2026-10-08).
--
-- Every viewer of the EDDs tab (and each open tab, once a minute) made the web
-- server pull a station's whole seven-day package list out of the 1.7 GB
-- ledger to count it. The 15-minute background capture already reads the
-- ledger once per station; it now stores the counts here, and the tab reads
-- these rows, the same way Ageing and Performance read ready-made totals.
begin;
create table public.edd_station_summaries (
  station_code text primary key,
  edd_day text not null,
  summary jsonb not null,
  computed_at timestamptz not null default now()
);
alter table public.edd_station_summaries enable row level security;
revoke all on public.edd_station_summaries from anon, authenticated;
grant all on public.edd_station_summaries to service_role;
commit;
