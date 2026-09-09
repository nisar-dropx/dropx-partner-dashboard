-- Company- and portal-scoped controls. Only authenticated application servers
-- may access these tables; each portal must enforce its own settings permission.
create table if not exists public.portal_notification_controls (
  company_id uuid not null references public.companies(id),
  portal text not null check (portal in ('people','ops','finance','recruit','dashboard')),
  event_key text not null check (event_key ~ '^[a-z][a-z0-9_.]{1,100}$'),
  state text not null default 'enabled' check (state in ('enabled','paused','disabled')),
  paused_until timestamptz,
  subject_template text check (length(subject_template) <= 250),
  body_template text check (length(body_template) <= 10000),
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (company_id, portal, event_key)
);
alter table public.portal_notification_controls enable row level security;
revoke all on public.portal_notification_controls from public, anon, authenticated;
grant select, insert, update on public.portal_notification_controls to service_role;

create table if not exists public.portal_notification_control_audit (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  portal text not null,
  event_key text not null,
  actor_id uuid,
  before_data jsonb,
  after_data jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists portal_notification_control_audit_company_date
  on public.portal_notification_control_audit(company_id, portal, created_at desc);
alter table public.portal_notification_control_audit enable row level security;
revoke all on public.portal_notification_control_audit from public, anon, authenticated;
grant select, insert on public.portal_notification_control_audit to service_role;

create or replace function public.audit_portal_notification_control()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  insert into public.portal_notification_control_audit(company_id,portal,event_key,actor_id,before_data,after_data)
  values(new.company_id,new.portal,new.event_key,new.updated_by,
    case when tg_op='UPDATE' then to_jsonb(old) else null end,to_jsonb(new));
  return new;
end;
$$;
revoke all on function public.audit_portal_notification_control() from public, anon, authenticated;
grant execute on function public.audit_portal_notification_control() to service_role;
drop trigger if exists audit_portal_notification_control on public.portal_notification_controls;
create trigger audit_portal_notification_control after insert or update on public.portal_notification_controls
for each row execute function public.audit_portal_notification_control();

-- New digests stay disabled until recipient/routing review and explicit activation.
insert into public.portal_notification_controls(company_id,portal,event_key,state,subject_template,config)
select id,'people','unplanned_leave_digest','disabled','Unplanned Leave Follow-up | {{month}} {{year}}',
 jsonb_build_object('schedule_time','08:00','timezone','Asia/Kolkata','day_offset',-1,
 'thread_mode','monthly','month_from','report_date','hr_scope','organisation',
 'hr_department_ids',(select coalesce(jsonb_agg(d.id),'[]') from public.hr_departments d where d.company_id=c.id and d.name='Human Resources'),
 'location_role_codes',jsonb_build_array('PC','QC','SM','SSA','SIC','TL','STM'),
 'send_zero_cases',false,'max_email_people',8,'max_summary_rows',6,'delivery_ready',false)
from public.companies c on conflict(company_id,portal,event_key) do nothing;

-- Independent submenu permission. Grants only read access on this new scoped view.
insert into public.app_pages(company_id,code,name,sort_order,is_active)
select id,'ops_unplanned_leaves','Attendance · Unplanned Leaves (read-only)',85,true from public.companies
on conflict(company_id,code) do nothing;
insert into public.role_page_permissions(company_id,role_id,page_id,can_view,can_add,can_edit)
select r.company_id,r.id,p.id,true,false,false from public.user_roles r
join public.app_pages p on p.company_id=r.company_id and p.code='ops_unplanned_leaves'
where r.product_code='operations' and r.is_active
on conflict(role_id,page_id) do nothing;
