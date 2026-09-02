-- Preserve every historical raw event while making middleware delivery idempotent.
create table if not exists public.biometric_raw_event_duplicates_archive
  (like public.biometric_raw_events including defaults including generated);

alter table public.biometric_raw_event_duplicates_archive
  add column if not exists canonical_raw_event_id uuid,
  add column if not exists archived_at timestamptz not null default now();

alter table public.biometric_raw_event_duplicates_archive enable row level security;

create unique index if not exists biometric_raw_event_duplicates_archive_id_uidx
  on public.biometric_raw_event_duplicates_archive (id);

create temporary table biometric_raw_event_dedupe_map on commit drop as
with referenced as (
  select raw_event_id as id
  from public.attendance_punches
  where raw_event_id is not null
  union
  select raw_event_id as id
  from public.biometric_alerts
  where raw_event_id is not null
), ranked as (
  select
    raw.id,
    first_value(raw.id) over (
      partition by raw.company_id, raw.middleware_raw_event_id
      order by (referenced.id is not null) desc, raw.created_at, raw.id
    ) as canonical_raw_event_id,
    row_number() over (
      partition by raw.company_id, raw.middleware_raw_event_id
      order by (referenced.id is not null) desc, raw.created_at, raw.id
    ) as duplicate_rank
  from public.biometric_raw_events raw
  left join referenced on referenced.id = raw.id
  where raw.company_id is not null
    and raw.middleware_raw_event_id is not null
)
select id as duplicate_raw_event_id, canonical_raw_event_id
from ranked
where duplicate_rank > 1;

insert into public.biometric_raw_event_duplicates_archive (
  id,
  middleware_raw_event_id,
  received_at,
  event_type,
  device_serial,
  terminal_id,
  trans_id,
  enrolment_id,
  employee_code,
  punch_time,
  source_ip,
  worker_status,
  payload,
  created_at,
  company_id,
  device_id,
  canonical_raw_event_id,
  archived_at
)
select
  raw.id,
  raw.middleware_raw_event_id,
  raw.received_at,
  raw.event_type,
  raw.device_serial,
  raw.terminal_id,
  raw.trans_id,
  raw.enrolment_id,
  raw.employee_code,
  raw.punch_time,
  raw.source_ip,
  raw.worker_status,
  raw.payload,
  raw.created_at,
  raw.company_id,
  raw.device_id,
  dedupe.canonical_raw_event_id,
  now()
from public.biometric_raw_events raw
join biometric_raw_event_dedupe_map dedupe
  on dedupe.duplicate_raw_event_id = raw.id
on conflict (id) do update
set canonical_raw_event_id = excluded.canonical_raw_event_id,
    archived_at = excluded.archived_at;

update public.attendance_punches punch
set raw_event_id = dedupe.canonical_raw_event_id
from biometric_raw_event_dedupe_map dedupe
where punch.raw_event_id = dedupe.duplicate_raw_event_id;

update public.biometric_alerts alert
set raw_event_id = dedupe.canonical_raw_event_id
from biometric_raw_event_dedupe_map dedupe
where alert.raw_event_id = dedupe.duplicate_raw_event_id;

delete from public.biometric_raw_events raw
using biometric_raw_event_dedupe_map dedupe
where raw.id = dedupe.duplicate_raw_event_id;

create unique index if not exists biometric_raw_events_company_middleware_id_uidx
  on public.biometric_raw_events (company_id, middleware_raw_event_id);

-- Keep webhook identity resolution on indexed point lookups only.
create index if not exists contractors_company_biometric_id_idx
  on public.contractors (company_id, biometric_id)
  where biometric_id is not null;

create index if not exists workforce_company_biometric_id_idx
  on public.workforce (company_id, biometric_id)
  where biometric_id is not null;

