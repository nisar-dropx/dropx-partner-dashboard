-- Site Summary snapshot history for OpsPulse time-travel (keep live tables for latest).

create table if not exists public.ds_site_summary_snapshot_history (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null,
  station_code            text not null,
  fetched_at              timestamptz not null,
  active_orders           int not null default 0,
  pending_acceptance      int not null default 0,
  breaching_count         int not null default 0,
  worst_elapsed_seconds   numeric(12,2),
  sla_seconds             int not null default 15,
  waiting_for_orders      int not null default 0,
  on_break                int not null default 0,
  offered_associates      int not null default 0,
  picking_associates      int not null default 0,
  packing_racking         int not null default 0,
  other_activities        int not null default 0,
  total_associates        int not null default 0,
  payload_json            jsonb not null default '{}'::jsonb
);

create table if not exists public.ds_site_summary_order_history (
  id                      uuid primary key default gen_random_uuid(),
  snapshot_id             uuid not null references public.ds_site_summary_snapshot_history(id) on delete cascade,
  company_id              uuid not null,
  station_code            text not null,
  oid                     text not null,
  picker                  text,
  items                   int not null default 0,
  elapsed_seconds         numeric(12,2) not null default 0,
  pct_complete            numeric(6,2),
  status                  text,
  acceptance_seconds      numeric(12,2),
  picking_seconds         numeric(12,2),
  pack_rack_seconds       numeric(12,2),
  total_seconds           numeric(12,2),
  acceptance_target_seconds int,
  picking_target_seconds  int,
  pack_rack_target_seconds int,
  total_target_seconds    int,
  fetched_at              timestamptz not null
);

create index if not exists ds_site_summary_snapshot_history_lookup
  on public.ds_site_summary_snapshot_history (company_id, station_code, fetched_at desc);

create index if not exists ds_site_summary_order_history_snapshot
  on public.ds_site_summary_order_history (snapshot_id);

create index if not exists ds_site_summary_order_history_lookup
  on public.ds_site_summary_order_history (company_id, station_code, fetched_at desc);

alter table public.ds_site_summary_snapshot_history enable row level security;
alter table public.ds_site_summary_order_history enable row level security;

revoke all on public.ds_site_summary_snapshot_history, public.ds_site_summary_order_history
  from public, anon, authenticated;
grant all on public.ds_site_summary_snapshot_history, public.ds_site_summary_order_history to service_role;

create or replace function public.ds_site_summary_history_cleanup(p_keep_days int default 31)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.ds_site_summary_snapshot_history
  where fetched_at < now() - make_interval(days => greatest(coalesce(p_keep_days, 31), 7));
end;
$$;

revoke all on function public.ds_site_summary_history_cleanup(int) from public, anon, authenticated;
grant execute on function public.ds_site_summary_history_cleanup(int) to service_role;
