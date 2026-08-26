create extension if not exists pgcrypto;

create table if not exists public.payment_methods (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payment_fields (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  code text not null,
  field_type text not null check (field_type in ('amount', 'production')),
  label text not null,
  pay_schedule text check (pay_schedule is null or pay_schedule in ('per_hour', 'per_day', 'per_month')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists payment_fields_company_code_unique
  on public.payment_fields (company_id, code);

alter table public.payment_fields enable row level security;
revoke all on table public.payment_fields from anon, authenticated;

create table if not exists public.payment_method_components (
  id uuid primary key default gen_random_uuid(),
  payment_method_id uuid not null references public.payment_methods(id) on delete cascade,
  payment_field_id uuid references public.payment_fields(id),
  component_code text not null,
  component_type text not null check (component_type in ('amount', 'production')),
  label text not null,
  pay_schedule text check (pay_schedule in ('per_hour', 'per_day', 'per_month')),
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists public.payment_method_components
  add column if not exists component_code text;

alter table if exists public.payment_method_components
  add column if not exists pay_schedule text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'payment_method_components_pay_schedule_check'
  ) then
    alter table public.payment_method_components
      add constraint payment_method_components_pay_schedule_check
      check (pay_schedule is null or pay_schedule in ('per_hour', 'per_day', 'per_month'));
  end if;
end $$;

update public.payment_method_components
set component_code = upper(regexp_replace(label, '[^A-Za-z0-9]+', '_', 'g'))
where component_code is null or trim(component_code) = '';

alter table if exists public.payment_method_components
  alter column component_code set not null;

create unique index if not exists payment_method_components_code_unique
  on public.payment_method_components (payment_method_id, component_code);

create index if not exists payment_method_components_method_idx
  on public.payment_method_components (payment_method_id, sort_order);
