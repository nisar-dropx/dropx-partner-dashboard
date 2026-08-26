create table if not exists public.payment_advance_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  profile_type text not null check (profile_type in ('employee', 'field_executive', 'contractor', 'vendor', 'worker')),
  account_id uuid not null,
  account_code text,
  requester_name text,
  station_code text,
  designation text,
  amount numeric(12,2) not null check (amount > 0 and amount <= 1000000),
  purpose text not null check (char_length(btrim(purpose)) between 3 and 500),
  status text not null default 'submitted' check (status in ('submitted', 'in_review', 'approved', 'rejected', 'cancelled', 'closed')),
  approved_amount numeric(12,2) check (approved_amount is null or approved_amount >= 0),
  decision_comment text,
  requested_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists payment_advance_requests_account_idx
  on public.payment_advance_requests (company_id, profile_type, account_id, requested_at desc);

alter table public.payment_advance_requests enable row level security;
revoke all on table public.payment_advance_requests from anon, authenticated;
