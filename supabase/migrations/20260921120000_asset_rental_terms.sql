-- Rental is an asset lifecycle, not an annotation on an owned asset.  A single
-- asset may have successive rental terms, while its barcode and audit history
-- remain continuous.
alter table public.assets
  add column if not exists ownership_type text not null default 'owned';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'assets_ownership_type_check'
      and conrelid = 'public.assets'::regclass
  ) then
    alter table public.assets add constraint assets_ownership_type_check
      check (ownership_type in ('owned', 'rented', 'leased'));
  end if;
end $$;

create table if not exists public.asset_rental_terms (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  asset_id uuid not null references public.assets(id) on delete cascade,
  vendor_name text not null,
  agreement_number text,
  invoice_number text,
  rental_rate numeric(14,2) not null check (rental_rate >= 0),
  billing_frequency text not null default 'monthly'
    check (billing_frequency in ('daily', 'weekly', 'monthly', 'yearly')),
  security_deposit numeric(14,2) not null default 0 check (security_deposit >= 0),
  starts_on date not null,
  ends_on date,
  notice_period_days integer not null default 0 check (notice_period_days >= 0),
  off_hire_date date,
  status text not null default 'active'
    check (status in ('draft', 'active', 'notice_given', 'off_hired', 'expired')),
  notes text,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_on is null or ends_on >= starts_on),
  check (off_hire_date is null or off_hire_date >= starts_on)
);

create index if not exists asset_rental_terms_company_asset_idx
  on public.asset_rental_terms(company_id, asset_id, starts_on desc);
create unique index if not exists asset_rental_terms_one_open_term_idx
  on public.asset_rental_terms(company_id, asset_id)
  where status in ('draft', 'active', 'notice_given');

alter table public.asset_rental_terms enable row level security;

comment on table public.asset_rental_terms is
  'Effective-dated commercial terms for rented or leased assets. Asset code, barcode and audit history stay on public.assets.';
