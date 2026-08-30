-- Idempotent production repair for deployments that received the profile-photo UI
-- before the identity-verification schema was visible to PostgREST.
create table if not exists public.connect_identity_verification_policies (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  profile_photo_match_percent integer not null default 60 check (profile_photo_match_percent between 50 and 100),
  require_profile_photo_liveness boolean not null default true,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(company_id)
);

insert into public.connect_identity_verification_policies(company_id, profile_photo_match_percent, require_profile_photo_liveness)
select id, 60, true from public.companies
on conflict (company_id) do nothing;

create table if not exists public.connect_profile_photo_challenges (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  account_id uuid not null,
  profile_type text not null,
  required_match_percent integer not null check (required_match_percent between 50 and 100),
  require_liveness boolean not null default true,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists connect_profile_photo_challenges_lookup_idx
  on public.connect_profile_photo_challenges(company_id, account_id, profile_type, consumed_at, expires_at);

create table if not exists public.connect_profile_photo_verifications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  account_id uuid not null,
  profile_type text not null,
  challenge_id uuid not null references public.connect_profile_photo_challenges(id),
  previous_photo_path text,
  verified_photo_path text not null,
  live_selfie_path text not null,
  match_percent numeric(5,2) not null,
  match_score numeric(8,6) not null,
  liveness_passed boolean not null,
  verified_at timestamptz not null default now()
);

create index if not exists connect_profile_photo_verifications_account_idx
  on public.connect_profile_photo_verifications(company_id, account_id, profile_type, verified_at desc);

alter table public.connect_identity_verification_policies enable row level security;
alter table public.connect_profile_photo_challenges enable row level security;
alter table public.connect_profile_photo_verifications enable row level security;

revoke all on public.connect_identity_verification_policies from public, anon, authenticated;
revoke all on public.connect_profile_photo_challenges from public, anon, authenticated;
revoke all on public.connect_profile_photo_verifications from public, anon, authenticated;
grant all on public.connect_identity_verification_policies to service_role;
grant all on public.connect_profile_photo_challenges to service_role;
grant all on public.connect_profile_photo_verifications to service_role;

notify pgrst, 'reload schema';
