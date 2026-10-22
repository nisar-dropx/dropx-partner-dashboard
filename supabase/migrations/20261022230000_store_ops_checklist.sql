-- Store Manager / Store In-charge daily checklist (Store Operations).
-- One checklist per store per day. Submit seals it — no accept / reject.
begin;

create table if not exists public.ops_store_ops_master (
  company_id uuid primary key references public.companies(id),
  version integer not null default 1,
  template jsonb not null,
  settings jsonb not null,
  updated_by uuid,
  updated_at timestamptz not null default now()
);

create table if not exists public.ops_store_ops_checklists (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  location_id uuid not null references public.stations(id),
  store_code text not null,
  store_name text not null,
  work_date date not null,
  status text not null default 'open'
    check (status in ('open', 'submitted', 'cancelled')),
  template jsonb not null,
  template_version integer not null,
  answers jsonb not null default '{}'::jsonb,
  day_summary text not null default '',
  events jsonb not null default '[]'::jsonb,
  version integer not null default 1,
  owner_user_id uuid not null references public.profiles(id),
  owner_name text not null,
  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (company_id, id)
);

create unique index if not exists ops_store_ops_checklists_active_day
  on public.ops_store_ops_checklists (company_id, location_id, work_date)
  where deleted_at is null and status <> 'cancelled';

create index if not exists ops_store_ops_checklists_scope
  on public.ops_store_ops_checklists (company_id, location_id, work_date desc)
  where deleted_at is null;

create table if not exists public.ops_store_ops_evidence (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  checklist_id uuid not null,
  task_id text not null,
  file_name text not null,
  content_type text not null,
  size integer not null check (size > 0 and size <= 83886080),
  path text not null unique,
  ready boolean not null default false,
  captured_at timestamptz not null,
  latitude double precision,
  longitude double precision,
  uploaded_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  foreign key (company_id, checklist_id)
    references public.ops_store_ops_checklists (company_id, id)
);

create index if not exists ops_store_ops_evidence_task
  on public.ops_store_ops_evidence (company_id, checklist_id, task_id);

create or replace function public.guard_store_ops_evidence()
returns trigger language plpgsql set search_path = public as $$
declare c public.ops_store_ops_checklists;
declare row_data public.ops_store_ops_evidence;
begin
  row_data := case when TG_OP = 'DELETE' then OLD else NEW end;
  select * into c from public.ops_store_ops_checklists
    where id = row_data.checklist_id and company_id = row_data.company_id for update;
  if c.id is null or c.deleted_at is not null then
    raise exception 'Checklist unavailable';
  end if;
  if c.status <> 'open' then
    raise exception 'Evidence is locked after submission';
  end if;
  if TG_OP = 'DELETE' then return OLD; end if;
  return NEW;
end;
$$;

drop trigger if exists trg_guard_store_ops_evidence on public.ops_store_ops_evidence;
create trigger trg_guard_store_ops_evidence
before insert or update or delete on public.ops_store_ops_evidence
for each row execute function public.guard_store_ops_evidence();

-- App pages + role grants: SM / Store Incharge write; City+ view/edit oversight.
insert into public.app_pages (company_id, code, name, sort_order, is_active)
select c.id, p.code, p.name, p.sort_order, true
from public.companies c
cross join (values
  ('store_ops', 'Store Operations', 93),
  ('store_ops_master', 'Store Operations Master', 94)
) as p(code, name, sort_order)
on conflict (company_id, code) do update
set name = excluded.name, sort_order = excluded.sort_order, is_active = true, updated_at = now();

insert into public.role_page_permissions (company_id, role_id, page_id, can_view, can_add, can_edit)
select r.company_id, r.id, p.id, true, true, true
from public.user_roles r
join public.app_pages p
  on p.company_id = r.company_id and p.code = 'store_ops' and p.is_active
where r.is_active
  and (
    r.code in ('OPERATIONS_SM', 'OPERATIONS_SRSM', 'OPERATIONS_STM', 'SM', 'SRSM')
    or upper(regexp_replace(concat_ws(' ', r.code, r.name), '[^A-Za-z0-9]+', ' ', 'g'))
      ~ '(^| )(STORE MANAGER|SENIOR STORE MANAGER|SRSM|STORE INCHARGE|STORE IN CHARGE)( |$)'
  )
on conflict (company_id, role_id, page_id) do update
set can_view = true, can_add = true, can_edit = true, updated_at = now();

insert into public.role_page_permissions (company_id, role_id, page_id, can_view, can_add, can_edit)
select r.company_id, r.id, p.id, true, false, true
from public.user_roles r
join public.app_pages p
  on p.company_id = r.company_id and p.code = 'store_ops' and p.is_active
where r.is_active
  and (
    r.code in (
      'OPERATIONS_CTM', 'OPERATIONS_CM', 'OPERATIONS_CLM', 'OPERATIONS_CLUSTER_HEAD',
      'OPERATIONS_AOM', 'OPERATIONS_RM', 'OPERATIONS_REGIONAL_HEAD',
      'OPERATIONS_NH', 'OPERATIONS_NATIONAL_HEAD',
      'OPERATIONS_PGM', 'OPERATIONS_PROGRAM_HEAD',
      'PROGRAM_HEAD', 'CLUSTER_HEAD', 'REGIONAL_HEAD', 'NATIONAL_HEAD'
    )
    or upper(regexp_replace(concat_ws(' ', r.code, r.name), '[^A-Za-z0-9]+', ' ', 'g'))
      ~ '(^| )(CITY MANAGER|CITY HEAD|CTM|CLUSTER MANAGER|CLUSTER HEAD|AREA OPERATIONS MANAGER|AREA MANAGER|AOM|REGIONAL MANAGER|REGIONAL HEAD|NATIONAL HEAD|PROGRAM MANAGER|PROGRAM HEAD)( |$)'
  )
  and not (
    r.code in ('OPERATIONS_SM', 'OPERATIONS_SRSM', 'OPERATIONS_STM', 'SM', 'SRSM')
    or upper(regexp_replace(concat_ws(' ', r.code, r.name), '[^A-Za-z0-9]+', ' ', 'g'))
      ~ '(^| )(STORE MANAGER|SENIOR STORE MANAGER|SRSM|STORE INCHARGE|STORE IN CHARGE)( |$)'
  )
on conflict (company_id, role_id, page_id) do update
set
  can_view = true,
  can_edit = true,
  can_add = public.role_page_permissions.can_add,
  updated_at = now();

insert into public.role_page_permissions (company_id, role_id, page_id, can_view, can_add, can_edit)
select r.company_id, r.id, p.id, true, true, true
from public.user_roles r
join public.app_pages p
  on p.company_id = r.company_id and p.code = 'store_ops_master' and p.is_active
where r.is_active
  and (
    r.code in (
      'OPERATIONS_CTM', 'OPERATIONS_RM', 'OPERATIONS_REGIONAL_HEAD',
      'OPERATIONS_NH', 'OPERATIONS_NATIONAL_HEAD', 'OPERATIONS_PGM', 'OPERATIONS_PROGRAM_HEAD',
      'PROGRAM_HEAD', 'REGIONAL_HEAD', 'NATIONAL_HEAD'
    )
    or upper(regexp_replace(concat_ws(' ', r.code, r.name), '[^A-Za-z0-9]+', ' ', 'g'))
      ~ '(^| )(CITY MANAGER|CTM|REGIONAL MANAGER|REGIONAL HEAD|NATIONAL HEAD|PROGRAM MANAGER|PROGRAM HEAD)( |$)'
  )
on conflict (company_id, role_id, page_id) do update
set can_view = true, can_add = true, can_edit = true, updated_at = now();

alter table public.ops_store_ops_master enable row level security;
alter table public.ops_store_ops_checklists enable row level security;
alter table public.ops_store_ops_evidence enable row level security;

revoke all on public.ops_store_ops_master, public.ops_store_ops_checklists, public.ops_store_ops_evidence
  from anon, authenticated;
grant all on public.ops_store_ops_master, public.ops_store_ops_checklists, public.ops_store_ops_evidence
  to service_role;

insert into public.ops_store_ops_master (company_id, template, settings)
select
  c.id,
  jsonb_build_object(
    'name', 'Ops Pulse · Store Manager task list',
    'description', 'Seeded placeholder — replaced by app default template on first open.',
    'sections', '[]'::jsonb
  ),
  jsonb_build_object(
    'fillerRoles', '[]'::jsonb,
    'managerRoles', '[]'::jsonb,
    'modelIds', '[]'::jsonb,
    'hyderabadCityMatch', jsonb_build_array('hyderabad', 'hyd'),
    'templateFormat', 0
  )
from public.companies c
on conflict (company_id) do nothing;

commit;
