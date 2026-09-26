-- Fleet Control: service history, routine audits, configurable checklists and portal access.
create table if not exists public.fleet_service_history (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  vehicle_id uuid not null references public.fleet_vehicles(id) on delete cascade,
  service_date date not null,
  service_type text not null,
  odometer_km numeric(12,1),
  vendor_name text,
  vendor_contact text,
  amount numeric(14,2) not null default 0 check (amount >= 0),
  status text not null default 'completed' check (status in ('scheduled','in_progress','completed','cancelled')),
  description text,
  invoice_document_id uuid,
  invoice_url text,
  next_service_date date,
  next_service_odometer_km numeric(12,1),
  downtime_hours numeric(10,2) check (downtime_hours is null or downtime_hours >= 0),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists fleet_service_history_vehicle_date_idx
  on public.fleet_service_history(company_id, vehicle_id, service_date desc);
create index if not exists fleet_service_history_next_date_idx
  on public.fleet_service_history(company_id, next_service_date) where status <> 'cancelled';

create table if not exists public.fleet_audit_templates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  description text,
  cadence_days integer not null default 30 check (cadence_days between 1 and 365),
  applies_to_statuses text[] not null default array['active','repair','breakdown']::text[],
  is_default boolean not null default false,
  is_active boolean not null default true,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(company_id, name)
);

create unique index if not exists fleet_audit_templates_one_default_idx
  on public.fleet_audit_templates(company_id) where is_default and is_active;

create table if not exists public.fleet_audit_checklist_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  template_id uuid not null references public.fleet_audit_templates(id) on delete cascade,
  category text not null,
  label text not null,
  guidance text,
  response_type text not null default 'pass_fail' check (response_type in ('pass_fail','yes_no','number','text','date','photo','video')),
  is_required boolean not null default true,
  failure_severity text not null default 'medium' check (failure_severity in ('low','medium','high','critical')),
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists fleet_audit_checklist_template_idx
  on public.fleet_audit_checklist_items(company_id, template_id, sort_order);

create table if not exists public.fleet_audits (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  vehicle_id uuid not null references public.fleet_vehicles(id) on delete cascade,
  template_id uuid references public.fleet_audit_templates(id) on delete set null,
  scheduled_for date not null,
  scheduled_reason text not null,
  risk_score integer not null default 0 check (risk_score between 0 and 100),
  status text not null default 'scheduled' check (status in ('scheduled','in_progress','passed','failed','cancelled')),
  assigned_to uuid references public.profiles(id),
  started_at timestamptz,
  completed_at timestamptz,
  completed_by uuid references public.profiles(id),
  score numeric(5,2),
  summary text,
  odometer_km numeric(12,1),
  email_status text not null default 'not_sent' check (email_status in ('not_sent','queued','sent','failed')),
  email_sent_at timestamptz,
  email_recipients jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists fleet_audits_vehicle_date_idx
  on public.fleet_audits(company_id, vehicle_id, scheduled_for desc);
create index if not exists fleet_audits_queue_idx
  on public.fleet_audits(company_id, status, scheduled_for);

create table if not exists public.fleet_audit_responses (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  audit_id uuid not null references public.fleet_audits(id) on delete cascade,
  checklist_item_id uuid not null references public.fleet_audit_checklist_items(id),
  response_value jsonb,
  passed boolean,
  comments text,
  evidence_document_id uuid,
  responded_by uuid references public.profiles(id),
  responded_at timestamptz not null default now(),
  unique(audit_id, checklist_item_id)
);

create table if not exists public.fleet_audit_evidence (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  audit_id uuid not null references public.fleet_audits(id) on delete cascade,
  checklist_item_id uuid references public.fleet_audit_checklist_items(id) on delete set null,
  media_type text not null check (media_type in ('photo','video','document')),
  media_url text not null,
  caption text,
  captured_at timestamptz,
  uploaded_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists fleet_audit_evidence_audit_idx
  on public.fleet_audit_evidence(company_id, audit_id, created_at);

create table if not exists public.fleet_audit_findings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  audit_id uuid not null references public.fleet_audits(id) on delete cascade,
  category text not null,
  finding text not null,
  severity text not null default 'medium' check (severity in ('low','medium','high','critical')),
  action_required text,
  owner_user_id uuid references public.profiles(id),
  expected_completion_date date,
  status text not null default 'open' check (status in ('open','in_progress','resolved','accepted')),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists fleet_audit_findings_action_idx
  on public.fleet_audit_findings(company_id, status, expected_completion_date);

create table if not exists public.fleet_control_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  default_audit_cadence_days integer not null default 30 check (default_audit_cadence_days between 1 and 365),
  document_warning_days integer not null default 30 check (document_warning_days between 1 and 180),
  service_warning_days integer not null default 14 check (service_warning_days between 1 and 90),
  auto_suggest_audits boolean not null default true,
  breakdown_vehicle_link_required boolean not null default false,
  audit_email_enabled boolean not null default true,
  audit_video_required boolean not null default true,
  risk_weights jsonb not null default '{"breakdown":40,"under_service":25,"document_expired":25,"document_due":12,"audit_overdue":25,"audit_never":20,"service_due":20}'::jsonb,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

create table if not exists public.fleet_integration_settings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  provider text not null check (provider in ('paytap','wheelseye')),
  is_enabled boolean not null default false,
  status text not null default 'not_configured' check (status in ('not_configured','in_progress','connected','error')),
  configuration jsonb not null default '{}'::jsonb,
  last_sync_at timestamptz,
  last_error text,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(),
  unique(company_id, provider)
);

-- Reserved link layer for the later conditional "Vehicle breakdown" ad-hoc flow.
-- The UI remains disabled until breakdown_vehicle_link_required is enabled.
create table if not exists public.fleet_adhoc_vehicle_links (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  source_type text not null,
  source_id text not null,
  request_date date not null,
  station_code text not null,
  reason_code text not null,
  vehicle_id uuid references public.fleet_vehicles(id) on delete set null,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  unique(company_id, source_type, source_id)
);

alter table public.fleet_vehicles
  add column if not exists color text,
  add column if not exists ownership_type text default 'company',
  add column if not exists current_odometer_km numeric(12,1),
  add column if not exists service_book_available boolean,
  add column if not exists assigned_driver_name text,
  add column if not exists assigned_driver_mobile text,
  add column if not exists paytap_vehicle_id text,
  add column if not exists wheelseye_device_id text;

do $$
begin
  if to_regclass('public.fleet_fuel_transactions') is not null then
    alter table public.fleet_fuel_transactions drop constraint if exists fleet_fuel_transactions_provider_check;
    alter table public.fleet_fuel_transactions add constraint fleet_fuel_transactions_provider_check check (provider in ('IOC','BPCL','PAYTAP'));
  end if;
end $$;

create table if not exists public.fleet_portal_memberships (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role_id uuid references public.user_roles(id) on delete set null,
  has_all_location_access boolean not null default false,
  location_scope_ids uuid[] not null default '{}'::uuid[],
  access_level text not null default 'viewer' check (access_level in ('viewer','operator','approver','administrator')),
  is_active boolean not null default true,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(company_id, user_id)
);

create index if not exists fleet_portal_memberships_user_idx
  on public.fleet_portal_memberships(user_id, company_id) where is_active;

alter table public.fleet_service_history enable row level security;
alter table public.fleet_audit_templates enable row level security;
alter table public.fleet_audit_checklist_items enable row level security;
alter table public.fleet_audits enable row level security;
alter table public.fleet_audit_responses enable row level security;
alter table public.fleet_audit_evidence enable row level security;
alter table public.fleet_audit_findings enable row level security;
alter table public.fleet_control_settings enable row level security;
alter table public.fleet_portal_memberships enable row level security;
alter table public.fleet_integration_settings enable row level security;
alter table public.fleet_adhoc_vehicle_links enable row level security;

insert into public.fleet_control_settings(company_id)
select id from public.companies
on conflict (company_id) do nothing;

with inserted_templates as (
  insert into public.fleet_audit_templates(company_id, name, description, cadence_days, is_default)
  select id, 'Routine vehicle audit', 'Operational, safety, document and condition inspection.', 30, true
  from public.companies
  on conflict (company_id, name) do update set is_default = true, is_active = true
  returning id, company_id
)
insert into public.fleet_audit_checklist_items(company_id, template_id, category, label, guidance, response_type, is_required, failure_severity, sort_order)
select template.company_id, template.id, item.category, item.label, item.guidance, item.response_type, item.required, item.severity, item.sort_order
from inserted_templates template
cross join (values
  ('Identity','Registration number matches the vehicle and master','Verify number plate, RC and vehicle master details.','pass_fail',true,'critical',10),
  ('Usage','Current odometer reading','Enter the kilometres displayed and compare with GPS distance.','number',true,'high',20),
  ('Documents','RC copy is available and valid','Verify the original or approved digital copy.','pass_fail',true,'critical',30),
  ('Documents','Insurance is valid and expiry date is recorded','Confirm policy number and expiry against the vehicle master.','pass_fail',true,'critical',40),
  ('Documents','PUC is valid and expiry date is recorded','Not applicable may be used for eligible EV vehicles.','pass_fail',true,'critical',50),
  ('Documents','Fitness and permit are valid','Confirm certificate and permit expiry.','pass_fail',true,'critical',60),
  ('Documents','Road tax is valid','Confirm the latest tax payment or exemption.','pass_fail',true,'high',70),
  ('Service','Service book is available and updated','Check the latest service stamp, date and odometer.','yes_no',true,'medium',80),
  ('Service','Next service due date or odometer is recorded','Create a service reminder if one is missing.','pass_fail',true,'high',90),
  ('Tyres','Front-left tyre condition','Inspect tread, sidewall, pressure and visible damage.','pass_fail',true,'high',100),
  ('Tyres','Front-right tyre condition','Inspect tread, sidewall, pressure and visible damage.','pass_fail',true,'high',110),
  ('Tyres','Rear-left tyre condition','Inspect tread, sidewall, pressure and visible damage.','pass_fail',true,'high',120),
  ('Tyres','Rear-right tyre condition','Inspect tread, sidewall, pressure and visible damage.','pass_fail',true,'high',130),
  ('Tyres','Spare tyre is present and serviceable','Verify spare tyre, jack and wheel spanner.','pass_fail',true,'high',140),
  ('Battery','Battery has no leakage or corrosion','Inspect terminals, casing and surrounding area.','pass_fail',true,'high',150),
  ('Battery','Battery is properly charged','Verify starting performance or EV battery health.','pass_fail',true,'high',160),
  ('Safety','Brakes and parking brake respond correctly','Test at safe low speed.','pass_fail',true,'critical',170),
  ('Safety','Lights and indicators work','Check headlights, tail lights, brake lights and indicators.','pass_fail',true,'high',180),
  ('Safety','Horn and both mirrors work','Confirm horn and left/right mirrors are intact.','pass_fail',true,'high',190),
  ('Safety','First-aid kit and warning equipment are present','Confirm usable condition and expiry where relevant.','pass_fail',true,'high',200),
  ('Condition','Cabin and cargo area are clean and hygienic','Record any hygiene issue for station action.','pass_fail',true,'medium',210),
  ('Condition','Body, bumper, glass, seats and doors are secure','Photograph dents, cracks, missing parts or accident damage.','pass_fail',true,'high',220),
  ('Condition','No fluid leak, abnormal noise or dashboard warning','Inspect the parking area, engine bay and cluster.','pass_fail',true,'critical',230),
  ('Evidence','Vehicle inspection photo set','Upload front, rear, both sides, cabin, cargo area and odometer.','photo',true,'medium',240),
  ('Evidence','Walk-around audit video','Upload a clear continuous vehicle walk-around video.','video',true,'medium',250),
  ('Findings','Additional findings and required action','Record owner, expected completion date and action status.','text',false,'medium',260)
) as item(category,label,guidance,response_type,required,severity,sort_order)
where not exists (
  select 1 from public.fleet_audit_checklist_items existing
  where existing.company_id = template.company_id and existing.template_id = template.id and existing.label = item.label
);

insert into public.fleet_integration_settings(company_id, provider, status)
select company.id, provider.name, 'in_progress'
from public.companies company
cross join (values ('paytap'), ('wheelseye')) as provider(name)
on conflict (company_id, provider) do nothing;
