begin;

create extension if not exists pgcrypto;

create table if not exists public.org_positions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  code text not null,
  name text not null,
  designation_id uuid references public.designations(id) on delete set null,
  role_id uuid not null references public.user_roles(id) on delete restrict,
  reports_to_position_id uuid references public.org_positions(id) on delete set null,
  location_access_mode text not null default 'selected',
  location_scope_ids uuid[] not null default '{}',
  is_active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint org_positions_location_access_mode_check
    check (location_access_mode in ('selected', 'all_locations')),
  constraint org_positions_not_self_reporting_check
    check (reports_to_position_id is null or reports_to_position_id <> id)
);

create unique index if not exists org_positions_company_code_key
  on public.org_positions (company_id, lower(code));
create index if not exists org_positions_company_active_idx
  on public.org_positions (company_id, is_active, role_id);
create index if not exists org_positions_designation_idx
  on public.org_positions (company_id, designation_id);
create index if not exists org_positions_reports_to_idx
  on public.org_positions (reports_to_position_id);
create index if not exists org_positions_location_scope_gin_idx
  on public.org_positions using gin (location_scope_ids);

create table if not exists public.position_assignments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  position_id uuid not null references public.org_positions(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  source_employee_id uuid references public.employees(id) on delete set null,
  assignment_type text not null default 'permanent',
  valid_from date not null default current_date,
  valid_until date,
  reason text,
  is_active boolean not null default true,
  previous_role_id uuid references public.user_roles(id) on delete set null,
  previous_reports_to_user_id uuid references public.profiles(id) on delete set null,
  previous_location_scope_ids uuid[] not null default '{}',
  previous_invite_method text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_by uuid references public.profiles(id) on delete set null,
  ended_at timestamptz,
  constraint position_assignments_type_check
    check (assignment_type in ('permanent', 'acting')),
  constraint position_assignments_date_check
    check (valid_until is null or valid_until >= valid_from)
);

alter table public.position_assignments
  add column if not exists previous_invite_method text;

create unique index if not exists position_assignments_one_current_permanent_position_key
  on public.position_assignments (company_id, position_id)
  where assignment_type = 'permanent' and is_active = true;
create unique index if not exists position_assignments_one_current_permanent_profile_key
  on public.position_assignments (company_id, profile_id)
  where assignment_type = 'permanent' and is_active = true;
create index if not exists position_assignments_profile_active_idx
  on public.position_assignments (company_id, profile_id, is_active, valid_from, valid_until);
create index if not exists position_assignments_position_active_idx
  on public.position_assignments (company_id, position_id, is_active, assignment_type);
create index if not exists position_assignments_source_employee_idx
  on public.position_assignments (source_employee_id);

create table if not exists public.position_access_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  event_type text not null,
  position_id uuid references public.org_positions(id) on delete set null,
  assignment_id uuid references public.position_assignments(id) on delete set null,
  profile_id uuid references public.profiles(id) on delete set null,
  details jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists position_access_events_company_created_idx
  on public.position_access_events (company_id, created_at desc);
create index if not exists position_access_events_position_idx
  on public.position_access_events (position_id, created_at desc);

alter table public.employees
  add column if not exists org_position_id uuid references public.org_positions(id) on delete set null;

create index if not exists employees_org_position_idx
  on public.employees (company_id, org_position_id);

alter table public.org_positions enable row level security;
alter table public.position_assignments enable row level security;
alter table public.position_access_events enable row level security;

revoke all on table public.org_positions from anon, authenticated;
revoke all on table public.position_assignments from anon, authenticated;
revoke all on table public.position_access_events from anon, authenticated;

grant select, insert, update, delete on table public.org_positions to service_role;
grant select, insert, update, delete on table public.position_assignments to service_role;
grant select, insert, update, delete on table public.position_access_events to service_role;

commit;
