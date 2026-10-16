begin;

-- The Report Bot worker keeps no state on its own disk, so it can run on hosts whose
-- disk is wiped on every deploy (Railway, Render, Fly) without re-linking WhatsApp.

-- WhatsApp linked-device login (credentials and Signal keys), one row per key.
-- Values are BufferJSON text written and read only by the company's worker.
create table if not exists public.report_bot_wa_auth (
  company_id uuid not null,
  key text not null check (length(key) between 1 and 300),
  value text not null,
  updated_at timestamptz not null default now(),
  primary key (company_id, key)
);

alter table public.report_bot_wa_auth enable row level security;
alter table public.report_bot_wa_auth force row level security;
revoke all on table public.report_bot_wa_auth from public, anon, authenticated;
grant select, insert, update, delete on table public.report_bot_wa_auth to service_role;

-- The small WhatsApp message record behind each photo, so the image can be downloaded
-- from WhatsApp again whenever it is needed. Capped so a malformed message can't bloat rows.
alter table public.report_bot_submissions
  add column if not exists wa_message_record text check (wa_message_record is null or length(wa_message_record) <= 100000);

commit;
