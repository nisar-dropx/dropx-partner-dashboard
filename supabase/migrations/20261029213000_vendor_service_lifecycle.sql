-- Configurable vendor services, contracts, billing cycles and payment hand-off.
-- Safe to apply repeatedly.

alter table public.vendors add column if not exists deleted_at timestamptz;
alter table public.fleet_vehicles add column if not exists vendor_id uuid references public.vendors(id) on delete set null;

create table if not exists public.vendor_service_categories (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  code text not null,
  name text not null,
  operating_model text not null default 'fixed_contract'
    check (operating_model in ('fleet_attendance', 'biometric_attendance', 'fixed_contract')),
  allowed_payout_months integer[] not null default array[1,3,6,12]::integer[],
  requires_invoice boolean not null default true,
  requires_verified_bank boolean not null default true,
  payment_head_id uuid references public.payment_heads(id) on delete set null,
  absence_policy text not null default 'not_applicable'
    check (absence_policy in ('missing_mark_absent', 'not_applicable')),
  config jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  sort_order integer not null default 100,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, code),
  check (cardinality(allowed_payout_months) > 0),
  check (allowed_payout_months <@ array[1,3,6,12]::integer[])
);

create table if not exists public.vendor_service_contracts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  vendor_id uuid not null references public.vendors(id) on delete restrict,
  category_id uuid not null references public.vendor_service_categories(id) on delete restrict,
  location_id uuid not null references public.stations(id) on delete restrict,
  fleet_vehicle_id uuid references public.fleet_vehicles(id) on delete set null,
  contract_no text not null,
  start_date date not null,
  end_date date,
  payout_frequency_months integer not null default 1 check (payout_frequency_months in (1,3,6,12)),
  rate_type text not null default 'fixed_cycle' check (rate_type in ('fixed_cycle','daily_attendance')),
  rate_amount numeric(14,2) not null check (rate_amount >= 0),
  attendance_source text not null default 'none' check (attendance_source in ('none','biometric','fleet')),
  payment_contact_id uuid not null references public.payment_contacts(id) on delete restrict,
  payment_head_id uuid not null references public.payment_heads(id) on delete restrict,
  invoice_required boolean not null default true,
  status text not null default 'draft' check (status in ('draft','active','suspended','expired','terminated')),
  next_period_start date not null,
  terms jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, contract_no),
  check (end_date is null or end_date >= start_date),
  check (attendance_source <> 'fleet' or fleet_vehicle_id is not null),
  check (rate_type <> 'daily_attendance' or attendance_source <> 'none')
);

create table if not exists public.vendor_billing_cycles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  contract_id uuid not null references public.vendor_service_contracts(id) on delete restrict,
  period_start date not null,
  period_end date not null,
  due_date date not null,
  expected_units numeric(10,2) not null default 0,
  present_units numeric(10,2) not null default 0,
  absent_units numeric(10,2) not null default 0,
  gross_amount numeric(14,2) not null default 0,
  deduction_amount numeric(14,2) not null default 0,
  payable_amount numeric(14,2) not null default 0,
  invoice_number text,
  invoice_storage_path text,
  attendance_snapshot jsonb not null default '{}'::jsonb,
  status text not null default 'ready'
    check (status in ('ready','submitted','approval_pending','approved','processing','paid','returned','rejected','cancelled')),
  payment_request_id uuid references public.payment_requests(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (contract_id, period_start, period_end),
  check (period_end >= period_start),
  check (expected_units >= 0 and present_units >= 0 and absent_units >= 0),
  check (gross_amount >= 0 and deduction_amount >= 0 and payable_amount >= 0),
  check (present_units + absent_units <= expected_units + 0.01)
);

create table if not exists public.vendor_lifecycle_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  vendor_id uuid references public.vendors(id) on delete cascade,
  contract_id uuid references public.vendor_service_contracts(id) on delete cascade,
  billing_cycle_id uuid references public.vendor_billing_cycles(id) on delete cascade,
  event_type text not null,
  from_status text,
  to_status text,
  actor_user_id uuid references public.profiles(id) on delete set null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (vendor_id is not null or contract_id is not null or billing_cycle_id is not null)
);

create index if not exists vendor_service_categories_company_status_idx
  on public.vendor_service_categories(company_id, is_active, sort_order);
create index if not exists vendor_service_contracts_company_category_idx
  on public.vendor_service_contracts(company_id, category_id, status);
create index if not exists vendor_service_contracts_vendor_idx
  on public.vendor_service_contracts(vendor_id, status);
create index if not exists vendor_service_contracts_location_idx
  on public.vendor_service_contracts(location_id, status);
create index if not exists vendor_billing_cycles_company_status_idx
  on public.vendor_billing_cycles(company_id, status, due_date);
create index if not exists vendor_billing_cycles_payment_request_idx
  on public.vendor_billing_cycles(payment_request_id) where payment_request_id is not null;
create index if not exists vendor_lifecycle_events_contract_idx
  on public.vendor_lifecycle_events(contract_id, created_at desc);
create index if not exists fleet_vehicles_vendor_idx
  on public.fleet_vehicles(company_id, vendor_id) where vendor_id is not null;

create or replace function public.vendor_lifecycle_touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists vendor_service_categories_touch on public.vendor_service_categories;
create trigger vendor_service_categories_touch before update on public.vendor_service_categories
for each row execute function public.vendor_lifecycle_touch_updated_at();
drop trigger if exists vendor_service_contracts_touch on public.vendor_service_contracts;
create trigger vendor_service_contracts_touch before update on public.vendor_service_contracts
for each row execute function public.vendor_lifecycle_touch_updated_at();
drop trigger if exists vendor_billing_cycles_touch on public.vendor_billing_cycles;
create trigger vendor_billing_cycles_touch before update on public.vendor_billing_cycles
for each row execute function public.vendor_lifecycle_touch_updated_at();

insert into public.vendor_service_categories
  (company_id, code, name, operating_model, allowed_payout_months, requires_invoice, requires_verified_bank, absence_policy, sort_order)
select c.id, seed.code, seed.name, seed.operating_model, seed.allowed_payout_months,
       true, true, seed.absence_policy, seed.sort_order
from public.companies c
cross join (values
  ('VAN_VENDOR','Van vendor','fleet_attendance',array[1]::integer[],'missing_mark_absent',10),
  ('SECURITY_GUARD','Security guard','fixed_contract',array[1,3,6,12]::integer[],'not_applicable',20),
  ('HOUSEKEEPING','Housekeeping','fixed_contract',array[1,3,6,12]::integer[],'not_applicable',30),
  ('PEST_CONTROL','Pest control','fixed_contract',array[1,3,6,12]::integer[],'not_applicable',40)
) as seed(code,name,operating_model,allowed_payout_months,absence_policy,sort_order)
on conflict (company_id, code) do nothing;

alter table public.vendor_service_categories enable row level security;
alter table public.vendor_service_contracts enable row level security;
alter table public.vendor_billing_cycles enable row level security;
alter table public.vendor_lifecycle_events enable row level security;

do $$
declare
  target_table text;
  policy_name text;
begin
  foreach target_table in array array[
    'vendor_service_categories',
    'vendor_service_contracts',
    'vendor_billing_cycles',
    'vendor_lifecycle_events'
  ]
  loop
    policy_name := target_table || '_service_role_only';
    if not exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = target_table
        and policyname = policy_name
    ) then
      execute format(
        'create policy %I on public.%I for all to service_role using (true) with check (true)',
        policy_name,
        target_table
      );
    end if;
  end loop;
end;
$$;

revoke all on public.vendor_service_categories from anon, authenticated;
revoke all on public.vendor_service_contracts from anon, authenticated;
revoke all on public.vendor_billing_cycles from anon, authenticated;
revoke all on public.vendor_lifecycle_events from anon, authenticated;
grant select, insert, update, delete on public.vendor_service_categories to service_role;
grant select, insert, update, delete on public.vendor_service_contracts to service_role;
grant select, insert, update, delete on public.vendor_billing_cycles to service_role;
grant select, insert on public.vendor_lifecycle_events to service_role;

comment on table public.vendor_service_categories is 'Master-defined vendor service and payment behavior.';
comment on table public.vendor_service_contracts is 'Vendor/location contracts linked to verified payment contacts and payment heads.';
comment on table public.vendor_billing_cycles is 'Attendance/invoice-backed vendor pay cycles handed to payment_requests.';
