-- OpsPulse uses the canonical People roster tables. This script only adds the
-- independent OpsPulse menu permission and operational role defaults.
insert into public.app_pages (company_id, code, name, sort_order, is_active, created_at, updated_at)
select company.id, 'ops_rostering', 'Rostering', 85, true, now(), now()
from public.companies company
where company.id = '43866344-b550-4e8a-9a2d-9d23f3d8a997'
on conflict (company_id, code) do update
set name = excluded.name,
    sort_order = excluded.sort_order,
    is_active = true,
    updated_at = now();

insert into public.role_page_permissions (company_id, role_id, page_id, can_view, can_add, can_edit, created_at, updated_at)
select role.company_id, role.id, page.id, true, true, true, now(), now()
from public.user_roles role
join public.app_pages page
  on page.company_id = role.company_id
 and page.code = 'ops_rostering'
where role.company_id = '43866344-b550-4e8a-9a2d-9d23f3d8a997'
  and role.code in (
    'TEAM_LEADER',
    'STATION_MANAGER',
    'CLUSTER_HEAD',
    'REGIONAL_HEAD',
    'NATIONAL_HEAD',
    'OPERATIONS_TL',
    'OPERATIONS_STM',
    'OPERATIONS_CLM',
    'OPERATIONS_AOM',
    'OPERATIONS_RM',
    'OPERATIONS_NH',
    'OPERATIONS_MANAGING_PARTNER',
    'OPERATIONS_CLUSTER_HEAD',
    'OPERATIONS_REGIONAL_HEAD',
    'OPERATIONS_NATIONAL_HEAD'
  )
on conflict (company_id, role_id, page_id) do update
set can_view = true,
    can_add = true,
    can_edit = true,
    updated_at = now();
