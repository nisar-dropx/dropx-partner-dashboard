begin;
create table public.report_bot_lm_dispatch_routes (
 id uuid primary key default gen_random_uuid(), company_id uuid not null, group_id uuid not null references public.report_bot_groups(id) on delete cascade,
 location_id uuid not null references public.stations(id), report text not null check(report in ('edd','station','dsr','creturn','ageing','zero','scrub','cod','recon','deposit','bank','slip')),
 times text[] not null check(cardinality(times) between 1 and 24), format text not null check(format in ('text','table','photo')), pending_only boolean not null,
 mentions text[] not null default '{}', question text not null default '', enabled boolean not null default true, updated_at timestamptz not null default now(), unique(group_id,report)
);
create index on public.report_bot_lm_dispatch_routes(company_id) where enabled;
create table public.report_bot_lm_dispatch_runs (
 id uuid primary key default gen_random_uuid(), route_id uuid not null references public.report_bot_lm_dispatch_routes(id) on delete cascade,
 day date not null, slot text not null, status text not null default 'processing', detail text, created_at timestamptz not null default now(), unique(route_id,day,slot)
);
alter table public.report_bot_lm_dispatch_routes enable row level security;
alter table public.report_bot_lm_dispatch_runs enable row level security;
revoke all on public.report_bot_lm_dispatch_routes,public.report_bot_lm_dispatch_runs from public, anon, authenticated;
grant select,insert,update,delete on public.report_bot_lm_dispatch_routes,public.report_bot_lm_dispatch_runs to service_role;
insert into public.role_page_permissions(company_id,role_id,page_id,can_view,can_add,can_edit)
select p.company_id,r.id,p.id,true,true,true from public.app_pages p join public.user_roles r on r.company_id=p.company_id
where p.code='ops_lm_report_bot' and p.company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997' and r.code in ('OPERATIONS_FSD','OPERATIONS_MANAGING_PARTNER','OPERATIONS_CT','OPERATIONS_NH','OPERATIONS_HLM')
on conflict(company_id,role_id,page_id) do update set can_view=true,can_add=true,can_edit=true;
update public.role_page_permissions a set can_view=false,can_add=false,can_edit=false
from public.app_pages p,public.user_roles r where p.id=a.page_id and r.id=a.role_id and p.company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997' and p.code='ops_lm_report_bot'
and r.code not in ('OPERATIONS_FSD','OPERATIONS_MANAGING_PARTNER','OPERATIONS_CT','OPERATIONS_NH','OPERATIONS_HLM');
notify pgrst,'reload schema';
commit;
