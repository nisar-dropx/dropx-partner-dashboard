-- Insurance cards for DropX One. An external worker pulls each person's card from the insurer
-- portal, uploads it to Google Drive (shared "anyone with the link can view") and upserts one row
-- here per person. The app downloads the file straight from Drive on first view and keeps it on the
-- phone, so viewing a card costs no Supabase storage or Vercel bandwidth.
create table if not exists connect_insurance_cards (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  -- Same identity the DropX One documents API uses: 'employee' | 'contractor' | 'workforce',
  -- and the id of that person's row in its table.
  profile_type text not null check (profile_type in ('employee', 'contractor', 'workforce')),
  profile_id uuid not null,
  drive_file_id text not null,
  file_name text,
  mime_type text,
  policy_number text,
  insurer_name text,
  valid_from date,
  valid_to date,
  -- When the worker last fetched the card from the insurer. The app re-downloads the file when this
  -- changes, so bump it whenever the card is replaced.
  source_updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, profile_type, profile_id)
);

create index if not exists connect_insurance_cards_person_idx
  on connect_insurance_cards (company_id, profile_type, profile_id);

-- Only the service role (server + worker) reads or writes this table.
alter table connect_insurance_cards enable row level security;
