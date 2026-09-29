-- Cloak (cloak.tech.amazon.dev) session + login lock for nl-loss-cloak-worker (NL loss).
-- Same shape as workforce_sessions / workforce_login_state. Already applied to production.
begin;

-- Cloak (cloak.tech.amazon.dev) session — same shape as workforce_sessions.
create table if not exists public.cloak_sessions (
  id uuid primary key default gen_random_uuid(),
  cookie text not null,
  uploaded_by text not null,
  status text not null default 'active' check (status in ('active', 'expired')),
  account_key text not null default 'default',
  created_at timestamptz not null default now(),
  expired_at timestamptz
);
create index if not exists cloak_sessions_account_status_idx
  on public.cloak_sessions (account_key, status, created_at desc);
alter table public.cloak_sessions enable row level security;

create table if not exists public.cloak_login_state (
  account_key text primary key default 'default',
  login_locked_until timestamptz,
  last_login_at timestamptz,
  last_login_error text,
  updated_at timestamptz not null default now()
);
alter table public.cloak_login_state enable row level security;

commit;
