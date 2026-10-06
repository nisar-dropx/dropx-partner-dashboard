create table if not exists public.dashboard_app_event_logs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  platform text not null check (platform in ('dashboard', 'dropx_one_android', 'dropx_one_web')),
  event_code text not null,
  module text not null default 'general',
  action text not null default 'view',
  outcome text not null default 'info' check (outcome in ('info', 'success', 'failed', 'warning')),
  actor_type text not null default 'dashboard_user',
  actor_user_id uuid,
  actor_account_id uuid,
  actor_label text,
  actor_identifier text,
  subject_type text,
  subject_id uuid,
  subject_code text,
  subject_label text,
  route text,
  method text,
  metadata jsonb not null default '{}'::jsonb,
  user_agent text,
  ip_address text,
  created_at timestamptz not null default now()
);

create index if not exists dashboard_app_event_logs_company_created_idx
  on public.dashboard_app_event_logs (company_id, created_at desc);
create index if not exists dashboard_app_event_logs_company_platform_idx
  on public.dashboard_app_event_logs (company_id, platform, created_at desc);
create index if not exists dashboard_app_event_logs_company_event_idx
  on public.dashboard_app_event_logs (company_id, event_code, created_at desc);
create index if not exists dashboard_app_event_logs_company_actor_idx
  on public.dashboard_app_event_logs (company_id, actor_user_id, actor_account_id, created_at desc);

alter table public.dashboard_app_event_logs enable row level security;
revoke all on table public.dashboard_app_event_logs from public, anon, authenticated;
grant select, insert on table public.dashboard_app_event_logs to service_role;
create index if not exists dashboard_app_event_logs_fleet_subject_idx
  on public.dashboard_app_event_logs (company_id, subject_id, created_at desc)
  where module = 'fleet';
comment on table public.dashboard_app_event_logs is 'Server-only application events. Application authorization scopes reads and writes. Historical events before table installation may be unavailable.';
notify pgrst, 'reload schema';
