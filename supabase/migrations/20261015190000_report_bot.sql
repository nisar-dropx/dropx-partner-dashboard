begin;

-- WhatsApp Report Bot (Ops Pulse · Dark Store).
-- A self-hosted worker sits in WhatsApp groups as a linked device. It forwards
-- report images from enabled groups to the portal and sends what the portal's
-- outbox tells it to. Every behaviour (mode, AI provider/model, templates,
-- delays, schedules) is configuration in these tables, not code.

create table if not exists public.report_bot_settings (
  company_id uuid primary key,
  mode text not null default 'off' check (mode in ('off', 'listen', 'live')),
  timezone text not null default 'Asia/Kolkata',
  worker_url text,
  worker_token text,
  worker_token_hash text unique,
  worker_token_created_at timestamptz,
  ai_provider text not null default 'anthropic' check (ai_provider in ('anthropic', 'openai')),
  ai_model text not null default 'claude-opus-5-5',
  ai_effort text not null default 'medium' check (ai_effort in ('low', 'medium', 'high')),
  approval_mode text not null default 'manual' check (approval_mode in ('manual', 'auto')),
  auto_send_min_confidence numeric(4, 3) not null default 0.850 check (auto_send_min_confidence between 0 and 1),
  reply_delay_min_seconds integer not null default 20 check (reply_delay_min_seconds between 0 and 3600),
  reply_delay_max_seconds integer not null default 90 check (reply_delay_max_seconds between 0 and 3600),
  group_min_gap_seconds integer not null default 30 check (group_min_gap_seconds between 0 and 3600),
  max_reminder_delay_minutes integer not null default 30 check (max_reminder_delay_minutes between 1 and 1440),
  include_own_messages boolean not null default false,
  accept_without_request boolean not null default false,
  feedback_language text not null default 'English',
  feedback_template text not null default E'*{report}* · {sender}\n{verdict_label}\n{feedback}',
  label_pass text not null default '✅ Looks good',
  label_fail text not null default '❌ Needs correction',
  label_review text not null default '🔎 The team will check this one',
  max_feedback_chars integer not null default 700 check (max_feedback_chars between 100 and 3000),
  connection_state text not null default 'unknown',
  connected_number text,
  connected_name text,
  connection_error text,
  last_worker_seen_at timestamptz,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  check (reply_delay_max_seconds >= reply_delay_min_seconds)
);

create table if not exists public.report_bot_groups (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  wa_group_id text not null check (wa_group_id ~ '^[0-9-]+@g\.us$'),
  group_name text,
  participant_count integer,
  location_id uuid references public.stations(id) on delete set null,
  is_enabled boolean not null default false,
  bot_in_group boolean not null default true,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, wa_group_id)
);

create table if not exists public.report_bot_report_types (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 120),
  description text,
  rules text[] not null default '{}',
  is_active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.report_bot_schedules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  group_id uuid not null references public.report_bot_groups(id) on delete cascade,
  report_type_id uuid not null references public.report_bot_report_types(id) on delete cascade,
  days_of_week smallint[] not null default '{0,1,2,3,4,5,6}',
  reminder_times text[] not null default '{}',
  due_time text not null check (due_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  first_reminder_template text not null default E'Good morning {group} team. Please share today''s *{report}* by {due_time}.',
  followup_template text not null default E'Reminder: *{report}* for {date} is still pending. Please share it here.',
  overdue_template text,
  is_active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (group_id, report_type_id)
);

create table if not exists public.report_bot_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  schedule_id uuid not null references public.report_bot_schedules(id) on delete cascade,
  group_id uuid not null references public.report_bot_groups(id) on delete cascade,
  report_type_id uuid not null references public.report_bot_report_types(id) on delete cascade,
  business_date date not null,
  status text not null default 'pending' check (status in ('pending', 'overdue', 'received', 'missed', 'cancelled')),
  reminders_handled integer not null default 0,
  reminders_sent integer not null default 0,
  overdue_notified boolean not null default false,
  received_at timestamptz,
  last_verdict text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (schedule_id, business_date)
);

create table if not exists public.report_bot_submissions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  group_id uuid not null references public.report_bot_groups(id) on delete cascade,
  request_id uuid references public.report_bot_requests(id) on delete set null,
  report_type_id uuid references public.report_bot_report_types(id) on delete set null,
  wa_message_id text not null,
  sender_jid text,
  sender_name text,
  from_me boolean not null default false,
  caption text,
  message_at timestamptz not null,
  media_ref text,
  media_mime text,
  media_size integer,
  storage_bucket text,
  storage_path text,
  status text not null default 'queued' check (status in (
    'queued', 'blocked', 'awaiting_approval', 'queued_to_send', 'sent', 'ignored', 'skipped', 'rejected', 'failed'
  )),
  status_reason text,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  ai_provider text,
  ai_model text,
  ai_result jsonb,
  verdict text check (verdict in ('pass', 'fail', 'needs_review', 'not_report')),
  confidence numeric(4, 3),
  feedback_text text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (group_id, wa_message_id)
);

create table if not exists public.report_bot_outbox (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  group_id uuid not null references public.report_bot_groups(id) on delete cascade,
  kind text not null check (kind in ('reminder', 'followup', 'overdue', 'feedback')),
  dedupe_key text not null,
  body text not null check (length(body) between 1 and 4000),
  quoted_message_id text,
  quoted_participant text,
  mentions text[] not null default '{}',
  request_id uuid references public.report_bot_requests(id) on delete set null,
  submission_id uuid references public.report_bot_submissions(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'cancelled')),
  status_reason text,
  attempts integer not null default 0,
  not_before timestamptz not null default now(),
  stale_after timestamptz,
  locked_until timestamptz,
  sent_wa_message_id text,
  sent_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, dedupe_key)
);

create index if not exists report_bot_groups_company_idx on public.report_bot_groups (company_id, is_enabled);
create index if not exists report_bot_schedules_company_idx on public.report_bot_schedules (company_id, is_active);
create index if not exists report_bot_requests_open_idx on public.report_bot_requests (company_id, business_date, status);
create index if not exists report_bot_requests_group_idx on public.report_bot_requests (group_id, business_date);
create index if not exists report_bot_submissions_work_idx on public.report_bot_submissions (status, next_attempt_at) where status = 'queued';
create index if not exists report_bot_submissions_company_idx on public.report_bot_submissions (company_id, created_at desc);
create index if not exists report_bot_outbox_work_idx on public.report_bot_outbox (status, not_before) where status = 'pending';
create index if not exists report_bot_outbox_group_sent_idx on public.report_bot_outbox (group_id, sent_at desc) where status = 'sent';

-- Claim work with SKIP LOCKED so overlapping cron runs never process the same
-- row twice. A claim is a short lease (locked_until); a crashed run's rows
-- become claimable again once the lease expires.
create or replace function public.report_bot_claim_submissions(p_company_id uuid, p_limit integer, p_lease_seconds integer)
returns setof public.report_bot_submissions
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  return query
  update public.report_bot_submissions submission
  set locked_until = now() + make_interval(secs => greatest(p_lease_seconds, 30)),
      attempts = submission.attempts + 1,
      updated_at = now()
  where submission.id in (
    select candidate.id
    from public.report_bot_submissions candidate
    where candidate.company_id = p_company_id
      and candidate.status = 'queued'
      and candidate.next_attempt_at <= now()
      and (candidate.locked_until is null or candidate.locked_until < now())
    order by candidate.message_at
    limit greatest(least(p_limit, 50), 1)
    for update skip locked
  )
  returning submission.*;
end;
$function$;

create or replace function public.report_bot_claim_outbox(p_company_id uuid, p_limit integer, p_lease_seconds integer)
returns setof public.report_bot_outbox
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  return query
  update public.report_bot_outbox item
  set locked_until = now() + make_interval(secs => greatest(p_lease_seconds, 30)),
      attempts = item.attempts + 1,
      updated_at = now()
  where item.id in (
    select candidate.id
    from public.report_bot_outbox candidate
    where candidate.company_id = p_company_id
      and candidate.status = 'pending'
      and candidate.not_before <= now()
      and (candidate.locked_until is null or candidate.locked_until < now())
    order by candidate.not_before, candidate.created_at
    limit greatest(least(p_limit, 50), 1)
    for update skip locked
  )
  returning item.*;
end;
$function$;

do $grants$
declare
  table_name text;
begin
  foreach table_name in array array[
    'report_bot_settings', 'report_bot_groups', 'report_bot_report_types', 'report_bot_schedules',
    'report_bot_requests', 'report_bot_submissions', 'report_bot_outbox'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('alter table public.%I force row level security', table_name);
    execute format('revoke all on table public.%I from public, anon, authenticated', table_name);
    execute format('grant select, insert, update, delete on table public.%I to service_role', table_name);
  end loop;
end;
$grants$;

revoke all on function public.report_bot_claim_submissions(uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.report_bot_claim_outbox(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.report_bot_claim_submissions(uuid, integer, integer) to service_role;
grant execute on function public.report_bot_claim_outbox(uuid, integer, integer) to service_role;

commit;
