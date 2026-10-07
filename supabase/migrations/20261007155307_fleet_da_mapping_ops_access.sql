-- Authorized OpsPulse daily mapping access, separate from Fleet master editing.
-- Initial grant only. Future role restrictions remain configurable in Users & Access.
insert into public.app_pages(company_id,code,name,sort_order,is_active)
select id,'fleet_da_mapping','Vehicle DA mapping',48,true from public.companies where code='DROPX_LOGISTICS'
on conflict(company_id,code) do nothing;
insert into public.role_page_permissions(company_id,role_id,page_id,can_view,can_add,can_edit)
select r.company_id,r.id,p.id,true,true,true
from public.user_roles r join public.app_pages p on p.company_id=r.company_id and p.code='fleet_da_mapping'
where r.company_id in(select id from public.companies where code='DROPX_LOGISTICS') and r.is_active
and (r.product_code='operations' or exists(select 1 from public.company_product_memberships m where m.company_id=r.company_id and m.role_id=r.id and m.product_code='operations' and m.is_active))
on conflict(company_id,role_id,page_id) do update set can_view=true,can_add=true,can_edit=true,updated_at=now();
