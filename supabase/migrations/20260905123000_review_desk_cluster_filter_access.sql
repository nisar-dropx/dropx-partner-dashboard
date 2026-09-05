-- Review Desk cluster filter: catalog page defaults OFF for every role.
-- Explicit View grant only for Program Manager / Program Head and Tech roles.
-- Owner already bypasses page permissions in application code.
insert into public.app_pages (company_id, code, name, sort_order, is_active, created_at, updated_at)
select c.id, 'performance_review_cluster_filter', 'Review Desk Cluster Filter', 84, true, now(), now()
from public.companies c
on conflict (company_id, code) do update
  set name = excluded.name,
      sort_order = excluded.sort_order,
      is_active = true,
      updated_at = now();

insert into public.role_page_permissions (company_id, role_id, page_id, can_view, can_add, can_edit, created_at, updated_at)
select r.company_id, r.id, p.id, true, false, false, now(), now()
from public.user_roles r
join public.app_pages p
  on p.company_id = r.company_id
 and p.code = 'performance_review_cluster_filter'
 and p.is_active
where r.is_active
  and upper(r.code) in (
    'PROGRAM_HEAD',
    'OPERATIONS_PROGRAM_HEAD',
    'OPERATIONS_PGM',
    'WORKFORCE_PGM',
    'TECH_PROGRAM_HEAD',
    'TECH',
    'OPERATIONS_TECH',
    'TECH_TECH',
    'WORKFORCE_TECH',
    'FINANCE_TECH'
  )
on conflict (company_id, role_id, page_id) do update
  set can_view = true,
      can_add = false,
      can_edit = false,
      updated_at = now();
