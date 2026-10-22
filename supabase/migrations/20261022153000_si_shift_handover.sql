-- Dark Store Shift Incharge task list & handover (Ops Pulse).
-- Clock-out enforcement mode is stored in master settings (ops_only | hard_block | soft_warn), not hardcoded.
begin;

create table if not exists public.ops_si_handover_master (
  company_id uuid primary key references public.companies(id),
  version integer not null default 1,
  template jsonb not null,
  settings jsonb not null,
  updated_by uuid,
  updated_at timestamptz not null default now()
);

create table if not exists public.ops_si_shift_checklists (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  location_id uuid not null references public.stations(id),
  store_code text not null,
  store_name text not null,
  shift_date date not null,
  shift_slot text not null check (shift_slot in ('06:00','14:00','22:00')),
  status text not null default 'open'
    check (status in ('open','submitted','rejected','accepted','cancelled')),
  template jsonb not null,
  template_version integer not null,
  answers jsonb not null default '{}'::jsonb,
  rejection jsonb,
  open_issues text not null default '',
  events jsonb not null default '[]'::jsonb,
  version integer not null default 1,
  outgoing_user_id uuid not null references public.profiles(id),
  outgoing_name text not null,
  incoming_user_id uuid references public.profiles(id),
  incoming_name text,
  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  accepted_at timestamptz,
  rejected_at timestamptz,
  accepted_by uuid references public.profiles(id),
  rejected_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (company_id, id),
  check (
    (status in ('open','rejected','cancelled') and submitted_at is null)
    or (status in ('submitted','accepted','rejected') and submitted_at is not null)
    or (status = 'rejected' and rejected_at is not null)
    or true
  )
);

-- One active checklist per store per shift slot (cancelled rows excluded).
create unique index if not exists ops_si_shift_checklists_active_slot
  on public.ops_si_shift_checklists (company_id, location_id, shift_date, shift_slot)
  where deleted_at is null and status <> 'cancelled';

create index if not exists ops_si_shift_checklists_scope
  on public.ops_si_shift_checklists (company_id, location_id, shift_date desc, shift_slot)
  where deleted_at is null;

create index if not exists ops_si_shift_checklists_pending
  on public.ops_si_shift_checklists (company_id, status, submitted_at)
  where deleted_at is null and status = 'submitted';

create table if not exists public.ops_si_checklist_evidence (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  checklist_id uuid not null,
  task_id text not null,
  file_name text not null,
  content_type text not null,
  size integer not null check (size > 0 and size <= 31457280),
  path text not null unique,
  ready boolean not null default false,
  captured_at timestamptz not null,
  latitude double precision,
  longitude double precision,
  uploaded_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  foreign key (company_id, checklist_id)
    references public.ops_si_shift_checklists (company_id, id)
);

create index if not exists ops_si_checklist_evidence_task
  on public.ops_si_checklist_evidence (company_id, checklist_id, task_id);

create or replace function public.guard_si_checklist_evidence()
returns trigger language plpgsql set search_path = public as $$
declare c public.ops_si_shift_checklists;
declare row_data public.ops_si_checklist_evidence;
begin
  row_data := case when TG_OP = 'DELETE' then OLD else NEW end;
  select * into c from public.ops_si_shift_checklists
    where id = row_data.checklist_id and company_id = row_data.company_id for update;
  if c.id is null or c.deleted_at is not null then
    raise exception 'Checklist unavailable';
  end if;
  if c.status not in ('open', 'rejected') then
    raise exception 'Evidence is locked after submission';
  end if;
  if c.outgoing_user_id <> row_data.uploaded_by then
    raise exception 'Only the outgoing Shift Incharge can upload proof';
  end if;
  if TG_OP <> 'DELETE' and NEW.captured_at is null then
    raise exception 'Proof timestamp (captured_at) is required';
  end if;
  return row_data;
end $$;

drop trigger if exists si_checklist_evidence_guard on public.ops_si_checklist_evidence;
create trigger si_checklist_evidence_guard
  before insert or update or delete on public.ops_si_checklist_evidence
  for each row execute function public.guard_si_checklist_evidence();

create or replace function public.guard_si_checklist_lock()
returns trigger language plpgsql set search_path = public as $$
begin
  if OLD.status = 'accepted' and NEW.status = 'accepted' then
    if NEW.answers is distinct from OLD.answers
      or NEW.template is distinct from OLD.template
      or NEW.open_issues is distinct from OLD.open_issues then
      raise exception 'Accepted checklists are read-only';
    end if;
  end if;
  if OLD.template_version is distinct from NEW.template_version
    and OLD.status not in ('open') then
    raise exception 'Template snapshot cannot change after start';
  end if;
  NEW.updated_at := now();
  return NEW;
end $$;

drop trigger if exists si_checklist_lock_guard on public.ops_si_shift_checklists;
create trigger si_checklist_lock_guard
  before update on public.ops_si_shift_checklists
  for each row execute function public.guard_si_checklist_lock();

alter table public.ops_si_handover_master enable row level security;
alter table public.ops_si_shift_checklists enable row level security;
alter table public.ops_si_checklist_evidence enable row level security;

revoke all on public.ops_si_handover_master, public.ops_si_shift_checklists, public.ops_si_checklist_evidence
  from anon, authenticated;
grant all on public.ops_si_handover_master, public.ops_si_shift_checklists, public.ops_si_checklist_evidence
  to service_role;

insert into public.app_pages (company_id, code, name, sort_order, is_active)
select c.id, p.code, p.name, p.sort_order, true
from public.companies c
cross join (values
  ('si_handover', 'SI Shift Handover', 93),
  ('si_handover_master', 'SI Handover Master', 94)
) as p(code, name, sort_order)
on conflict (company_id, code) do nothing;

insert into public.role_page_permissions (company_id, role_id, page_id, can_view, can_add, can_edit)
select r.company_id, r.role_id, target.id, r.can_view, r.can_add, r.can_edit
from public.role_page_permissions r
join public.app_pages source
  on source.id = r.page_id and source.company_id = r.company_id
join public.app_pages target
  on target.company_id = source.company_id
 and target.code = case source.code
   when 'store_audits' then 'si_handover'
   else 'si_handover_master'
 end
where source.code in ('store_audits', 'store_audit_master')
on conflict (company_id, role_id, page_id) do nothing;

-- Seed master rows with empty template; app ensureMaster() fills the default catalogue.
insert into public.ops_si_handover_master (company_id, template, settings)
select
  c.id,
  jsonb_build_object(
    'name', 'Ops Pulse · Shift Incharge task list',
    'description', 'Seeded placeholder — replaced by app default template on first open.',
    'sections', '[]'::jsonb
  ),
  jsonb_build_object(
    'managerRoles', coalesce(to_jsonb(s.scheduler_role_ids), '[]'::jsonb),
    'siRoles', '[]'::jsonb,
    'modelIds', coalesce(
      (select jsonb_agg(m.id) from public.location_models m
        where m.company_id = c.id and upper(m.code) = 'NOW'),
      '[]'::jsonb
    ),
    'hyderabadCityMatch', jsonb_build_array('hyderabad', 'hyd'),
    'clockOutMode', 'ops_only',
    'escalateStoreMinutes', 30,
    'escalateClusterMinutes', 60,
    'shiftSlots', jsonb_build_array('06:00', '14:00', '22:00')
  )
from public.companies c
left join public.ops_audit_programme_settings s on s.company_id = c.id
on conflict (company_id) do nothing;

notify pgrst, 'reload schema';
commit;
