begin;

-- Configurable review oversight roles: replaces the hardcoded FSD / Managing Partner /
-- National Head / Program Manager pattern matching in review-policy.ts / review-access.ts
-- with a company-editable list, managed from Master (Performance Master -> Review cadence).
--
-- Two tiers, matching the two tiers reviewCapabilities() already recognised before this
-- table existed:
--   'full'     - what Owner/Managing Partner/Program Manager got: edit RCA, actions, comments
--                and station timings at any stage, not just their own. Now also grants the
--                same controls on Control Tower (Review Status).
--   'override' - what National Head/Tech(FSD) got: can start/skip a level/take a proxy
--                review/undo a skip, but does not get free-standing edit rights outside
--                their own stage.
-- Any People designation (code or name) or portal role code/name whose text matches one of
-- these rows (case-insensitive substring, same matching review-policy.ts's reviewRole()
-- already used) is granted that tier.
create table if not exists public.ops_performance_review_oversight_roles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  -- Free-text label shown in Master, e.g. "Program Manager" or "FSD / Tech".
  label text not null,
  tier text not null check (tier in ('full', 'override')),
  -- Matched case-insensitively as a whole word against "<designation code> <designation
  -- name> <position title>" / "<role code> <role name>", the same way review-policy.ts's
  -- reviewRole() buckets are already matched. Stored as plain text, not a regex, so Master
  -- stays simple to edit.
  match_text text not null,
  is_active boolean not null default true,
  display_order integer not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, match_text)
);

create index if not exists ops_performance_review_oversight_roles_company_idx
  on public.ops_performance_review_oversight_roles(company_id) where is_active;

-- Seed every existing company with the same roles the hardcoded checks used to grant, split
-- into the same two tiers, so behaviour is unchanged until someone edits this list in Master.
insert into public.ops_performance_review_oversight_roles (company_id, label, tier, match_text, display_order)
select id, seed.label, seed.tier, seed.match_text, seed.display_order
from public.companies
cross join (values
  ('Program Manager', 'full', 'PROGRAM MANAGER', 1),
  ('Program Head', 'full', 'PROGRAM HEAD', 2),
  ('Managing Partner', 'full', 'MANAGING PARTNER', 3),
  ('National Head', 'override', 'NATIONAL HEAD', 4),
  ('Tech / FSD', 'override', 'FSD', 5)
) as seed(label, tier, match_text, display_order)
on conflict (company_id, match_text) do nothing;

alter table public.ops_performance_review_oversight_roles enable row level security;
revoke all on table public.ops_performance_review_oversight_roles from anon, authenticated;
grant select, insert, update, delete on table public.ops_performance_review_oversight_roles to service_role;

commit;
