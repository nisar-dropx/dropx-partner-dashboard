begin;
-- Payout Disputes in Ops Pulse (Workforce menu), sharing /payments/disputes like Workforce Payouts.
-- A separate Ops grant; roles that already manage Ops Workforce Payouts get the same View/Add/Edit.
insert into public.app_pages (company_id, code, name, sort_order, is_active, created_at, updated_at)
select c.id, 'ops_workforce_payout_disputes', 'Workforce Payout Disputes (Ops)', 90, true, now(), now()
from public.companies c
where not exists (select 1 from public.app_pages p where p.company_id = c.id and p.code = 'ops_workforce_payout_disputes');

insert into public.role_page_permissions (company_id, role_id, page_id, can_view, can_add, can_edit)
select src.company_id, src.role_id, target.id, src.can_view, src.can_add, src.can_edit
from public.role_page_permissions src
join public.app_pages source_page on source_page.id = src.page_id and source_page.code = 'ops_workforce_payouts'
join public.app_pages target on target.company_id = src.company_id and target.code = 'ops_workforce_payout_disputes'
on conflict (company_id, role_id, page_id) do nothing;
commit;
