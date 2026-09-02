begin;

insert into public.report_import_master (
  company_id,
  source_code,
  name,
  description,
  file_types,
  day_offset,
  upload_time,
  frequency,
  weekday,
  parser_type,
  dedupe_fields,
  is_active,
  requires_station,
  station_scope,
  requires_report_date,
  report_date_label,
  date_default_offset
)
select
  companies.id,
  'amazon_hawkeye_daily',
  'Amazon Hawkeye Daily',
  'Interim Amazon station-level D-1 Hawkeye workbook. Feeds the OpsPulse daily performance review while the Daily EDSP source is being corrected.',
  array['xlsx', 'xls']::text[],
  -1,
  '11:00'::time,
  'daily',
  null::smallint,
  'hawkeye_daily_metrics',
  array['report date', 'station code']::text[],
  true,
  false,
  'none',
  false,
  null,
  -1
from public.companies
on conflict (company_id, source_code) do update set
  name = excluded.name,
  description = excluded.description,
  file_types = excluded.file_types,
  day_offset = excluded.day_offset,
  upload_time = excluded.upload_time,
  frequency = excluded.frequency,
  weekday = excluded.weekday,
  parser_type = excluded.parser_type,
  dedupe_fields = excluded.dedupe_fields,
  is_active = excluded.is_active,
  requires_station = excluded.requires_station,
  station_scope = excluded.station_scope,
  requires_report_date = excluded.requires_report_date,
  report_date_label = excluded.report_date_label,
  date_default_offset = excluded.date_default_offset,
  updated_at = now();

create table if not exists public.ops_performance_review_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  daily_review_time time not null default '10:00',
  weekly_review_weekday smallint not null default 4 check (weekly_review_weekday between 0 and 6),
  weekly_review_time time not null default '16:00',
  stale_after_hours integer not null default 24 check (stale_after_hours between 1 and 168),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.ops_performance_review_settings (company_id)
select id from public.companies
on conflict (company_id) do nothing;

create table if not exists public.ops_performance_reviews (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  review_type text not null default 'daily_operations'
    check (review_type in ('daily_operations', 'weekly_sales')),
  source_date date not null,
  report_year integer,
  report_week integer,
  station_id uuid not null references public.stations(id) on delete cascade,
  station_code text not null,
  source_type text not null,
  source_batch_id uuid references public.report_import_batches(id) on delete set null,
  status text not null default 'open'
    check (status in ('open', 'in_review', 'closed')),
  current_step_order integer not null default 1 check (current_step_order > 0),
  vehicle_arrival_time time,
  unloading_complete_time time,
  station_clear_time time,
  review_summary text,
  started_by uuid references public.profiles(id) on delete set null,
  started_at timestamptz not null default now(),
  closed_by uuid references public.profiles(id) on delete set null,
  closed_at timestamptz,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (company_id, review_type, source_date, station_id)
);

create index if not exists ops_performance_reviews_queue_idx
  on public.ops_performance_reviews(company_id, review_type, source_date desc, status, station_code);

create table if not exists public.ops_performance_review_steps (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  review_id uuid not null references public.ops_performance_reviews(id) on delete cascade,
  step_order integer not null check (step_order > 0),
  reviewer_user_id uuid references public.profiles(id) on delete set null,
  reviewer_name text not null,
  reviewer_role text not null,
  status text not null default 'pending'
    check (status in ('pending', 'completed', 'skipped')),
  feedback text,
  completed_by uuid references public.profiles(id) on delete set null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (review_id, step_order)
);

create index if not exists ops_performance_review_steps_assignee_idx
  on public.ops_performance_review_steps(company_id, reviewer_user_id, status, created_at desc);

create table if not exists public.ops_performance_review_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  review_id uuid not null references public.ops_performance_reviews(id) on delete cascade,
  metric_key text not null,
  metric_label text not null,
  actual_value numeric,
  target_value numeric,
  target_direction text check (target_direction is null or target_direction in ('higher', 'lower')),
  severity text not null default 'red' check (severity in ('amber', 'red')),
  root_cause text,
  corrective_action text,
  action_owner text,
  action_owner_user_id uuid references public.profiles(id) on delete set null,
  due_date date,
  status text not null default 'open'
    check (status in ('open', 'in_progress', 'blocked', 'done')),
  carried_from_item_id uuid references public.ops_performance_review_items(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  closed_by uuid references public.profiles(id) on delete set null,
  closed_at timestamptz,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (review_id, metric_key)
);

create index if not exists ops_performance_review_items_action_idx
  on public.ops_performance_review_items(company_id, status, due_date, created_at desc);

create table if not exists public.ops_performance_review_updates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  review_id uuid not null references public.ops_performance_reviews(id) on delete cascade,
  review_item_id uuid references public.ops_performance_review_items(id) on delete cascade,
  update_type text not null check (update_type in ('review', 'action', 'status', 'closure', 'escalation')),
  note text not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists ops_performance_review_updates_timeline_idx
  on public.ops_performance_review_updates(review_id, created_at desc);

alter table public.ops_performance_review_settings enable row level security;
alter table public.ops_performance_reviews enable row level security;
alter table public.ops_performance_review_steps enable row level security;
alter table public.ops_performance_review_items enable row level security;
alter table public.ops_performance_review_updates enable row level security;

revoke all on table public.ops_performance_review_settings from anon, authenticated;
revoke all on table public.ops_performance_reviews from anon, authenticated;
revoke all on table public.ops_performance_review_steps from anon, authenticated;
revoke all on table public.ops_performance_review_items from anon, authenticated;
revoke all on table public.ops_performance_review_updates from anon, authenticated;

grant select, insert, update, delete on table public.ops_performance_review_settings to service_role;
grant select, insert, update, delete on table public.ops_performance_reviews to service_role;
grant select, insert, update, delete on table public.ops_performance_review_steps to service_role;
grant select, insert, update, delete on table public.ops_performance_review_items to service_role;
grant select, insert, update, delete on table public.ops_performance_review_updates to service_role;

commit;
