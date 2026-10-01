-- Configurable vehicle availability statuses and dependent reasons.

create table if not exists public.fleet_vehicle_status_master (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  status_key text not null,
  label text not null,
  helper_text text,
  tone text not null default 'neutral' check (tone in ('good','info','warn','bad','neutral')),
  is_operational boolean not null default false,
  is_terminal boolean not null default false,
  requires_reason boolean not null default true,
  requires_expected_date boolean not null default false,
  sort_order integer not null default 100,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(company_id, status_key)
);

create table if not exists public.fleet_vehicle_status_reason_master (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  status_id uuid not null references public.fleet_vehicle_status_master(id) on delete cascade,
  reason_key text not null,
  label text not null,
  helper_text text,
  sort_order integer not null default 100,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(status_id, reason_key)
);

alter table public.fleet_vehicles
  add column if not exists status_reason_id uuid references public.fleet_vehicle_status_reason_master(id) on delete set null,
  add column if not exists status_reason_key text;

create index if not exists fleet_vehicle_status_master_company_idx
  on public.fleet_vehicle_status_master(company_id, is_active, sort_order);
create index if not exists fleet_vehicle_status_reason_master_status_idx
  on public.fleet_vehicle_status_reason_master(status_id, is_active, sort_order);

alter table public.fleet_vehicle_status_master enable row level security;
alter table public.fleet_vehicle_status_reason_master enable row level security;
revoke all on table public.fleet_vehicle_status_master, public.fleet_vehicle_status_reason_master from anon, authenticated;
grant select, insert, update, delete on table public.fleet_vehicle_status_master, public.fleet_vehicle_status_reason_master to service_role;

insert into public.fleet_vehicle_status_master
  (company_id, status_key, label, helper_text, tone, is_operational, is_terminal, requires_reason, requires_expected_date, sort_order)
select company.id, seed.status_key, seed.label, seed.helper_text, seed.tone, seed.is_operational, seed.is_terminal, seed.requires_reason, seed.requires_expected_date, seed.sort_order
from public.companies company
cross join (values
  ('active','Active','Available for operations','good',true,false,false,false,10),
  ('under_service','Under service','Planned service or repair','warn',false,false,true,true,20),
  ('breakdown','Breakdown','Unexpectedly unavailable','bad',false,false,true,true,30),
  ('inactive','Inactive','Temporarily out of use','neutral',false,false,true,false,40),
  ('returned','Returned','Returned to owner or lessor','neutral',false,true,true,false,50),
  ('sold','Sold','Vehicle sold','neutral',false,true,true,false,60),
  ('disposed','Disposed','Vehicle permanently removed','bad',false,true,true,false,70)
) as seed(status_key,label,helper_text,tone,is_operational,is_terminal,requires_reason,requires_expected_date,sort_order)
on conflict (company_id,status_key) do update set
  label=excluded.label, helper_text=excluded.helper_text, tone=excluded.tone,
  is_operational=excluded.is_operational, is_terminal=excluded.is_terminal,
  requires_reason=excluded.requires_reason, requires_expected_date=excluded.requires_expected_date,
  sort_order=excluded.sort_order, is_active=true, updated_at=now();

insert into public.fleet_vehicle_status_reason_master
  (company_id, status_id, reason_key, label, helper_text, sort_order)
select status.company_id, status.id, seed.reason_key, seed.label, seed.helper_text, seed.sort_order
from public.fleet_vehicle_status_master status
join (values
  ('under_service','scheduled_service','Scheduled service','Routine service plan',10),
  ('under_service','mechanical_repair','Mechanical repair','Engine, clutch, gearbox or related work',20),
  ('under_service','accident_repair','Accident repair','Repair following an accident or insurance claim',30),
  ('under_service','tyre_body_work','Tyre / body work','Tyre, painting, fitness or body work',40),
  ('under_service','waiting_for_parts','Waiting for parts','Vehicle is held while spares arrive',50),
  ('breakdown','engine_failure','Engine failure','Engine or overheating issue',10),
  ('breakdown','electrical_failure','Electrical / battery failure','Battery, alternator or electrical fault',20),
  ('breakdown','tyre_failure','Tyre failure','Puncture, burst or wheel issue',30),
  ('breakdown','accident','Accident','Vehicle involved in an accident',40),
  ('breakdown','other_breakdown','Other breakdown','Another unexpected failure',90),
  ('inactive','temporarily_out_of_use','Temporarily out of use','Short-term operational hold',10),
  ('inactive','route_not_available','Route not available','No route currently allocated',20),
  ('inactive','driver_unavailable','Driver unavailable','No driver or DA available',30),
  ('inactive','document_hold','Document / compliance hold','Document, permit or compliance issue',40),
  ('inactive','insurance_claim','Insurance claim','Held during claim processing',50),
  ('inactive','management_hold','Management hold','Temporarily held by management',60),
  ('inactive','other','Other','Another reason recorded in the comment',90),
  ('returned','contract_ended','Contract ended','Rental or lease contract ended',10),
  ('returned','owner_recall','Owner recall','Owner or lessor requested the vehicle back',20),
  ('sold','asset_sold','Asset sold','Vehicle ownership transferred by sale',10),
  ('disposed','total_loss','Total loss','Vehicle declared a total loss',10),
  ('disposed','scrapped','Scrapped','Vehicle scrapped or deregistered',20),
  ('disposed','beyond_economic_repair','Beyond economic repair','Repair is no longer economical',30)
) as seed(status_key,reason_key,label,helper_text,sort_order)
  on seed.status_key=status.status_key
on conflict (status_id,reason_key) do update set
  label=excluded.label, helper_text=excluded.helper_text, sort_order=excluded.sort_order,
  is_active=true, updated_at=now();

