begin;

create table if not exists public.company_product_owners (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  product_code text not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role_id uuid references public.user_roles(id) on delete restrict,
  is_active boolean not null default true,
  assigned_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint company_product_owners_product_check
    check (product_code in ('operations', 'people', 'workforce', 'recruit', 'finance', 'tech')),
  constraint company_product_owners_unique unique (company_id, product_code, user_id)
);

alter table public.user_roles
  add column if not exists product_code text;

do $$
begin
  alter table public.user_roles
    add constraint user_roles_product_code_check
    check (product_code is null or product_code in ('operations', 'people', 'workforce', 'recruit', 'finance', 'tech')) not valid;
exception
  when duplicate_object then null;
end $$;

create table if not exists public.company_product_memberships (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  product_code text not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role_id uuid references public.user_roles(id) on delete restrict,
  role_code_snapshot text,
  source_system text not null default 'manual',
  source_record_id uuid,
  has_all_location_access boolean not null default false,
  location_scope_ids uuid[] not null default '{}',
  reports_to_user_id uuid references public.profiles(id) on delete set null,
  is_active boolean not null default true,
  assigned_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint company_product_memberships_product_check
    check (product_code in ('operations', 'people', 'workforce', 'recruit', 'finance', 'tech')),
  constraint company_product_memberships_source_check
    check (source_system in ('manual', 'product_owner', 'legacy_dashboard', 'people_hr', 'recruit')),
  constraint company_product_memberships_unique unique (company_id, product_code, user_id)
);

create index if not exists company_product_owners_user_active_idx
  on public.company_product_owners(user_id, company_id, product_code)
  where is_active = true;

create index if not exists company_product_memberships_user_active_idx
  on public.company_product_memberships(user_id, company_id, product_code)
  where is_active = true;

create index if not exists company_product_memberships_role_idx
  on public.company_product_memberships(company_id, product_code, role_id)
  where is_active = true;

alter table public.stations
  add column if not exists cluster_manager_email text,
  add column if not exists ops_manager_email text,
  add column if not exists ops_program_manager_email text;

create table if not exists public.station_responsibility_assignments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  station_id uuid not null references public.stations(id) on delete cascade,
  responsibility_code text not null,
  assignee_user_id uuid references public.profiles(id) on delete set null,
  assignee_email text not null,
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  assigned_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint station_responsibility_code_check check (
    responsibility_code in ('station_manager', 'cluster_manager', 'regional_manager', 'ops_program_manager')
  ),
  constraint station_responsibility_dates_check check (effective_to is null or effective_to >= effective_from)
);

create unique index if not exists station_responsibility_one_active_idx
  on public.station_responsibility_assignments(company_id, station_id, responsibility_code)
  where effective_to is null;

create index if not exists station_responsibility_assignee_idx
  on public.station_responsibility_assignments(company_id, assignee_email, responsibility_code)
  where effective_to is null;

insert into public.station_responsibility_assignments (
  company_id, station_id, responsibility_code, assignee_user_id, assignee_email
)
select
  station.company_id,
  station.id,
  responsibility.responsibility_code,
  profile.id,
  lower(responsibility.assignee_email)
from public.stations station
cross join lateral (
  values
    ('station_manager', nullif(trim(station.station_manager_email), '')),
    ('cluster_manager', nullif(trim(station.cluster_manager_email), '')),
    ('regional_manager', nullif(trim(station.ops_manager_email), '')),
    ('ops_program_manager', nullif(trim(station.ops_program_manager_email), ''))
) responsibility(responsibility_code, assignee_email)
left join public.profiles profile
  on profile.company_id = station.company_id
  and lower(profile.email) = lower(responsibility.assignee_email)
where station.company_id is not null
  and responsibility.assignee_email is not null
  and not exists (
    select 1
    from public.station_responsibility_assignments existing
    where existing.company_id = station.company_id
      and existing.station_id = station.id
      and existing.responsibility_code = responsibility.responsibility_code
      and existing.effective_to is null
  );

update public.user_roles
set product_code = lower(regexp_replace(code, '_OWNER$', ''))
where product_code is null
  and code ~ '^(OPERATIONS|PEOPLE|WORKFORCE|RECRUIT|FINANCE|TECH)_OWNER$';

with configured_owners(product_code, email) as (
  values
    ('operations', 'akhilkso@dropxlogistics.com'),
    ('finance', 'nisar@dropxlogistics.com'),
    ('people', 'suja@dropxlogistics.com'),
    ('recruit', 'suja@dropxlogistics.com'),
    ('tech', 'tech@dropxlogistics.com'),
    ('workforce', 'jamsheer@dropxlogistics.com')
)
insert into public.user_roles (
  company_id, product_code, code, name, location_access_mode, is_active, is_system
)
select distinct
  profile.company_id,
  owner.product_code,
  upper(owner.product_code) || '_OWNER',
  initcap(owner.product_code) || ' Product Owner',
  'all_locations',
  true,
  false
from configured_owners owner
join public.profiles profile on lower(profile.email) = owner.email
where profile.company_id is not null and profile.is_active
  and not exists (
    select 1 from public.user_roles existing
    where existing.company_id = profile.company_id
      and existing.code = upper(owner.product_code) || '_OWNER'
  );

with configured_owners(product_code, email) as (
  values
    ('operations', 'akhilkso@dropxlogistics.com'),
    ('finance', 'nisar@dropxlogistics.com'),
    ('people', 'suja@dropxlogistics.com'),
    ('recruit', 'suja@dropxlogistics.com'),
    ('tech', 'tech@dropxlogistics.com'),
    ('workforce', 'jamsheer@dropxlogistics.com')
)
insert into public.company_product_owners (company_id, product_code, user_id, role_id, is_active)
select profile.company_id, owner.product_code, profile.id, role.id, true
from configured_owners owner
join public.profiles profile on lower(profile.email) = owner.email and profile.is_active
join public.user_roles role on role.company_id = profile.company_id
  and role.code = upper(owner.product_code) || '_OWNER'
where profile.company_id is not null
on conflict (company_id, product_code, user_id) do update set
  role_id = excluded.role_id,
  is_active = true,
  updated_at = now();

with product_pages(product_code, page_codes) as (
  values
    ('operations', array['users','ops_pulse','performance','capacity','capacity_overview','capacity_associates','capacity_delivery','capacity_hiring','ops_reports','ops_attendance_reports','daily_submission','cod','cod_executive_reconciliation','cod_submission','cod_validation','cod_reports','cod_portal_checks','cod_cash_in_associate','edd_dashboard','cps','cps_overview','cps_daily','cps_monthly','cps_cost_breakup','cps_stations','cps_shipments','cps_associates','cps_reports','cps_inputs','cps_unmapped','service_network','service_network_master','master_locations','master_providers','master_models','cod_master','performance_master','capacity_master','imports','fleet','fleet_action_center','fleet_vehicle_view','fleet_date_view','fleet_station_view','fleet_tracking','fleet_fuel_log','fleet_live_gps','fleet_maintenance','fleet_reports']::text[]),
    ('workforce', array['users','delivery_associates','executive_id_onboarding','provider_mapping','workforce_activity','workforce_rate_cards','workforce_earnings','workforce_incentives','workforce_adjustments','workforce_payroll','workforce_communications','workforce_communications_app','workforce_communications_whatsapp','workforce_communications_history','workforce_categories','workforce_whatsapp','designations','vendors','workers']::text[]),
    ('finance', array['users','payments','advance_requests','expense_requests','payment_requests','payment_approvals','payment_process','workforce_payouts','payment_reports','payment_methods','master_payment_banks','master_payment_heads','master_contacts','payment_settings']::text[]),
    ('tech', array['users','company_master','app_settings','ai_connector','amazon_connector','developer_mode','verification_api_reports','event_log_reports']::text[])
)
insert into public.role_page_permissions (company_id, role_id, page_id, can_view, can_add, can_edit)
select role.company_id, role.id, page.id, true, true, true
from public.user_roles role
join product_pages product on product.product_code = role.product_code
join public.app_pages page on page.company_id = role.company_id
  and page.is_active and page.code = any(product.page_codes)
where role.code = upper(role.product_code) || '_OWNER'
on conflict (company_id, role_id, page_id) do update set
  can_view = true,
  can_add = true,
  can_edit = true,
  updated_at = now();

with product_pages(product_code, page_codes) as (
  values
    ('operations', array[
      'ops_pulse','performance','capacity','capacity_overview','capacity_associates',
      'capacity_delivery','capacity_hiring','ops_reports','ops_attendance_reports',
      'daily_submission','cod','cod_executive_reconciliation','cod_submission','cod_validation',
      'cod_reports','cod_portal_checks','cod_cash_in_associate','edd_dashboard','cps','cps_overview',
      'cps_daily','cps_monthly','cps_cost_breakup','cps_stations','cps_shipments','cps_associates',
      'cps_reports','cps_inputs','cps_unmapped','service_network','service_network_master',
      'master_locations','master_providers','master_models','cod_master','performance_master',
      'capacity_master','imports','fleet','fleet_action_center','fleet_vehicle_view','fleet_date_view',
      'fleet_station_view','fleet_tracking','fleet_fuel_log','fleet_live_gps','fleet_maintenance','fleet_reports'
    ]::text[]),
    ('workforce', array[
      'delivery_associates','executive_id_onboarding','provider_mapping','workforce_activity',
      'workforce_rate_cards','workforce_earnings','workforce_incentives','workforce_adjustments',
      'workforce_payroll','workforce_communications','workforce_communications_app',
      'workforce_communications_whatsapp','workforce_communications_history','workforce_categories',
      'workforce_whatsapp','designations','vendors','workers'
    ]::text[]),
    ('finance', array[
      'payments','advance_requests','expense_requests','payment_requests','payment_approvals',
      'payment_process','workforce_payouts','payment_reports','payment_methods','master_payment_banks',
      'master_payment_heads','master_contacts','payment_settings'
    ]::text[]),
    ('tech', array[
      'company_master','app_settings','ai_connector','amazon_connector','developer_mode',
      'verification_api_reports','event_log_reports'
    ]::text[])
), legacy_memberships as (
  select distinct
    p.company_id,
    pp.product_code,
    p.id as user_id,
    p.role_id,
    r.code as role_code_snapshot,
    coalesce(r.location_access_mode = 'all_locations', false) as has_all_location_access,
    coalesce(p.location_scope_ids, '{}'::uuid[]) as location_scope_ids,
    p.reports_to_user_id
  from public.profiles p
  join public.user_roles r on r.id = p.role_id and r.is_active
  join public.role_page_permissions permission on permission.role_id = r.id
    and (permission.can_view or permission.can_add or permission.can_edit)
  join public.app_pages page on page.id = permission.page_id and page.is_active
  join product_pages pp on page.code = any(pp.page_codes)
  where p.is_active and p.company_id is not null and upper(r.code) <> 'OWNER'
)
insert into public.company_product_memberships (
  company_id, product_code, user_id, role_id, role_code_snapshot, source_system,
  source_record_id, has_all_location_access, location_scope_ids, reports_to_user_id, is_active
)
select
  company_id, product_code, user_id, role_id, role_code_snapshot, 'legacy_dashboard',
  user_id, has_all_location_access, location_scope_ids, reports_to_user_id, true
from legacy_memberships
on conflict (company_id, product_code, user_id) do update set
  role_id = excluded.role_id,
  role_code_snapshot = excluded.role_code_snapshot,
  has_all_location_access = excluded.has_all_location_access,
  location_scope_ids = excluded.location_scope_ids,
  reports_to_user_id = excluded.reports_to_user_id,
  updated_at = now()
where public.company_product_memberships.source_system = 'legacy_dashboard';

with legacy_product_roles as (
  select distinct membership.company_id, membership.product_code, source_role.id as source_role_id,
    source_role.code as source_role_code, source_role.name as source_role_name,
    source_role.location_access_mode
  from public.company_product_memberships membership
  join public.user_roles source_role on source_role.id = membership.role_id
  where membership.source_system = 'legacy_dashboard'
)
insert into public.user_roles (
  company_id, product_code, code, name, location_access_mode, is_active, is_system
)
select
  legacy.company_id,
  legacy.product_code,
  upper(legacy.product_code) || '_' || legacy.source_role_code,
  initcap(legacy.product_code) || ' · ' || legacy.source_role_name,
  legacy.location_access_mode,
  true,
  false
from legacy_product_roles legacy
where not exists (
  select 1 from public.user_roles existing
  where existing.company_id = legacy.company_id
    and existing.code = upper(legacy.product_code) || '_' || legacy.source_role_code
);

with product_pages(product_code, page_codes) as (
  values
    ('operations', array['ops_pulse','performance','capacity','capacity_overview','capacity_associates','capacity_delivery','capacity_hiring','ops_reports','ops_attendance_reports','daily_submission','cod','cod_executive_reconciliation','cod_submission','cod_validation','cod_reports','cod_portal_checks','cod_cash_in_associate','edd_dashboard','cps','cps_overview','cps_daily','cps_monthly','cps_cost_breakup','cps_stations','cps_shipments','cps_associates','cps_reports','cps_inputs','cps_unmapped','service_network','service_network_master','master_locations','master_providers','master_models','cod_master','performance_master','capacity_master','imports','fleet','fleet_action_center','fleet_vehicle_view','fleet_date_view','fleet_station_view','fleet_tracking','fleet_fuel_log','fleet_live_gps','fleet_maintenance','fleet_reports']::text[]),
    ('workforce', array['delivery_associates','executive_id_onboarding','provider_mapping','workforce_activity','workforce_rate_cards','workforce_earnings','workforce_incentives','workforce_adjustments','workforce_payroll','workforce_communications','workforce_communications_app','workforce_communications_whatsapp','workforce_communications_history','workforce_categories','workforce_whatsapp','designations','vendors','workers']::text[]),
    ('finance', array['payments','advance_requests','expense_requests','payment_requests','payment_approvals','payment_process','workforce_payouts','payment_reports','payment_methods','master_payment_banks','master_payment_heads','master_contacts','payment_settings']::text[]),
    ('tech', array['company_master','app_settings','ai_connector','amazon_connector','developer_mode','verification_api_reports','event_log_reports']::text[])
), cloned_grants as (
  select distinct
    membership.company_id,
    membership.product_code,
    clone.id as role_id,
    permission.page_id,
    permission.can_view,
    permission.can_add,
    permission.can_edit
  from public.company_product_memberships membership
  join public.user_roles source_role on source_role.id = membership.role_id
  join public.user_roles clone on clone.company_id = membership.company_id
    and clone.code = upper(membership.product_code) || '_' || source_role.code
  join public.role_page_permissions permission on permission.role_id = source_role.id
  join public.app_pages page on page.id = permission.page_id
  join product_pages product on product.product_code = membership.product_code
    and (page.code = any(product.page_codes) or page.code = 'users')
  where membership.source_system = 'legacy_dashboard'
)
insert into public.role_page_permissions (
  company_id, role_id, page_id, can_view, can_add, can_edit
)
select company_id, role_id, page_id, can_view, can_add, can_edit
from cloned_grants
on conflict (company_id, role_id, page_id) do update set
  can_view = excluded.can_view,
  can_add = excluded.can_add,
  can_edit = excluded.can_edit,
  updated_at = now();

update public.company_product_memberships membership
set
  role_id = clone.id,
  role_code_snapshot = clone.code,
  updated_at = now()
from public.user_roles source_role, public.user_roles clone
where membership.source_system = 'legacy_dashboard'
  and source_role.id = membership.role_id
  and clone.company_id = membership.company_id
  and clone.code = upper(membership.product_code) || '_' || source_role.code;

insert into public.company_product_memberships (
  company_id, product_code, user_id, role_code_snapshot, source_system, source_record_id,
  has_all_location_access, location_scope_ids, is_active
)
select distinct on (access.company_id, access.user_id)
  access.company_id,
  'people',
  access.user_id,
  coalesce(role.code, access.role_code),
  'people_hr',
  access.id,
  access.all_locations,
  coalesce(access.location_ids, '{}'::uuid[]),
  true
from public.hr_user_access access
left join public.hr_roles role on role.id = access.role_id
join public.profiles profile on profile.id = access.user_id and profile.is_active
where access.is_active
order by access.company_id, access.user_id, access.updated_at desc nulls last, access.created_at desc
on conflict (company_id, product_code, user_id) do update set
  role_code_snapshot = excluded.role_code_snapshot,
  source_record_id = excluded.source_record_id,
  has_all_location_access = excluded.has_all_location_access,
  location_scope_ids = excluded.location_scope_ids,
  updated_at = now()
where public.company_product_memberships.source_system = 'people_hr';

insert into public.company_product_memberships (
  company_id, product_code, user_id, role_code_snapshot, source_system, source_record_id,
  has_all_location_access, location_scope_ids, is_active
)
select
  access.company_id,
  'recruit',
  access.profile_id,
  case when access.can_manage_users or access.can_manage_masters then 'RECRUIT_ADMIN' else 'RECRUIT_USER' end,
  'recruit',
  access.id,
  access.can_access_all_locations,
  coalesce((select array_agg(location_id) from public.recruitment_user_locations where user_access_id = access.id), '{}'::uuid[]),
  true
from public.recruitment_user_access access
join public.profiles profile on profile.id = access.profile_id and profile.is_active
where access.is_active
on conflict (company_id, product_code, user_id) do update set
  role_code_snapshot = excluded.role_code_snapshot,
  source_record_id = excluded.source_record_id,
  has_all_location_access = excluded.has_all_location_access,
  location_scope_ids = excluded.location_scope_ids,
  updated_at = now()
where public.company_product_memberships.source_system = 'recruit';

insert into public.company_product_memberships (
  company_id, product_code, user_id, role_id, role_code_snapshot, source_system,
  source_record_id, has_all_location_access, location_scope_ids, is_active, assigned_by
)
select
  owner.company_id,
  owner.product_code,
  owner.user_id,
  owner.role_id,
  role.code,
  'product_owner',
  owner.id,
  coalesce(role.location_access_mode = 'all_locations', true),
  '{}'::uuid[],
  owner.is_active,
  owner.assigned_by
from public.company_product_owners owner
left join public.user_roles role on role.id = owner.role_id
on conflict (company_id, product_code, user_id) do update set
  role_id = excluded.role_id,
  role_code_snapshot = excluded.role_code_snapshot,
  source_system = 'product_owner',
  source_record_id = excluded.source_record_id,
  has_all_location_access = excluded.has_all_location_access,
  is_active = excluded.is_active,
  assigned_by = excluded.assigned_by,
  updated_at = now();

create or replace view public.product_access_migration_reconciliation as
with expected as (
  select company_id, product_code, user_id
  from public.company_product_memberships
  where source_system in ('legacy_dashboard', 'people_hr', 'recruit', 'product_owner')
), migrated as (
  select company_id, product_code, user_id
  from public.company_product_memberships
  where is_active
)
select
  expected.company_id,
  expected.product_code,
  count(distinct expected.user_id) as expected_users,
  count(distinct migrated.user_id) as active_memberships,
  count(distinct expected.user_id) filter (where migrated.user_id is null) as missing_users
from expected
left join migrated using (company_id, product_code, user_id)
group by expected.company_id, expected.product_code;

alter table public.company_product_owners enable row level security;
alter table public.company_product_memberships enable row level security;
alter table public.station_responsibility_assignments enable row level security;

revoke all on table public.company_product_owners from anon, authenticated;
revoke all on table public.company_product_memberships from anon, authenticated;
revoke all on table public.station_responsibility_assignments from anon, authenticated;
revoke all on table public.product_access_migration_reconciliation from anon, authenticated;
grant select, insert, update, delete on table public.company_product_owners to service_role;
grant select, insert, update, delete on table public.company_product_memberships to service_role;
grant select, insert, update, delete on table public.station_responsibility_assignments to service_role;
grant select on table public.product_access_migration_reconciliation to service_role;

comment on table public.company_product_owners is
  'Central Super Admin assignments. Product owners administer only their own portal; Super Admin remains cross-product.';
comment on table public.company_product_memberships is
  'Additive product access assignments. Legacy access remains readable during cutover and is never deleted by this migration.';
comment on column public.company_product_memberships.role_id is
  'Portal-specific central role for Operations, Workforce, Finance or Tech. People and Recruit retain their native access tables.';
comment on table public.station_responsibility_assignments is
  'Effective-dated operational ownership history. Replacements close the previous assignment instead of rewriting history.';
comment on view public.product_access_migration_reconciliation is
  'Non-destructive parity counts used before legacy Dashboard access administration is retired.';

notify pgrst, 'reload schema';

commit;
