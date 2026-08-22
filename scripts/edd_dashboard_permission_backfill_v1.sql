-- EDD Dashboard access-page rollout.
--
-- app_pages/ensureAccessPages already auto-provisions the "edd_dashboard"
-- row per company the first time the app runs after this deploy, so no
-- INSERT is needed there. What a brand-new page can't do on its own is give
-- any existing role a grant — this backfills exactly one thing: every role
-- that currently has Cash In Associate access gets the same view/add/edit
-- level on EDD Dashboard, since the two are meant to travel together.
--
-- Safe to re-run: ON CONFLICT keeps the CIA level authoritative each time.
-- Run once per company in Supabase SQL Editor (or drop the company_id
-- filters to cover every company that has both pages provisioned).

insert into role_page_permissions (company_id, role_id, page_id, can_view, can_add, can_edit)
select
  cia.company_id,
  cia.role_id,
  edd_page.id,
  cia.can_view,
  cia.can_add,
  cia.can_edit
from role_page_permissions cia
join app_pages cia_page
  on cia_page.id = cia.page_id
 and cia_page.code = 'cod_cash_in_associate'
join app_pages edd_page
  on edd_page.company_id = cia.company_id
 and edd_page.code = 'edd_dashboard'
where cia.can_view or cia.can_add or cia.can_edit
on conflict (company_id, role_id, page_id) do update set
  can_view = excluded.can_view,
  can_add = excluded.can_add,
  can_edit = excluded.can_edit,
  updated_at = now();
