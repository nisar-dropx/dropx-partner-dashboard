begin;

-- One WhatsApp session, two independent configuration workspaces. Existing rows stay Dark Store.
alter table public.report_bot_groups
  add column if not exists workspace text not null default 'dark_store'
    check (workspace in ('dark_store', 'last_mile'));
alter table public.report_bot_report_types
  add column if not exists workspace text not null default 'dark_store'
    check (workspace in ('dark_store', 'last_mile'));
create index if not exists report_bot_groups_workspace_idx on public.report_bot_groups(company_id, workspace, is_enabled);
create index if not exists report_bot_types_workspace_idx on public.report_bot_report_types(company_id, workspace, is_active);
drop index if exists public.report_bot_report_types_company_slug_uidx;
create unique index if not exists report_bot_report_types_workspace_slug_uidx
  on public.report_bot_report_types(company_id, workspace, slug) where slug is not null;

-- A WhatsApp group belongs to exactly one workspace; history cannot be silently moved.
-- This also closes concurrent cross-workspace group-selection races.
create or replace function public.report_bot_keep_workspace()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.workspace is distinct from old.workspace or new.company_id is distinct from old.company_id then
    raise exception 'Report workspace ownership cannot be changed';
  end if;
  return new;
end;
$$;
drop trigger if exists report_bot_group_keep_workspace on public.report_bot_groups;
create trigger report_bot_group_keep_workspace before update of workspace, company_id on public.report_bot_groups
  for each row execute function public.report_bot_keep_workspace();
drop trigger if exists report_bot_type_keep_workspace on public.report_bot_report_types;
create trigger report_bot_type_keep_workspace before update of workspace, company_id on public.report_bot_report_types
  for each row execute function public.report_bot_keep_workspace();

create or replace function public.report_bot_check_schedule_workspace()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if not exists (
    select 1 from public.report_bot_groups g
    join public.report_bot_report_types r on r.id = new.report_type_id
      and r.company_id = g.company_id and r.workspace = g.workspace
    where g.id = new.group_id and g.company_id = new.company_id
  ) then
    raise exception 'Schedule group and report must belong to the same company and workspace';
  end if;
  return new;
end;
$$;
drop trigger if exists report_bot_schedule_workspace on public.report_bot_schedules;
create trigger report_bot_schedule_workspace before insert or update of company_id,group_id,report_type_id
  on public.report_bot_schedules for each row execute function public.report_bot_check_schedule_workspace();
revoke all on function public.report_bot_keep_workspace() from public, anon, authenticated;
revoke all on function public.report_bot_check_schedule_workspace() from public, anon, authenticated;
grant execute on function public.report_bot_keep_workspace() to service_role;
grant execute on function public.report_bot_check_schedule_workspace() to service_role;

-- Seed once, then the normal Designation Access editor is authoritative.
insert into public.app_pages(company_id,code,name,sort_order,is_active)
values ('43866344-b550-4e8a-9a2d-9d23f3d8a997','ops_lm_report_bot','Last Mile Report Bot (WhatsApp)',85,true)
on conflict (company_id,code) do nothing;
insert into public.role_page_permissions(company_id,role_id,page_id,can_view,can_add,can_edit)
select p.company_id,r.id,p.id,true,true,true
from public.app_pages p
join public.user_roles r on r.company_id=p.company_id
where p.company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997' and p.code='ops_lm_report_bot'
  and r.code in ('OPERATIONS_FSD','OPERATIONS_FINMGR','OPERATIONS_NH','OPERATIONS_MANAGING_PARTNER','OPERATIONS_HLM')
on conflict (company_id,role_id,page_id) do nothing;

-- Existing service-role-only RLS and table grants remain unchanged.
notify pgrst, 'reload schema';
commit;
