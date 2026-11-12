create table public.people_pan_aadhaar_override_events (
  id bigint generated always as identity primary key,
  company_id uuid not null,
  category_code text not null check (category_code in ('employees', 'workforce', 'contractors', 'vendors', 'workers')),
  profile_id uuid not null,
  pair_hash text not null check (pair_hash ~ '^[0-9a-f]{64}$'),
  linked boolean not null,
  reason text not null check (char_length(btrim(reason)) between 10 and 500),
  recorded_by uuid not null,
  recorded_at timestamptz not null default now()
);

create index people_pan_aadhaar_override_lookup
  on public.people_pan_aadhaar_override_events (company_id, profile_id, category_code, id desc);

alter table public.people_pan_aadhaar_override_events enable row level security;
revoke all on public.people_pan_aadhaar_override_events from public, anon, authenticated, service_role;
grant select, insert on public.people_pan_aadhaar_override_events to service_role;
grant usage on sequence public.people_pan_aadhaar_override_events_id_seq to service_role;

create view public.people_pan_aadhaar_overrides
with (security_invoker = true) as
select distinct on (company_id, profile_id, category_code)
  company_id, profile_id, category_code, pair_hash, linked
from public.people_pan_aadhaar_override_events
order by company_id, profile_id, category_code, id desc;

revoke all on public.people_pan_aadhaar_overrides from public, anon, authenticated, service_role;
grant select on public.people_pan_aadhaar_overrides to service_role;
