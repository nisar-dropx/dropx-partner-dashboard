-- OpsPulse owns one operational onboarding surface: the canonical Workforce
-- register. Preserve the effective access that Operations roles previously got
-- through the generic contractor/helper/vendor group, then remove those three
-- unrelated page grants from Operations roles.

insert into public.role_page_permissions (
  company_id,
  role_id,
  page_id,
  can_view,
  can_add,
  can_edit,
  created_at,
  updated_at
)
select
  role.company_id,
  role.id,
  workforce_page.id,
  bool_or(legacy_permission.can_view or legacy_permission.can_add or legacy_permission.can_edit),
  bool_or(legacy_permission.can_add),
  bool_or(legacy_permission.can_edit),
  now(),
  now()
from public.user_roles role
join public.role_page_permissions legacy_permission
  on legacy_permission.company_id = role.company_id
 and legacy_permission.role_id = role.id
join public.app_pages legacy_page
  on legacy_page.company_id = legacy_permission.company_id
 and legacy_page.id = legacy_permission.page_id
 and legacy_page.code in ('contractors', 'workers', 'vendors')
join public.app_pages workforce_page
  on workforce_page.company_id = role.company_id
 and workforce_page.code = 'delivery_associates'
where role.product_code = 'operations'
group by role.company_id, role.id, workforce_page.id
on conflict (company_id, role_id, page_id) do update set
  can_view = public.role_page_permissions.can_view or excluded.can_view,
  can_add = public.role_page_permissions.can_add or excluded.can_add,
  can_edit = public.role_page_permissions.can_edit or excluded.can_edit,
  updated_at = now();

delete from public.role_page_permissions permission
using public.user_roles role, public.app_pages page
where permission.company_id = role.company_id
  and permission.role_id = role.id
  and permission.company_id = page.company_id
  and permission.page_id = page.id
  and role.product_code = 'operations'
  and page.code in ('contractors', 'workers', 'vendors');
