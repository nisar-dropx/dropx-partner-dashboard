-- Durable Datoms auth session (token + DPoP keypair). Survives KV TTL / isolate restarts
-- so the poller can reuse a live session without re-login until Datoms invalidates it.

create table if not exists public.ds_datoms_session (
  company_id            uuid primary key,
  email                 text not null,
  auth_token            text not null,
  private_key_jwk       jsonb not null,
  public_jwk            jsonb,
  login_backoff_until   timestamptz,
  login_backoff_reason  text,
  saved_at              timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

alter table public.ds_datoms_session enable row level security;

revoke all on public.ds_datoms_session from public, anon, authenticated;
grant all on public.ds_datoms_session to service_role;
