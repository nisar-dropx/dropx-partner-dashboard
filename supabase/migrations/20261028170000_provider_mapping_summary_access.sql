begin;

-- Mapping Summary is deliberately a separate permission. Existing ID Mapping
-- grants are not copied; administrators can grant this read-only oversight
-- view independently in Users & Access.
insert into public.app_pages (company_id, code, name, sort_order, is_active, created_at, updated_at)
select company.id, page.code, page.name, page.sort_order, true, now(), now()
from public.companies company
cross join (values
  ('provider_mapping_summary', 'ID Mapping Summary', 41),
  ('ops_provider_mapping_summary', 'ID Mapping Summary', 89)
) as page(code, name, sort_order)
on conflict (company_id, code) do update
set name = excluded.name,
    sort_order = excluded.sort_order,
    is_active = true,
    updated_at = now();

-- Company owners retain platform administration; every other role starts
-- without access even if it already has ID Mapping permission.
insert into public.role_page_permissions (company_id, role_id, page_id, can_view, can_add, can_edit, created_at, updated_at)
select role.company_id, role.id, page.id, true, false, false, now(), now()
from public.user_roles role
join public.app_pages page on page.company_id = role.company_id
  and page.code in ('provider_mapping_summary', 'ops_provider_mapping_summary')
where role.code = 'OWNER' and role.is_active
on conflict (company_id, role_id, page_id) do update
set can_view = true,
    can_add = false,
    can_edit = false,
    updated_at = now();

commit;
