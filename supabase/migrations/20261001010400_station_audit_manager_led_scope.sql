-- Audit scheduling and response scope are company configuration, not code.
create table if not exists public.ops_audit_programme_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  scheduler_role_ids uuid[] not null default '{}',
  responder_role_ids uuid[] not null default '{}',
  excluded_location_model_ids uuid[] not null default '{}',
  excluded_location_ids uuid[] not null default '{}',
  exclude_head_office boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid null
);

create trigger ops_audit_programme_settings_updated_at
before update on public.ops_audit_programme_settings
for each row execute function public.ops_audit_touch_updated_at();

alter table public.ops_audit_programme_settings enable row level security;

-- Start with the current operating policy. Every value remains editable in
-- Ops Masters > Audit, including roles and excluded station models.
insert into public.ops_audit_programme_settings (
  company_id,
  scheduler_role_ids,
  responder_role_ids,
  excluded_location_model_ids,
  exclude_head_office
)
select
  c.id,
  coalesce((
    select array_agg(r.id order by r.name)
    from public.user_roles r
    where r.company_id = c.id
      and r.is_active
      and r.code in (
        'OPERATIONS_CLM', 'OPERATIONS_CLUSTER_HEAD', 'OPERATIONS_AOM',
        'OPERATIONS_CM', 'OPERATIONS_RM', 'OPERATIONS_REGIONAL_HEAD',
        'OPERATIONS_ZONAL_HEAD', 'OPERATIONS_PGM', 'OPERATIONS_PROGRAM_HEAD',
        'OPERATIONS_NH', 'OPERATIONS_NATIONAL_HEAD', 'OPERATIONS_HLM',
        'OPERATIONS_MANAGING_PARTNER'
      )
  ), '{}'::uuid[]),
  coalesce((
    select array_agg(r.id order by r.name)
    from public.user_roles r
    where r.company_id = c.id
      and r.is_active
      and r.code in ('LOCATION', 'OPERATIONS_LOCATION', 'OPERATIONS_STM', 'OPERATIONS_SM')
  ), '{}'::uuid[]),
  coalesce((
    select array_agg(m.id order by m.name)
    from public.location_models m
    where m.company_id = c.id and m.is_active and m.code = 'NOW'
  ), '{}'::uuid[]),
  true
from public.companies c
where c.id = '43866344-b550-4e8a-9a2d-9d23f3d8a997'
on conflict (company_id) do update set
  scheduler_role_ids = excluded.scheduler_role_ids,
  responder_role_ids = excluded.responder_role_ids,
  excluded_location_model_ids = excluded.excluded_location_model_ids,
  exclude_head_office = excluded.exclude_head_office,
  updated_at = now();

-- These were system-generated placeholder slots. Manual or started audit work
-- is retained; managers schedule the operating queue from this point onward.
delete from public.ops_station_audits
where company_id = '43866344-b550-4e8a-9a2d-9d23f3d8a997'
  and schedule_source = 'programme'
  and status_code = 'scheduled';
