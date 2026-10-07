-- Authorized OpsPulse daily mapping access, separate from Fleet master editing.
-- Initial grant only. Future role restrictions remain configurable in Users & Access.
insert into public.app_pages(company_id,code,name,sort_order,is_active)
values('43866344-b550-4e8a-9a2d-9d23f3d8a997','fleet_da_mapping','Vehicle DA mapping',48,true)
on conflict(company_id,code) do nothing;
insert into public.role_page_permissions(company_id,role_id,page_id,can_view,can_add,can_edit)
select r.company_id,r.id,p.id,true,true,true
from public.user_roles r join public.app_pages p on p.company_id=r.company_id and p.code='fleet_da_mapping'
where r.company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997' and r.is_active
and (r.product_code='operations' or exists(select 1 from public.company_product_memberships m where m.company_id=r.company_id and m.role_id=r.id and m.product_code='operations' and m.is_active))
on conflict(role_id,page_id) do update set can_view=true,can_add=true,can_edit=true,updated_at=now();
