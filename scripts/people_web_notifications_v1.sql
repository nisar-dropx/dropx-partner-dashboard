-- Mirror: People web notifications for attendance integrity (shared Supabase)
create table if not exists public.people_web_notifications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  recipient_user_id uuid not null references public.profiles(id) on delete cascade,
  event_code text not null,
  title text not null,
  body text not null,
  href text not null default '/attendance/integrity',
  source_key text not null,
  data jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists people_web_notifications_dedupe_idx
  on public.people_web_notifications (company_id, event_code, source_key, recipient_user_id);

create index if not exists people_web_notifications_recipient_idx
  on public.people_web_notifications (company_id, recipient_user_id, created_at desc)
  where read_at is null;
