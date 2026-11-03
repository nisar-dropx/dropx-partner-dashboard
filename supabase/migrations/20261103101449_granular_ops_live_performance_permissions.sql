begin;

-- Split the former shared Live performance / Scrub grant into independent
-- in-page section grants. Existing roles keep exactly the access they had.
with section_pages(code, name, sort_order) as (
  values
    ('edd_live_ops', 'Live performance · Ops Live', 95),
    ('edd_station_board', 'Live performance · Station board', 95),
    ('edd_ageing', 'Live performance · Ageing', 95),
    ('edd_performance', 'Live performance · Performance', 95),
    ('edd_edds', 'Live performance · EDDs', 95),
    ('edd_scorecard', 'Live performance · Scorecard', 95),
    ('edd_scrub', 'Operations · Scrub', 95)
)
insert into public.app_pages (company_id, code, name, sort_order, is_active, created_at, updated_at)
select companies.id, section_pages.code, section_pages.name, section_pages.sort_order, true, now(), now()
from public.companies
cross join section_pages
on conflict (company_id, code) do update set
  name = excluded.name,
  sort_order = excluded.sort_order,
  is_active = true,
  updated_at = now();

insert into public.role_page_permissions (
  company_id, role_id, page_id, can_view, can_add, can_edit, created_at, updated_at
)
select
  source.company_id,
  source.role_id,
  target.id,
  source.can_view or source.can_add or source.can_edit,
  source.can_add,
  source.can_edit,
  now(),
  now()
from public.role_page_permissions source
join public.app_pages legacy
  on legacy.id = source.page_id
 and legacy.company_id = source.company_id
 and legacy.code = 'edd_dashboard'
join public.app_pages target
  on target.company_id = source.company_id
 and target.code in ('edd_live_ops', 'edd_station_board', 'edd_ageing', 'edd_performance', 'edd_edds', 'edd_scorecard', 'edd_scrub')
on conflict (company_id, role_id, page_id) do nothing;

-- OWNER is always full-access even if an older tenant did not have the legacy row.
insert into public.role_page_permissions (
  company_id, role_id, page_id, can_view, can_add, can_edit, created_at, updated_at
)
select roles.company_id, roles.id, pages.id, true, true, true, now(), now()
from public.user_roles roles
join public.app_pages pages
  on pages.company_id = roles.company_id
 and pages.code in ('edd_live_ops', 'edd_station_board', 'edd_ageing', 'edd_performance', 'edd_edds', 'edd_scorecard', 'edd_scrub')
where upper(roles.code) = 'OWNER'
on conflict (company_id, role_id, page_id) do update set
  can_view = true,
  can_add = true,
  can_edit = true,
  updated_at = now();

update public.app_pages
set name = 'Live performance (legacy shared access)', updated_at = now()
where code = 'edd_dashboard';

commit;
