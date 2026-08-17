alter table public.contractors
  add column if not exists onboarding_application_source text default 'dashboard',
  add column if not exists recruitment_lead_id uuid references public.recruitment_leads(id) on delete set null;

alter table public.workforce_onboarding_events
  add column if not exists contractor_id uuid references public.contractors(id) on delete cascade;

alter table public.whatsapp_message_logs
  add column if not exists contractor_id uuid references public.contractors(id) on delete set null;

create index if not exists contractors_recruitment_lead_id_idx
  on public.contractors (recruitment_lead_id)
  where recruitment_lead_id is not null;

create index if not exists workforce_onboarding_events_contractor_id_idx
  on public.workforce_onboarding_events (contractor_id)
  where contractor_id is not null;

create index if not exists whatsapp_message_logs_contractor_id_idx
  on public.whatsapp_message_logs (contractor_id)
  where contractor_id is not null;
