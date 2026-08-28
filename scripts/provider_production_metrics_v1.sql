create table if not exists public.provider_production_metrics (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  provider_id uuid not null references public.providers(id) on delete cascade,
  code text not null,
  name text not null,
  source_key text not null,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, provider_id, code),
  unique (company_id, provider_id, source_key)
);

create table if not exists public.payment_field_provider_metrics (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  payment_field_id uuid not null references public.payment_fields(id) on delete cascade,
  provider_id uuid not null references public.providers(id) on delete cascade,
  provider_metric_id uuid not null references public.provider_production_metrics(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, payment_field_id, provider_id)
);

create index if not exists provider_production_metrics_lookup_idx
  on public.provider_production_metrics (company_id, provider_id, is_active, sort_order);
create index if not exists payment_field_provider_metrics_field_idx
  on public.payment_field_provider_metrics (company_id, payment_field_id);

alter table public.provider_production_metrics enable row level security;
alter table public.payment_field_provider_metrics enable row level security;

insert into public.provider_production_metrics (company_id, provider_id, code, name, source_key, sort_order)
select p.company_id, p.id, seed.code, seed.name, seed.source_key, seed.sort_order
from public.providers p
cross join (values
  ('AMAZON_DELIVERY', 'Amazon Delivery', 'amazon_delivery', 10),
  ('SWA_DELIVERY', 'SWA Delivery', 'swa_delivery', 20),
  ('TOTAL_DELIVERY', 'Total Delivery', 'total_delivery', 30),
  ('CUSTOMER_RETURN', 'Customer Return', 'customer_return', 40),
  ('SELLER_PICKUP', 'Seller Pickup', 'seller_pickup', 50),
  ('SELLER_RETURN', 'Seller Return', 'seller_return', 60)
) as seed(code, name, source_key, sort_order)
where lower(p.code) = 'amazon' or lower(p.name) = 'amazon'
on conflict (company_id, provider_id, code) do nothing;

comment on table public.provider_production_metrics is
  'Human-managed provider production counts. source_key connects a normalized imported count to payment calculation.';
comment on table public.payment_field_provider_metrics is
  'Provider-specific count selected for each reusable production payment field.';
