create table if not exists public.workforce_deduction_heads (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  code text not null,
  name text not null,
  description text,
  calculation_type text not null default 'fixed' check (calculation_type in ('fixed', 'percentage', 'manual')),
  default_value numeric(14,2) not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, code)
);

create index if not exists workforce_deduction_heads_company_idx
  on public.workforce_deduction_heads(company_id, is_active, name);

alter table public.workforce_deduction_heads enable row level security;

insert into public.app_pages (company_id, code, name, sort_order, is_active, created_at, updated_at)
select companies.id, 'workforce_payouts', 'Workforce Payouts', 110, true, now(), now()
from public.companies
where not exists (
  select 1 from public.app_pages pages
  where pages.company_id = companies.id and pages.code = 'workforce_payouts'
);
