-- Mirror: grant attendance_integrity.view to roles that already have attendance.view
-- so People Attendance sub-tabs always render.

insert into public.hr_permission_pages (
  company_id, code, name, href, section, sort_order,
  supports_view, supports_add, supports_edit, supports_approve, supports_export, is_active
)
select
  company.id,
  'attendance_integrity',
  'Attendance Integrity',
  '/attendance/integrity',
  'People operations',
  42,
  true, false, true, true, false, true
from public.companies company
on conflict (company_id, code) do update
set
  name = excluded.name,
  href = excluded.href,
  is_active = true;

insert into public.hr_role_page_permissions (
  company_id, role_id, page_id, can_view, can_add, can_edit, can_approve, can_export
)
select
  attendance_perm.company_id,
  attendance_perm.role_id,
  integrity_page.id,
  true,
  false,
  coalesce(existing.can_edit, false),
  coalesce(existing.can_approve, false),
  false
from public.hr_role_page_permissions attendance_perm
join public.hr_permission_pages attendance_page
  on attendance_page.id = attendance_perm.page_id
 and attendance_page.code = 'attendance'
join public.hr_permission_pages integrity_page
  on integrity_page.company_id = attendance_perm.company_id
 and integrity_page.code = 'attendance_integrity'
left join public.hr_role_page_permissions existing
  on existing.company_id = attendance_perm.company_id
 and existing.role_id = attendance_perm.role_id
 and existing.page_id = integrity_page.id
where attendance_perm.can_view = true
on conflict (company_id, role_id, page_id) do update
set
  can_view = true,
  updated_at = now();
