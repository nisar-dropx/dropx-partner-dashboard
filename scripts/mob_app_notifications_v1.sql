create extension if not exists pgcrypto;

create table if not exists public.mob_app_notifications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  recipient_profile_type text not null,
  recipient_account_id uuid not null,
  event_code text not null default 'manual',
  title text not null,
  body text not null,
  route text,
  data jsonb not null default '{}'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  archived_at timestamptz,
  push_status text not null default 'not_configured',
  push_error text,
  constraint mob_app_notifications_profile_type_check
    check (recipient_profile_type in ('employee', 'field_executive', 'contractor', 'vendor', 'worker')),
  constraint mob_app_notifications_title_check check (length(trim(title)) between 1 and 120),
  constraint mob_app_notifications_body_check check (length(trim(body)) between 1 and 1000),
  constraint mob_app_notifications_push_status_check
    check (push_status in ('not_configured', 'pending', 'sent', 'failed'))
);

alter table public.mob_app_notifications
  add column if not exists source_key text;

create unique index if not exists mob_app_notifications_source_unique
  on public.mob_app_notifications
  (company_id, event_code, source_key, recipient_account_id);

create index if not exists mob_app_notifications_recipient_idx
  on public.mob_app_notifications
  (company_id, recipient_profile_type, recipient_account_id, created_at desc)
  where archived_at is null;

create index if not exists mob_app_notifications_unread_idx
  on public.mob_app_notifications
  (company_id, recipient_profile_type, recipient_account_id, read_at)
  where archived_at is null and read_at is null;

create table if not exists public.mob_app_device_tokens (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  profile_type text not null,
  account_id uuid not null,
  platform text not null,
  device_id text not null,
  push_token text,
  app_version text,
  is_active boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mob_app_device_tokens_profile_type_check
    check (profile_type in ('employee', 'field_executive', 'contractor', 'vendor', 'worker')),
  constraint mob_app_device_tokens_platform_check check (platform in ('android', 'web'))
);

create unique index if not exists mob_app_device_tokens_account_device_unique
  on public.mob_app_device_tokens (company_id, profile_type, account_id, device_id);

create unique index if not exists mob_app_device_tokens_push_token_unique
  on public.mob_app_device_tokens (push_token)
  where push_token is not null;

create table if not exists public.mob_app_notification_rules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  event_code text not null,
  enabled boolean not null default true,
  title_template text not null,
  body_template text not null,
  route text not null default 'attendance',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mob_app_notification_rules_title_check
    check (length(trim(title_template)) between 1 and 120),
  constraint mob_app_notification_rules_body_check
    check (length(trim(body_template)) between 1 and 1000),
  constraint mob_app_notification_rules_company_event_unique
    unique (company_id, event_code)
);

alter table public.mob_app_notification_rules
  drop constraint if exists mob_app_notification_rules_event_check;

alter table public.mob_app_notification_rules
  add constraint mob_app_notification_rules_event_check
  check (event_code in (
    'attendance_punch_in',
    'attendance_punch_out',
    'attendance_early_out',
    'attendance_exception_review',
    'attendance_half_day',
    'attendance_late_in',
    'attendance_overtime',
    'attendance_punch_in_reminder',
    'attendance_punch_out_reminder',
    'attendance_short_day',
    'profile_submitted',
    'profile_approved',
    'profile_returned',
    'attendance_regularization_submitted',
    'attendance_location_flagged',
    'attendance_forgot_punch_out',
    'communication_announcement',
    'leave_request_submitted',
    'advance_request_raised',
    'advance_request_approved',
    'advance_request_rejected',
    'exit_request_raised',
    'exit_request_approved',
    'exit_request_rejected'
  ));

alter table public.mob_app_notifications enable row level security;
alter table public.mob_app_device_tokens enable row level security;
alter table public.mob_app_notification_rules enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'mob_app_notifications'
      and policyname = 'service_role_mob_app_notifications_all'
  ) then
    create policy "service_role_mob_app_notifications_all"
      on public.mob_app_notifications
      for all
      using (auth.role() = 'service_role')
      with check (auth.role() = 'service_role');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'mob_app_device_tokens'
      and policyname = 'service_role_mob_app_device_tokens_all'
  ) then
    create policy "service_role_mob_app_device_tokens_all"
      on public.mob_app_device_tokens
      for all
      using (auth.role() = 'service_role')
      with check (auth.role() = 'service_role');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'mob_app_notification_rules'
      and policyname = 'service_role_mob_app_notification_rules_all'
  ) then
    create policy "service_role_mob_app_notification_rules_all"
      on public.mob_app_notification_rules
      for all
      using (auth.role() = 'service_role')
      with check (auth.role() = 'service_role');
  end if;
end $$;

notify pgrst, 'reload schema';
