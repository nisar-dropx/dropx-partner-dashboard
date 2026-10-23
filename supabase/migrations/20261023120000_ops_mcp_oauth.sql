-- OAuth 2.1 storage for Ops Claude remote MCP (hashed codes/tokens, expiry).
-- Safe to re-run: create if not exists only.

begin;

create table if not exists public.mcp_oauth_clients (
  client_id text primary key,
  client_name text,
  redirect_uris text[] not null default '{}',
  token_endpoint_auth_method text not null default 'none',
  grant_types text[] not null default array['authorization_code', 'refresh_token'],
  response_types text[] not null default array['code'],
  client_uri text,
  logo_uri text,
  contacts text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mcp_oauth_clients_auth_method_check
    check (token_endpoint_auth_method in ('none', 'client_secret_post', 'client_secret_basic'))
);

create table if not exists public.mcp_oauth_codes (
  code_hash text primary key,
  client_id text not null references public.mcp_oauth_clients (client_id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  company_id uuid,
  redirect_uri text not null,
  code_challenge text not null,
  code_challenge_method text not null default 'S256',
  scope text not null default 'ops_pulse.read',
  resource text,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint mcp_oauth_codes_challenge_method_check
    check (code_challenge_method = 'S256')
);

create index if not exists mcp_oauth_codes_expires_idx
  on public.mcp_oauth_codes (expires_at);

create table if not exists public.mcp_oauth_tokens (
  token_hash text primary key,
  token_type text not null default 'access',
  client_id text not null references public.mcp_oauth_clients (client_id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  company_id uuid,
  scope text not null default 'ops_pulse.read',
  resource text,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  refresh_of_hash text,
  created_at timestamptz not null default now(),
  constraint mcp_oauth_tokens_type_check
    check (token_type in ('access', 'refresh'))
);

create index if not exists mcp_oauth_tokens_user_idx
  on public.mcp_oauth_tokens (user_id);

create index if not exists mcp_oauth_tokens_expires_idx
  on public.mcp_oauth_tokens (expires_at);

alter table public.mcp_oauth_clients enable row level security;
alter table public.mcp_oauth_codes enable row level security;
alter table public.mcp_oauth_tokens enable row level security;

-- Service role only; no policies for authenticated/anon (deny by default with RLS on).

commit;
