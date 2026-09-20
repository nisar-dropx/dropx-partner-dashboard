-- Configurable, ordered approval chain per payment head, replacing the flat
-- initial_approval_role_ids / final_approval_role_ids arrays with named steps.
-- Each step tries an ordered list of {role_id, scope} candidates: scope narrows
-- a role to the requester's own station, their cluster, or the whole company,
-- so the same role id can mean "station manager" at step 1 and "cluster
-- manager" at step 2 without two separate role rows.
begin;

create table if not exists public.payment_head_approval_steps (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  payment_head_id uuid not null references public.payment_heads(id) on delete cascade,
  step_order int not null,
  candidates jsonb not null default '[]'::jsonb,
  is_required boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_head_approval_steps_order_positive check (step_order > 0),
  constraint payment_head_approval_steps_candidates_array check (jsonb_typeof(candidates) = 'array'),
  unique (payment_head_id, step_order)
);

comment on column public.payment_head_approval_steps.candidates is
  'Ordered array of {"role_id": uuid, "scope": "station"|"cluster"|"company"}. '
  'resolveStepApprover tries each candidate in order; within a candidate, every '
  'active person holding that role within that scope is considered, filtered by '
  'availability, before moving to the next candidate. "station"/"cluster" narrow '
  'to the requester''s own station or cluster; "company" (the default for most '
  'roles today) considers anyone holding the role regardless of location scope, '
  'same as the flat role arrays this table replaces.';

create index if not exists payment_head_approval_steps_head_idx
  on public.payment_head_approval_steps(payment_head_id, step_order);

create index if not exists payment_head_approval_steps_company_idx
  on public.payment_head_approval_steps(company_id);

alter table public.payment_head_approval_steps enable row level security;
revoke all on table public.payment_head_approval_steps from anon, authenticated;

-- Requests track which step they are on against this new table instead of
-- the old two-phase current_step_order (1 = initial, 2 = final). Any value
-- now just indexes into payment_head_approval_steps.step_order for that
-- request's payment head. total_steps is cached at creation so the UI can
-- show "Step 2 of 3" without re-deriving it from history.
alter table public.payment_requests
  add column if not exists total_steps int;

commit;
