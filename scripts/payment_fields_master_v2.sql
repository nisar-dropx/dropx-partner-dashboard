create extension if not exists pgcrypto;

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

create index if not exists payment_fields_company_active_idx
  on public.payment_fields (company_id, is_active, code);

alter table public.payment_fields enable row level security;
revoke all on table public.payment_fields from anon, authenticated;

alter table if exists public.payment_method_components
  add column if not exists payment_field_id uuid references public.payment_fields(id);

update public.payment_method_components component
set company_id = method.company_id
from public.payment_methods method
where method.id = component.payment_method_id
  and component.company_id is null;

insert into public.payment_fields (
  company_id,
  code,
  field_type,
  label,
  pay_schedule,
  is_active,
  created_at,
  updated_at
)
select distinct on (component.company_id, component.component_code)
  component.company_id,
  component.component_code,
  component.component_type,
  component.label,
  component.pay_schedule,
  component.is_active,
  component.created_at,
  component.updated_at
from public.payment_method_components component
where component.company_id is not null
order by component.company_id, component.component_code, component.created_at, component.id
on conflict (company_id, code) do nothing;

update public.payment_method_components component
set payment_field_id = field.id
from public.payment_fields field
where field.company_id = component.company_id
  and field.code = component.component_code
  and component.payment_field_id is null;

alter table if exists public.payment_method_components
  alter column payment_field_id set not null;

create unique index if not exists payment_method_components_field_unique
  on public.payment_method_components (payment_method_id, payment_field_id);

