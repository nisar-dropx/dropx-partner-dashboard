-- Apply after deploying the protected Review Desk actions. Edit for station roles
-- means connection timings only; manager RCA/stage checks are enforced server-side.
-- Portal membership and location scope are deliberately unchanged.
insert into public.role_page_permissions(company_id,role_id,page_id,can_view,can_add,can_edit,created_at,updated_at)
select r.company_id,r.id,p.id,true,
  r.code in ('PROGRAM_HEAD','OPERATIONS_PROGRAM_HEAD','OPERATIONS_PGM'),true,now(),now()
from public.user_roles r
join public.app_pages p on p.company_id=r.company_id and p.code='performance_review' and p.is_active
where r.is_active and r.code in ('LOCATION','OPERATIONS_LOCATION','OPERATIONS_TL','OPERATIONS_ATL','PROGRAM_HEAD','OPERATIONS_PROGRAM_HEAD','OPERATIONS_PGM')
on conflict(company_id,role_id,page_id) do update set can_view=true,can_add=excluded.can_add,can_edit=true,updated_at=now();
