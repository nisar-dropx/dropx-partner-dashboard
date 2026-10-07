-- Team Ops · My Team & Org: a read-only reporting map. The page narrows itself
-- to the signed-in user's own reporting line, team and locations, so every
-- active Operations role gets view access and nothing more.
begin;

insert into public.app_pages(company_id, code, name, sort_order, is_active)
select id, 'ops_my_team', 'Team Ops · My Team & Org', 85, true from public.companies
on conflict (company_id, code) do nothing;

insert into public.role_page_permissions(company_id, role_id, page_id, can_view, can_add, can_edit)
select r.company_id, r.id, p.id, true, false, false from public.user_roles r
join public.app_pages p on p.company_id = r.company_id and p.code = 'ops_my_team'
where r.product_code = 'operations' and r.is_active
on conflict (company_id, role_id, page_id) do nothing;

commit;
