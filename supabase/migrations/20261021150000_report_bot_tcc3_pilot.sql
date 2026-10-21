begin;

-- TCC3 War Room Report Bot pilot: per-group Observe/Review/Live, inbound text+image
-- events with retention, review items, open actions, daily summaries, and schedule/
-- report-type fields for configurable (not worker-hardcoded) operational rules.
-- Safe to run twice.

-- ---------------------------------------------------------------------------
-- Settings: correlation window and inbound retention
-- ---------------------------------------------------------------------------
alter table public.report_bot_settings
  add column if not exists correlation_window_minutes integer not null default 10
    check (correlation_window_minutes between 1 and 120);

alter table public.report_bot_settings
  add column if not exists inbound_retention_days integer not null default 30
    check (inbound_retention_days between 1 and 365);

-- ---------------------------------------------------------------------------
-- Groups: per-group operating mode (company mode remains the master switch)
-- ---------------------------------------------------------------------------
alter table public.report_bot_groups
  add column if not exists mode text not null default 'observe';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'report_bot_groups_mode_check'
      and conrelid = 'public.report_bot_groups'::regclass
  ) then
    alter table public.report_bot_groups
      add constraint report_bot_groups_mode_check
      check (mode in ('observe', 'review', 'live'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Report types: catalog metadata (rules stay in rules[]; never hardcode in worker)
-- ---------------------------------------------------------------------------
alter table public.report_bot_report_types
  add column if not exists slug text;

alter table public.report_bot_report_types
  add column if not exists category text not null default 'general';

alter table public.report_bot_report_types
  add column if not exists auto_reply_policy text not null default 'normal';

alter table public.report_bot_report_types
  add column if not exists subtypes text[] not null default '{}';

alter table public.report_bot_report_types
  add column if not exists feedback_hint text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'report_bot_report_types_auto_reply_policy_check'
      and conrelid = 'public.report_bot_report_types'::regclass
  ) then
    alter table public.report_bot_report_types
      add constraint report_bot_report_types_auto_reply_policy_check
      check (auto_reply_policy in ('never', 'normal'));
  end if;
end $$;

create unique index if not exists report_bot_report_types_company_slug_uidx
  on public.report_bot_report_types (company_id, slug)
  where slug is not null;

-- ---------------------------------------------------------------------------
-- Schedules: review-only flag, escalation, kind (timed / interval / event_driven)
-- ---------------------------------------------------------------------------
alter table public.report_bot_schedules
  add column if not exists review_only boolean not null default true;

alter table public.report_bot_schedules
  add column if not exists escalation_delay_minutes integer not null default 30
    check (escalation_delay_minutes between 0 and 1440);

alter table public.report_bot_schedules
  add column if not exists schedule_kind text not null default 'timed';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'report_bot_schedules_schedule_kind_check'
      and conrelid = 'public.report_bot_schedules'::regclass
  ) then
    alter table public.report_bot_schedules
      add constraint report_bot_schedules_schedule_kind_check
      check (schedule_kind in ('timed', 'interval', 'event_driven'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Inbound operational events (text + image metadata; short retention)
-- ---------------------------------------------------------------------------
create table if not exists public.report_bot_inbound_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  group_id uuid not null references public.report_bot_groups(id) on delete cascade,
  wa_message_id text not null,
  sender_jid text,
  sender_name text,
  from_me boolean not null default false,
  message_at timestamptz not null,
  message_type text not null check (message_type in ('text', 'image', 'document')),
  text_body text,
  caption text,
  quoted_message_id text,
  quoted_participant text,
  media_ref text,
  media_mime text,
  media_size integer,
  wa_message_record text check (wa_message_record is null or length(wa_message_record) <= 100000),
  bundle_id uuid,
  submission_id uuid references public.report_bot_submissions(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (group_id, wa_message_id)
);

create index if not exists report_bot_inbound_events_company_at_idx
  on public.report_bot_inbound_events (company_id, message_at desc);
create index if not exists report_bot_inbound_events_group_sender_at_idx
  on public.report_bot_inbound_events (group_id, sender_jid, message_at desc);
create index if not exists report_bot_inbound_events_bundle_idx
  on public.report_bot_inbound_events (bundle_id)
  where bundle_id is not null;
create index if not exists report_bot_inbound_events_retention_idx
  on public.report_bot_inbound_events (message_at);

alter table public.report_bot_inbound_events enable row level security;
alter table public.report_bot_inbound_events force row level security;
revoke all on table public.report_bot_inbound_events from public, anon, authenticated;
grant select, insert, update, delete on table public.report_bot_inbound_events to service_role;

-- ---------------------------------------------------------------------------
-- Review items (classification + manager workflow)
-- ---------------------------------------------------------------------------
create table if not exists public.report_bot_review_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  group_id uuid not null references public.report_bot_groups(id) on delete cascade,
  bundle_id uuid,
  primary_event_id uuid references public.report_bot_inbound_events(id) on delete set null,
  submission_id uuid references public.report_bot_submissions(id) on delete set null,
  report_type_id uuid references public.report_bot_report_types(id) on delete set null,
  request_id uuid references public.report_bot_requests(id) on delete set null,
  review_status text not null default 'observe_only'
    check (review_status in ('observe_only', 'draft_ready', 'approved', 'sent', 'dismissed')),
  verdict text check (verdict in ('pass', 'fail', 'needs_review', 'not_report')),
  confidence numeric(4, 3),
  reason text,
  extracted_facts jsonb not null default '[]'::jsonb,
  open_actions jsonb not null default '[]'::jsonb,
  feedback_draft text,
  ai_result jsonb,
  ai_provider text,
  ai_model text,
  status_reason text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists report_bot_review_items_queue_idx
  on public.report_bot_review_items (company_id, review_status, created_at desc);
create index if not exists report_bot_review_items_group_idx
  on public.report_bot_review_items (group_id, created_at desc);
create index if not exists report_bot_review_items_bundle_idx
  on public.report_bot_review_items (bundle_id)
  where bundle_id is not null;

alter table public.report_bot_review_items enable row level security;
alter table public.report_bot_review_items force row level security;
revoke all on table public.report_bot_review_items from public, anon, authenticated;
grant select, insert, update, delete on table public.report_bot_review_items to service_role;

-- ---------------------------------------------------------------------------
-- Open actions / tickets
-- ---------------------------------------------------------------------------
create table if not exists public.report_bot_actions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  group_id uuid not null references public.report_bot_groups(id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 300),
  category text not null default 'general',
  owner_name text,
  owner_jid text,
  status text not null default 'open'
    check (status in ('open', 'pending_evidence', 'closed', 'cancelled', 'unmatched_closure')),
  due_at timestamptz,
  source_event_id uuid references public.report_bot_inbound_events(id) on delete set null,
  source_review_id uuid references public.report_bot_review_items(id) on delete set null,
  closure_event_id uuid references public.report_bot_inbound_events(id) on delete set null,
  closure_note text,
  high_risk boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);

create index if not exists report_bot_actions_open_idx
  on public.report_bot_actions (company_id, status, created_at desc)
  where status in ('open', 'pending_evidence', 'unmatched_closure');
create index if not exists report_bot_actions_group_idx
  on public.report_bot_actions (group_id, status);

alter table public.report_bot_actions enable row level security;
alter table public.report_bot_actions force row level security;
revoke all on table public.report_bot_actions from public, anon, authenticated;
grant select, insert, update, delete on table public.report_bot_actions to service_role;

-- ---------------------------------------------------------------------------
-- Review audit trail
-- ---------------------------------------------------------------------------
create table if not exists public.report_bot_review_audit (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  review_id uuid not null references public.report_bot_review_items(id) on delete cascade,
  action text not null check (action in ('created', 'approved', 'edited', 'sent', 'dismissed', 'reanalysed')),
  actor_user_id uuid,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists report_bot_review_audit_review_idx
  on public.report_bot_review_audit (review_id, created_at desc);

alter table public.report_bot_review_audit enable row level security;
alter table public.report_bot_review_audit force row level security;
revoke all on table public.report_bot_review_audit from public, anon, authenticated;
grant select, insert, update, delete on table public.report_bot_review_audit to service_role;

-- ---------------------------------------------------------------------------
-- Daily site summary (portal rollup; WhatsApp post is opt-in later)
-- ---------------------------------------------------------------------------
create table if not exists public.report_bot_daily_summaries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  group_id uuid not null references public.report_bot_groups(id) on delete cascade,
  business_date date not null,
  summary jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (group_id, business_date)
);

create index if not exists report_bot_daily_summaries_company_idx
  on public.report_bot_daily_summaries (company_id, business_date desc);

alter table public.report_bot_daily_summaries enable row level security;
alter table public.report_bot_daily_summaries force row level security;
revoke all on table public.report_bot_daily_summaries from public, anon, authenticated;
grant select, insert, update, delete on table public.report_bot_daily_summaries to service_role;

-- Link submissions back to review items when present
alter table public.report_bot_submissions
  add column if not exists review_id uuid references public.report_bot_review_items(id) on delete set null;

-- Retention prune helper (service_role only)
create or replace function public.report_bot_prune_inbound_events(p_company_id uuid, p_retention_days integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count integer;
begin
  if p_retention_days is null or p_retention_days < 1 then
    return 0;
  end if;
  with doomed as (
    delete from public.report_bot_inbound_events
    where company_id = p_company_id
      and message_at < (now() - make_interval(days => p_retention_days))
    returning 1
  )
  select count(*)::integer into deleted_count from doomed;
  return coalesce(deleted_count, 0);
end;
$$;

revoke all on function public.report_bot_prune_inbound_events(uuid, integer) from public, anon, authenticated;
grant execute on function public.report_bot_prune_inbound_events(uuid, integer) to service_role;

commit;
