create extension if not exists pgcrypto;

create table if not exists public.workforce_categories (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  code text not null,
  name text not null,
  profile_field_rules jsonb not null default '{}'::jsonb,
  app_page_access text[] not null default array['dashboard', 'attendance', 'settings']::text[],
  statutory_enabled boolean not null default false,
  direct_activate boolean not null default false,
  is_system boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workforce_categories_code_format_check
    check (code = lower(code) and code ~ '^[a-z0-9_]+$'),
  constraint workforce_categories_company_code_unique unique (company_id, code)
);

create index if not exists workforce_categories_company_active_idx
  on public.workforce_categories(company_id, is_active, sort_order, name);

with category_seed(code, name, sort_order) as (
  values
    ('employees', 'Employees', 10),
    ('workforce', 'Workforce', 20),
    ('contractors', 'Independent Contractor', 30),
    ('vendors', 'Vendors', 40),
    ('workers', 'Workers', 50)
)
insert into public.workforce_categories (
  company_id,
  code,
  name,
  profile_field_rules,
  is_system,
  is_active,
  sort_order
)
select
  company.id,
  category_seed.code,
  category_seed.name,
  coalesce((
    select designation.profile_field_rules -> category_seed.code
    from public.designations designation
    where designation.company_id = company.id
      and category_seed.code = any(coalesce(designation.onboarding_categories, '{}'::text[]))
      and jsonb_typeof(designation.profile_field_rules -> category_seed.code) = 'object'
    order by designation.updated_at desc nulls last, designation.created_at desc nulls last
    limit 1
  ), '{}'::jsonb),
  true,
  true,
  category_seed.sort_order
from public.companies company
cross join category_seed
on conflict (company_id, code) do update
set
  name = excluded.name,
  is_system = true,
  sort_order = excluded.sort_order,
  updated_at = now();

alter table public.workforce_categories enable row level security;

alter table public.workforce_categories
  add column if not exists app_page_access text[] not null
  default array['dashboard', 'attendance', 'settings']::text[];

alter table public.workforce_categories
  add column if not exists statutory_enabled boolean not null default false;

alter table public.workforce_categories
  add column if not exists direct_activate boolean not null default false;

drop policy if exists workforce_categories_select_policy on public.workforce_categories;

notify pgrst, 'reload schema';
