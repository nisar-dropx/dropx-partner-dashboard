-- Fleet availability lifecycle and the daily station status report.

alter table public.fleet_vehicles
  add column if not exists non_operational_since date,
  add column if not exists expected_operational_date date,
  add column if not exists status_comment text,
  add column if not exists status_updated_at timestamptz,
  add column if not exists status_updated_by uuid references public.profiles(id);

update public.fleet_vehicles
set ownership_type = case
  when upper(coalesce(ownership_type, '')) in ('ODCD', 'DCD') then 'odcd'
  when upper(coalesce(ownership_type, '')) in ('RENTED', 'RENT', 'LEASED') then 'rented'
  else 'own'
end;

alter table public.fleet_vehicles alter column ownership_type set default 'own';

alter table public.fleet_control_settings
  add column if not exists daily_status_email_enabled boolean not null default false,
  add column if not exists daily_status_send_time time not null default '20:30:00',
  add column if not exists daily_status_only_affected boolean not null default true;

create table if not exists public.fleet_status_report_recipients (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  profile_id uuid references public.profiles(id) on delete set null,
  name text,
  email text not null,
  station_codes text[] not null default '{}'::text[],
  source text not null default 'manual' check (source in ('people', 'manual')),
  is_active boolean not null default true,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(company_id, email)
);

create table if not exists public.fleet_status_report_logs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  report_date date not null,
  report_month text not null,
  affected_station_codes text[] not null default '{}'::text[],
  recipients text[] not null default '{}'::text[],
  subject text not null,
  status text not null check (status in ('sent', 'skipped', 'failed')),
  message_id text,
  root_message_id text,
  error_message text,
  created_at timestamptz not null default now(),
  unique(company_id, report_date)
);

create index if not exists fleet_status_report_logs_month_idx
  on public.fleet_status_report_logs(company_id, report_month, created_at desc);

alter table public.fleet_status_report_recipients enable row level security;
alter table public.fleet_status_report_logs enable row level security;
revoke all on table public.fleet_status_report_recipients, public.fleet_status_report_logs from anon, authenticated;
grant select, insert, update, delete on table public.fleet_status_report_recipients to service_role;
grant select, insert, update, delete on table public.fleet_status_report_logs to service_role;

comment on column public.fleet_control_settings.daily_status_email_enabled is
  'Disabled by default until vehicle ownership and operational status data is complete.';

alter table public.fleet_audit_checklist_items
  add column if not exists audit_mode text not null default 'both';

alter table public.fleet_audit_checklist_items
  drop constraint if exists fleet_audit_checklist_items_audit_mode_check;
alter table public.fleet_audit_checklist_items
  add constraint fleet_audit_checklist_items_audit_mode_check
  check (audit_mode in ('both', 'video', 'physical'));

insert into public.fleet_audit_checklist_items
  (company_id, template_id, category, label, guidance, response_type, is_required, failure_severity, sort_order, audit_mode)
select template.company_id, template.id, item.category, item.label, item.guidance, item.response_type, true, item.severity, item.sort_order, 'physical'
from public.fleet_audit_templates template
cross join (values
  ('Driver & driving', 'Driver / DA name', 'Record the person driving this vehicle during the physical inspection.', 'text', 'medium', 210),
  ('Driver & driving', 'Driver / DA mobile number', 'Record a reachable 10-digit mobile number.', 'text', 'medium', 220),
  ('Driver & driving', 'Is the driving licence available and valid?', '[remarks-fail:required] Verify the licence class and validity for this vehicle.', 'pass_fail', 'critical', 230),
  ('Driver & driving', 'Does the driver consistently use the seat belt and follow safe-start checks?', '[remarks-fail:required] Ask for a practical demonstration before movement.', 'pass_fail', 'high', 240),
  ('Driver & driving', 'Is the observed driving smooth and within safe speed?', '[remarks-fail:required] Observe acceleration, braking, cornering, reversing and mobile-phone use.', 'pass_fail', 'high', 250),
  ('Driver & driving', 'Recent speeding, harsh braking, accident or traffic violation observations', 'Review available GPS or supervisor feedback. Record None when clear.', 'text', 'high', 260)
) as item(category, label, guidance, response_type, severity, sort_order)
where template.is_default and template.is_active
  and not exists (
    select 1 from public.fleet_audit_checklist_items existing
    where existing.company_id = template.company_id and existing.template_id = template.id and existing.label = item.label
  );
