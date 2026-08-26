begin;

-- "Enter cash later" exception for one required associate on one station-day.
-- Lets Executive Reconciliation Step 1 -> Step 2 proceed when a specific associate (typically
-- an Amazon access-point / store partner that only brings cash the next day) hasn't handed
-- over cash yet, while keeping Step 2 -> Step 3 / final submission blocked until that
-- associate's cash is actually entered (which auto-clears the exception).
create table if not exists public.cod_cash_entry_exceptions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  location_id uuid references public.stations(id) on delete set null,
  station_code text not null,
  business_date date not null,
  provider_employee_id text not null,
  associate_name text not null,
  expected_amount numeric(14, 2) not null default 0,
  reason text not null,
  status text not null default 'Open',
  created_by uuid references auth.users(id) on delete set null,
  created_by_name text,
  cleared_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cod_cash_entry_exceptions_status_check check (status in ('Open', 'Cleared'))
);

alter table public.cod_cash_entry_exceptions
  add column if not exists company_id uuid,
  add column if not exists location_id uuid,
  add column if not exists station_code text,
  add column if not exists business_date date,
  add column if not exists provider_employee_id text,
  add column if not exists associate_name text,
  add column if not exists expected_amount numeric(14, 2) not null default 0,
  add column if not exists reason text,
  add column if not exists status text not null default 'Open',
  add column if not exists created_by uuid,
  add column if not exists created_by_name text,
  add column if not exists cleared_at timestamptz,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

-- Only one OPEN exception per associate per station-day — re-raising just refreshes it (see
-- addCashEntryException's find-then-update-or-insert, which relies on this being queryable
-- rather than a hard DB constraint, since a station can have many Cleared rows over time).
create index if not exists cod_cash_entry_exceptions_lookup_idx
  on public.cod_cash_entry_exceptions (company_id, business_date, location_id, status);

create index if not exists cod_cash_entry_exceptions_provider_idx
  on public.cod_cash_entry_exceptions (company_id, business_date, location_id, provider_employee_id, status);

do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'set_updated_at'
  ) then
    drop trigger if exists set_cod_cash_entry_exceptions_updated_at
      on public.cod_cash_entry_exceptions;

    create trigger set_cod_cash_entry_exceptions_updated_at
      before update on public.cod_cash_entry_exceptions
      for each row execute function public.set_updated_at();
  end if;
end $$;

alter table public.cod_cash_entry_exceptions enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'cod_cash_entry_exceptions'
      and policyname = 'cod_cash_entry_exceptions_service_role_all'
  ) then
    create policy cod_cash_entry_exceptions_service_role_all
      on public.cod_cash_entry_exceptions
      for all
      to service_role
      using (true)
      with check (true);
  end if;
end $$;

commit;
