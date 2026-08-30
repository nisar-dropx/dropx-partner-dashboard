begin;

update public.app_pages
set name = 'Mail', updated_at = now()
where code = 'ops_location_mail';

alter table public.ops_location_mail_messages
  add column if not exists bcc_emails text[] not null default '{}',
  add column if not exists label_ids text[] not null default '{}',
  add column if not exists snoozed_until timestamptz;

create table if not exists public.ops_mail_sender_profiles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  mailbox_address_id uuid not null references public.ops_location_mailbox_addresses(id) on delete cascade,
  sender_display_name text not null,
  station_label text not null,
  contact_name text not null default '',
  contact_title text not null default 'Team Leader',
  contact_mobile text not null default '',
  logo_url text not null default '',
  accent_color text not null default '#ef6c00',
  signature_enabled boolean not null default true,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(company_id, mailbox_address_id),
  check (accent_color ~ '^#[0-9a-fA-F]{6}$')
);

create table if not exists public.ops_mail_drafts (
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
  subject text not null default '',
  body_text text not null default '',
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ops_mail_drafts_station_idx
  on public.ops_mail_drafts(company_id, station_id, updated_at desc);

create index if not exists ops_location_mail_messages_labels_idx
  on public.ops_location_mail_messages using gin(label_ids);

alter table public.ops_mail_sender_profiles enable row level security;
alter table public.ops_mail_drafts enable row level security;

revoke all on public.ops_mail_sender_profiles from anon, authenticated;
revoke all on public.ops_mail_drafts from anon, authenticated;

insert into public.ops_mail_sender_profiles (
  company_id,
  mailbox_address_id,
  sender_display_name,
  station_label,
  contact_name,
  contact_title,
  contact_mobile,
  logo_url
)
select
  address.company_id,
  address.id,
  concat(station.station_code, ' DropX Logistics'),
  concat(station.station_code, ' · ', coalesce(nullif(station.station_name, ''), 'Station')),
  coalesce(profile.full_name, ''),
  'Team Leader',
  trim(concat_ws(' ',
    case
      when nullif(trim(profile.mobile_country_code), '') is null then null
      when trim(profile.mobile_country_code) like '+%' then trim(profile.mobile_country_code)
      else '+' || trim(profile.mobile_country_code)
    end,
    nullif(trim(profile.mobile), '')
  )),
  'https://ops.dropxlogistics.com/dropx-logo.png'
from public.ops_location_mailbox_addresses address
join public.stations station
  on station.id = address.station_id
 and station.company_id = address.company_id
left join public.profiles profile
  on profile.company_id = station.company_id
 and lower(profile.email) = lower(station.station_manager_email)
where address.is_active = true
on conflict (company_id, mailbox_address_id) do nothing;

comment on table public.ops_mail_sender_profiles is
  'Station-scoped sender identity and professional signature configuration for OpsPulse Mail.';
comment on table public.ops_mail_drafts is
  'Shared station-mail drafts visible to users who hold the corresponding location scope.';

commit;
