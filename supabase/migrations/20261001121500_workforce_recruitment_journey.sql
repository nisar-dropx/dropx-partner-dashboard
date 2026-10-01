-- Keep an append-only operational handoff history between Recruit and the
-- Workforce Register. Recruit remains the candidate source of truth; this
-- table records only the operational actions taken after an interview is
-- scheduled so a station can trace a candidate by lead or workforce ID.
create table if not exists public.workforce_recruitment_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  workforce_id uuid references public.workforce(id) on delete set null,
  event_code text not null,
  event_at timestamptz not null default now(),
  actor_user_id uuid references public.profiles(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists workforce_recruitment_events_lead_idx
  on public.workforce_recruitment_events (company_id, lead_id, event_at desc);

create index if not exists workforce_recruitment_events_workforce_idx
  on public.workforce_recruitment_events (company_id, workforce_id, event_at desc)
  where workforce_id is not null;

-- The Operations interview queue always filters the Recruit source by company,
-- scheduled state and day. This avoids scanning the full lead history.
create index if not exists leads_company_interview_queue_idx
  on public.leads (company_id, status, interview_at)
  where archived_at is null and duplicate_of is null;
