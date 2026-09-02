begin;

insert into public.app_pages (company_id, code, name, sort_order, is_active, created_at, updated_at)
select companies.id, 'performance_review', 'Performance Reviews', 84, true, now(), now()
from public.companies
on conflict (company_id, code) do update set
  name = excluded.name,
  sort_order = excluded.sort_order,
  is_active = true,
  updated_at = now();

insert into public.role_page_permissions (
  company_id,
  role_id,
  page_id,
  can_view,
  can_add,
  can_edit,
  created_at,
  updated_at
)
select
  source_permission.company_id,
  source_permission.role_id,
  review_page.id,
  source_permission.can_view or source_permission.can_add or source_permission.can_edit,
  source_permission.can_add,
  source_permission.can_edit,
  now(),
  now()
from public.role_page_permissions source_permission
join public.app_pages source_page
  on source_page.id = source_permission.page_id
 and source_page.company_id = source_permission.company_id
 and source_page.code = 'performance'
join public.app_pages review_page
  on review_page.company_id = source_permission.company_id
 and review_page.code = 'performance_review'
on conflict (company_id, role_id, page_id) do nothing;

create table if not exists public.ops_performance_station_settings (
  company_id uuid not null references public.companies(id) on delete cascade,
  station_id uuid not null references public.stations(id) on delete cascade,
  opening_window_start time not null default '02:00',
  opening_window_end time not null default '10:00',
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (company_id, station_id),
  check (opening_window_start <> opening_window_end)
);

create index if not exists ops_performance_station_settings_station_idx
  on public.ops_performance_station_settings(station_id);

insert into public.ops_performance_station_settings (company_id, station_id)
select stations.company_id, stations.id
from public.stations
where stations.company_id is not null
on conflict (company_id, station_id) do nothing;

alter table public.ops_performance_station_settings enable row level security;
revoke all on table public.ops_performance_station_settings from anon, authenticated;
grant select, insert, update, delete on table public.ops_performance_station_settings to service_role;

commit;
