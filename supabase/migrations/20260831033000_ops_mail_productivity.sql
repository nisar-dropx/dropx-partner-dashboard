begin;

alter table public.ops_location_mail_messages
  add column if not exists from_name text not null default '',
  add column if not exists snoozed_until timestamptz;

create index if not exists ops_location_mail_messages_snoozed_idx
  on public.ops_location_mail_messages(company_id, station_id, snoozed_until)
  where snoozed_until is not null;

create table if not exists public.ops_mail_scheduled_messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  mailbox_id uuid not null references public.ops_location_mailboxes(id) on delete cascade,
  mailbox_address_id uuid not null references public.ops_location_mailbox_addresses(id) on delete cascade,
  station_id uuid not null references public.stations(id) on delete cascade,
  google_thread_id text,
  in_reply_to text,
  reference_ids text,
  to_emails text[] not null default '{}',
  cc_emails text[] not null default '{}',
  bcc_emails text[] not null default '{}',
  subject text not null,
  body_text text not null,
  scheduled_for timestamptz not null,
  status text not null default 'scheduled',
  google_message_id text,
  last_error text,
  created_by uuid,
  cancelled_by uuid,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status in ('scheduled', 'sending', 'sent', 'cancelled', 'failed'))
);

create index if not exists ops_mail_scheduled_due_idx
  on public.ops_mail_scheduled_messages(status, scheduled_for)
  where status in ('scheduled', 'failed');
create index if not exists ops_mail_scheduled_station_idx
  on public.ops_mail_scheduled_messages(company_id, station_id, scheduled_for desc);

create table if not exists public.ops_mail_thread_states (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  mailbox_address_id uuid not null references public.ops_location_mailbox_addresses(id) on delete cascade,
  station_id uuid not null references public.stations(id) on delete cascade,
  google_thread_id text not null,
  workflow_status text not null default 'open',
  priority text not null default 'normal',
  assigned_to uuid references public.profiles(id) on delete set null,
  follow_up_at timestamptz,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(company_id, mailbox_address_id, google_thread_id),
  check (workflow_status in ('open', 'pending', 'resolved')),
  check (priority in ('normal', 'high', 'urgent'))
);

create index if not exists ops_mail_thread_states_queue_idx
  on public.ops_mail_thread_states(company_id, station_id, workflow_status, priority, updated_at desc);

create table if not exists public.ops_mail_thread_notes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  mailbox_address_id uuid not null references public.ops_location_mailbox_addresses(id) on delete cascade,
  station_id uuid not null references public.stations(id) on delete cascade,
  google_thread_id text not null,
  note text not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  check (char_length(note) between 1 and 2000)
);

create index if not exists ops_mail_thread_notes_thread_idx
  on public.ops_mail_thread_notes(company_id, mailbox_address_id, google_thread_id, created_at desc);

alter table public.ops_mail_scheduled_messages enable row level security;
alter table public.ops_mail_thread_states enable row level security;
alter table public.ops_mail_thread_notes enable row level security;

revoke all on public.ops_mail_scheduled_messages from public, anon, authenticated;
revoke all on public.ops_mail_thread_states from public, anon, authenticated;
revoke all on public.ops_mail_thread_notes from public, anon, authenticated;
grant all on public.ops_mail_scheduled_messages to service_role;
grant all on public.ops_mail_thread_states to service_role;
grant all on public.ops_mail_thread_notes to service_role;

comment on table public.ops_mail_scheduled_messages is
  'Station-scoped emails queued for cron delivery from the shared OpsPulse mailbox.';
comment on table public.ops_mail_thread_states is
  'Shared operational ownership, priority and resolution state for an OpsPulse Mail conversation.';
comment on table public.ops_mail_thread_notes is
  'Internal-only collaboration notes attached to an OpsPulse Mail conversation.';

commit;
