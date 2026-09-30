-- OpsPulse station audit workspace. Audit configuration is data-driven; the
-- records below only provide the initial operational programme and can be
-- maintained from Ops Masters > Audit.

create table if not exists public.ops_audit_types (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  code text not null,
  name text not null,
  description text,
  cadence_unit text not null default 'weekly',
  required_count integer not null default 1 check (required_count > 0),
  scheduling_config jsonb not null default '{}'::jsonb,
  default_response_hours integer not null default 72 check (default_response_hours >= 0),
  expected_duration_minutes integer,
  requires_video_link boolean not null default false,
  video_link_help text,
  email_subject_template text,
  email_body_template text,
  recipient_rules jsonb not null default '[]'::jsonb,
  cc_rules jsonb not null default '[]'::jsonb,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(company_id, code)
);

create table if not exists public.ops_audit_checklist_sections (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  audit_type_id uuid not null references public.ops_audit_types(id) on delete cascade,
  code text not null,
  name text not null,
  guidance text,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(audit_type_id, code)
);

create table if not exists public.ops_audit_reference_options (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  option_group text not null,
  code text not null,
  label text not null,
  description text,
  metadata jsonb not null default '{}'::jsonb,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(company_id, option_group, code)
);

create table if not exists public.ops_audit_checklist_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  audit_type_id uuid not null references public.ops_audit_types(id) on delete cascade,
  section_id uuid references public.ops_audit_checklist_sections(id) on delete set null,
  code text not null,
  label text not null,
  guidance text,
  response_type text not null default 'pass_fail_na',
  response_options jsonb not null default '[]'::jsonb,
  is_required boolean not null default true,
  evidence_rule text not null default 'on_non_compliance',
  action_rule text not null default 'on_non_compliance',
  default_severity_code text,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(audit_type_id, code)
);

create table if not exists public.ops_station_audits (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  audit_number text not null,
  audit_type_id uuid not null references public.ops_audit_types(id),
  location_id uuid not null references public.stations(id),
  station_snapshot jsonb not null default '{}'::jsonb,
  cycle_key text not null,
  period_slot text not null default 'standard',
  scheduled_for timestamptz not null,
  scheduled_reason text,
  schedule_source text not null default 'manual',
  status_code text not null default 'scheduled',
  assigned_to uuid,
  assigned_name text,
  assigned_email text,
  scheduled_by uuid,
  started_at timestamptz,
  completed_at timestamptz,
  completed_by uuid,
  response_due_at timestamptz,
  station_response_status text not null default 'not_requested',
  system_cash_amount numeric(14,2),
  physical_cash_amount numeric(14,2),
  cash_variance_amount numeric(14,2),
  system_shipment_count integer,
  physical_shipment_count integer,
  shipment_missing_count integer not null default 0,
  shipment_excess_count integer not null default 0,
  shipment_unresolved_count integer not null default 0,
  video_call_url text,
  video_call_verified_at timestamptz,
  overall_summary text,
  station_summary text,
  manager_summary text,
  score numeric(6,2),
  email_status text not null default 'not_sent',
  email_sent_at timestamptz,
  email_recipients jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(company_id, audit_number),
  unique(company_id, audit_type_id, location_id, cycle_key, period_slot)
);

create table if not exists public.ops_station_audit_cash_counts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  audit_id uuid not null references public.ops_station_audits(id) on delete cascade,
  cash_side text not null,
  denomination_option_id uuid references public.ops_audit_reference_options(id) on delete set null,
  denomination_value numeric(12,2) not null,
  note_count integer not null default 0 check (note_count >= 0),
  computed_amount numeric(14,2) generated always as (denomination_value * note_count) stored,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(audit_id, cash_side, denomination_value)
);

create table if not exists public.ops_station_audit_check_responses (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  audit_id uuid not null references public.ops_station_audits(id) on delete cascade,
  checklist_item_id uuid not null references public.ops_audit_checklist_items(id),
  response_value jsonb,
  is_compliant boolean,
  remarks text,
  response_source text not null default 'auditor',
  responded_by uuid,
  responded_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(audit_id, checklist_item_id)
);

create table if not exists public.ops_station_audit_shipments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  audit_id uuid not null references public.ops_station_audits(id) on delete cascade,
  tracking_id text not null,
  system_status_code text,
  physical_status_option_id uuid references public.ops_audit_reference_options(id) on delete set null,
  physical_status_code text,
  discrepancy_option_id uuid references public.ops_audit_reference_options(id) on delete set null,
  discrepancy_code text,
  system_snapshot jsonb not null default '{}'::jsonb,
  observed_at timestamptz,
  remarks text,
  required_action text,
  due_at timestamptz,
  is_resolved boolean not null default false,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(audit_id, tracking_id)
);

create table if not exists public.ops_station_audit_actions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  audit_id uuid not null references public.ops_station_audits(id) on delete cascade,
  checklist_item_id uuid references public.ops_audit_checklist_items(id) on delete set null,
  shipment_id uuid references public.ops_station_audit_shipments(id) on delete set null,
  title text not null,
  corrective_action text not null,
  preventive_action text,
  severity_code text,
  status_code text not null default 'open',
  owner_user_id uuid,
  owner_name text,
  owner_email text,
  due_at timestamptz,
  completed_at timestamptz,
  completion_note text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ops_station_audit_comments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  audit_id uuid not null references public.ops_station_audits(id) on delete cascade,
  parent_comment_id uuid references public.ops_station_audit_comments(id) on delete cascade,
  body text not null,
  audience text not null default 'participants',
  requests_station_response boolean not null default false,
  created_by uuid,
  author_name text,
  author_email text,
  created_at timestamptz not null default now()
);

create table if not exists public.ops_station_audit_evidence (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  audit_id uuid not null references public.ops_station_audits(id) on delete cascade,
  checklist_response_id uuid references public.ops_station_audit_check_responses(id) on delete cascade,
  action_id uuid references public.ops_station_audit_actions(id) on delete cascade,
  shipment_id uuid references public.ops_station_audit_shipments(id) on delete cascade,
  evidence_kind_code text,
  file_name text,
  media_url text not null,
  caption text,
  uploaded_by uuid,
  uploaded_at timestamptz not null default now()
);

create table if not exists public.ops_station_audit_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  audit_id uuid not null references public.ops_station_audits(id) on delete cascade,
  event_type text not null,
  before_data jsonb not null default '{}'::jsonb,
  after_data jsonb not null default '{}'::jsonb,
  actor_user_id uuid,
  actor_name text,
  actor_email text,
  actor_role text,
  created_at timestamptz not null default now()
);

create table if not exists public.ops_station_audit_email_threads (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  audit_type_id uuid not null references public.ops_audit_types(id) on delete cascade,
  location_id uuid not null references public.stations(id) on delete cascade,
  thread_month text not null,
  subject text not null,
  root_message_id text not null,
  last_message_id text,
  lock_token text,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(company_id, audit_type_id, location_id, thread_month)
);

create index if not exists ops_station_audits_company_schedule_idx on public.ops_station_audits(company_id, scheduled_for desc);
create index if not exists ops_station_audits_company_location_idx on public.ops_station_audits(company_id, location_id, scheduled_for desc);
create index if not exists ops_station_audits_company_status_idx on public.ops_station_audits(company_id, status_code, response_due_at);
create index if not exists ops_station_audit_actions_open_idx on public.ops_station_audit_actions(company_id, status_code, due_at);
create index if not exists ops_station_audit_shipments_audit_idx on public.ops_station_audit_shipments(audit_id, is_resolved);
create index if not exists ops_station_audit_events_audit_idx on public.ops_station_audit_events(audit_id, created_at desc);

create or replace function public.ops_audit_touch_updated_at() returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists ops_audit_types_touch on public.ops_audit_types;
create trigger ops_audit_types_touch before update on public.ops_audit_types for each row execute function public.ops_audit_touch_updated_at();
drop trigger if exists ops_audit_sections_touch on public.ops_audit_checklist_sections;
create trigger ops_audit_sections_touch before update on public.ops_audit_checklist_sections for each row execute function public.ops_audit_touch_updated_at();
drop trigger if exists ops_audit_options_touch on public.ops_audit_reference_options;
create trigger ops_audit_options_touch before update on public.ops_audit_reference_options for each row execute function public.ops_audit_touch_updated_at();
drop trigger if exists ops_audit_items_touch on public.ops_audit_checklist_items;
create trigger ops_audit_items_touch before update on public.ops_audit_checklist_items for each row execute function public.ops_audit_touch_updated_at();
drop trigger if exists ops_station_audits_touch on public.ops_station_audits;
create trigger ops_station_audits_touch before update on public.ops_station_audits for each row execute function public.ops_audit_touch_updated_at();
drop trigger if exists ops_station_audit_cash_touch on public.ops_station_audit_cash_counts;
create trigger ops_station_audit_cash_touch before update on public.ops_station_audit_cash_counts for each row execute function public.ops_audit_touch_updated_at();
drop trigger if exists ops_station_audit_responses_touch on public.ops_station_audit_check_responses;
create trigger ops_station_audit_responses_touch before update on public.ops_station_audit_check_responses for each row execute function public.ops_audit_touch_updated_at();
drop trigger if exists ops_station_audit_shipments_touch on public.ops_station_audit_shipments;
create trigger ops_station_audit_shipments_touch before update on public.ops_station_audit_shipments for each row execute function public.ops_audit_touch_updated_at();
drop trigger if exists ops_station_audit_actions_touch on public.ops_station_audit_actions;
create trigger ops_station_audit_actions_touch before update on public.ops_station_audit_actions for each row execute function public.ops_audit_touch_updated_at();

-- Initial master configuration, sourced from the submitted physical and COD
-- audit reports. Values live in these records rather than application code.
do $$
declare
  v_company uuid := '43866344-b550-4e8a-9a2d-9d23f3d8a997';
  v_virtual uuid;
  v_physical uuid;
  v_section uuid;
begin
  insert into public.ops_audit_types(company_id, code, name, description, cadence_unit, required_count, scheduling_config, default_response_hours, expected_duration_minutes, requires_video_link, video_link_help, recipient_rules, cc_rules, email_subject_template, email_body_template, sort_order)
  values
  (v_company,'virtual_cod','Virtual COD audit','Late-night video verification of station COD, denomination count and system reconciliation.','weekly',1,'{"coverage":"every_active_station","distribution":"round_robin_by_weekday","time_window":"after_station_close"}'::jsonb,24,30,true,'Paste a Google Drive recording link with “Anyone with the link can view” access.','["station_email"]'::jsonb,'["station_manager_email","cluster_manager_email","ops_manager_email"]'::jsonb,'{{station_code}} · COD audit · {{audit_date}}','Virtual COD audit completed. Review cash reconciliation, denominations, shipment exceptions and required actions in Ops Pulse.',10),
  (v_company,'physical_station','Physical station audit','Unannounced on-site package, cash and operating-standard audit.','monthly',2,'{"coverage":"every_active_station","period_slots":["first_half","second_half"],"time_window":"before_open_or_after_close"}'::jsonb,168,120,false,null,'["station_email"]'::jsonb,'["station_manager_email","cluster_manager_email","ops_manager_email"]'::jsonb,'{{station_code}} · Physical station audit · {{audit_date}}','Physical station audit completed. Review shipment reconciliation, cash verification, findings and CAPA in Ops Pulse.',20)
  on conflict(company_id,code) do update set name=excluded.name, description=excluded.description, cadence_unit=excluded.cadence_unit, required_count=excluded.required_count, scheduling_config=excluded.scheduling_config, default_response_hours=excluded.default_response_hours, expected_duration_minutes=excluded.expected_duration_minutes, requires_video_link=excluded.requires_video_link, video_link_help=excluded.video_link_help, recipient_rules=excluded.recipient_rules, cc_rules=excluded.cc_rules, email_subject_template=excluded.email_subject_template, email_body_template=excluded.email_body_template, sort_order=excluded.sort_order, updated_at=now();

  select id into v_virtual from public.ops_audit_types where company_id=v_company and code='virtual_cod';
  select id into v_physical from public.ops_audit_types where company_id=v_company and code='physical_station';

  insert into public.ops_audit_reference_options(company_id,option_group,code,label,description,metadata,sort_order) values
  (v_company,'cash_denomination','2000','₹2,000',null,'{"value":2000}'::jsonb,10),(v_company,'cash_denomination','500','₹500',null,'{"value":500}'::jsonb,20),(v_company,'cash_denomination','200','₹200',null,'{"value":200}'::jsonb,30),(v_company,'cash_denomination','100','₹100',null,'{"value":100}'::jsonb,40),(v_company,'cash_denomination','50','₹50',null,'{"value":50}'::jsonb,50),(v_company,'cash_denomination','20','₹20',null,'{"value":20}'::jsonb,60),(v_company,'cash_denomination','10','₹10',null,'{"value":10}'::jsonb,70),(v_company,'cash_denomination','5','₹5',null,'{"value":5}'::jsonb,80),(v_company,'cash_denomination','2','₹2',null,'{"value":2}'::jsonb,90),(v_company,'cash_denomination','1','₹1',null,'{"value":1}'::jsonb,100),
  (v_company,'shipment_physical_status','delivered','Delivered','Verified delivered during audit.', '{}'::jsonb,10),(v_company,'shipment_physical_status','departed','Departed','Verified departed from station.', '{}'::jsonb,20),(v_company,'shipment_physical_status','at_station','At station','Physically present at station.', '{}'::jsonb,30),(v_company,'shipment_physical_status','lost','Lost','Not traceable after investigation.', '{}'::jsonb,40),(v_company,'shipment_physical_status','missing','Missing','Expected at station but not found.', '{}'::jsonb,50),(v_company,'shipment_physical_status','excess','Excess','Found physically but not expected in system.', '{}'::jsonb,60),(v_company,'shipment_physical_status','damaged','Damaged','Physical damage observed.', '{}'::jsonb,70),
  (v_company,'shipment_discrepancy','missing','Missing from physical count',null,'{"count_as":"missing","default_severity_code":"high"}'::jsonb,10),(v_company,'shipment_discrepancy','excess','Excess physical package',null,'{"count_as":"excess","default_severity_code":"high"}'::jsonb,20),(v_company,'shipment_discrepancy','left_station','Left at station',null,'{"default_severity_code":"medium"}'::jsonb,30),(v_company,'shipment_discrepancy','status_mismatch','System and physical status differ',null,'{"default_severity_code":"medium"}'::jsonb,40),(v_company,'shipment_discrepancy','damaged','Package damage',null,'{"default_severity_code":"high"}'::jsonb,50),
  (v_company,'audit_status','scheduled','Scheduled',null,'{"color":"neutral"}'::jsonb,10),(v_company,'audit_status','in_progress','In progress',null,'{"color":"blue"}'::jsonb,20),(v_company,'audit_status','awaiting_station_response','Awaiting station response',null,'{"color":"amber"}'::jsonb,30),(v_company,'audit_status','under_review','Manager review',null,'{"color":"blue"}'::jsonb,40),(v_company,'audit_status','closed','Closed',null,'{"color":"green"}'::jsonb,50),(v_company,'audit_status','overdue','Overdue',null,'{"color":"red"}'::jsonb,60),
  (v_company,'action_status','open','Open',null,'{"color":"red"}'::jsonb,10),(v_company,'action_status','in_progress','In progress',null,'{"color":"amber"}'::jsonb,20),(v_company,'action_status','completed','Completed',null,'{"color":"green"}'::jsonb,30),
  (v_company,'severity','critical','Critical',null,'{"color":"red"}'::jsonb,10),(v_company,'severity','high','High',null,'{"color":"orange"}'::jsonb,20),(v_company,'severity','medium','Medium',null,'{"color":"amber"}'::jsonb,30),(v_company,'severity','low','Low',null,'{"color":"blue"}'::jsonb,40),
  (v_company,'evidence_kind','video','Video call recording',null,'{}'::jsonb,10),(v_company,'evidence_kind','photo','Photo',null,'{}'::jsonb,20),(v_company,'evidence_kind','document','Document',null,'{}'::jsonb,30),(v_company,'evidence_kind','screenshot','System screenshot',null,'{}'::jsonb,40)
  on conflict(company_id,option_group,code) do update set label=excluded.label,description=excluded.description,metadata=excluded.metadata,sort_order=excluded.sort_order,updated_at=now();

  insert into public.ops_audit_checklist_sections(company_id,audit_type_id,code,name,guidance,sort_order) values
  (v_company,v_virtual,'cash_reconciliation','Cash reconciliation','Reconcile SCC/system amount, physical cash and every denomination.',10),
  (v_company,v_virtual,'shipment_controls','Shipment and exception controls','Verify OOR, un-debriefed cash and shipment exceptions.',20),
  (v_company,v_virtual,'evidence','Call evidence','Record the late-night video verification and supporting system screenshots.',30),
  (v_company,v_physical,'shipment_reconciliation','Shipment reconciliation','Scan and reconcile all physical packages against the system.',10),
  (v_company,v_physical,'cod_reconciliation','COD reconciliation','Verify system cash, physical cash, denominations and remittance.',20),
  (v_company,v_physical,'operations','Operational process','Validate scan discipline, status boards, RTS, ageing and package handling.',30),
  (v_company,v_physical,'safety_hygiene','Safety, hygiene and infrastructure','Verify 5S, fire readiness, CCTV, equipment, hygiene and facilities.',40)
  on conflict(audit_type_id,code) do update set name=excluded.name,guidance=excluded.guidance,sort_order=excluded.sort_order,updated_at=now();

  select id into v_section from public.ops_audit_checklist_sections where audit_type_id=v_virtual and code='cash_reconciliation';
  insert into public.ops_audit_checklist_items(company_id,audit_type_id,section_id,code,label,guidance,response_type,is_required,evidence_rule,action_rule,default_severity_code,sort_order) values
  (v_company,v_virtual,v_section,'system_cash','System COD amount captured','Capture the value displayed in SCC/system.','amount',true,'on_non_compliance','on_non_compliance','high',10),
  (v_company,v_virtual,v_section,'physical_cash','Physical COD counted live','Count cash live on video; record denomination totals separately.','amount',true,'always','on_non_compliance','high',20),
  (v_company,v_virtual,v_section,'cash_match','System and physical cash match','Record the reconciliation outcome and reason for any variance.','pass_fail_na',true,'on_non_compliance','on_non_compliance','critical',30)
  on conflict(audit_type_id,code) do update set label=excluded.label,guidance=excluded.guidance,response_type=excluded.response_type,is_required=excluded.is_required,evidence_rule=excluded.evidence_rule,action_rule=excluded.action_rule,default_severity_code=excluded.default_severity_code,sort_order=excluded.sort_order,updated_at=now();
  select id into v_section from public.ops_audit_checklist_sections where audit_type_id=v_virtual and code='shipment_controls';
  insert into public.ops_audit_checklist_items(company_id,audit_type_id,section_id,code,label,guidance,response_type,is_required,evidence_rule,action_rule,default_severity_code,sort_order) values
  (v_company,v_virtual,v_section,'oor_packages','OOR packages verified','Verify zero OOR or record every tracking ID and action.','pass_fail_na',true,'on_non_compliance','on_non_compliance','high',10),
  (v_company,v_virtual,v_section,'undeBriefed_cash','Un-debriefed cash checked','Verify cash with associate / un-debriefed cash and expected remittance.','pass_fail_na',true,'on_non_compliance','on_non_compliance','high',20),
  (v_company,v_virtual,v_section,'remittance','Remittance / prepare-deposit evidence checked','Check prepare-deposit, remittance and cash pickup status.','pass_fail_na',true,'on_non_compliance','on_non_compliance','medium',30)
  on conflict(audit_type_id,code) do update set label=excluded.label,guidance=excluded.guidance,response_type=excluded.response_type,is_required=excluded.is_required,evidence_rule=excluded.evidence_rule,action_rule=excluded.action_rule,default_severity_code=excluded.default_severity_code,sort_order=excluded.sort_order,updated_at=now();
  select id into v_section from public.ops_audit_checklist_sections where audit_type_id=v_virtual and code='evidence';
  insert into public.ops_audit_checklist_items(company_id,audit_type_id,section_id,code,label,guidance,response_type,is_required,evidence_rule,action_rule,default_severity_code,sort_order) values
  (v_company,v_virtual,v_section,'video_recording','Video call recording is accessible','Google Drive recording must allow anyone with the link to view.','pass_fail_na',true,'always','on_non_compliance','medium',10),
  (v_company,v_virtual,v_section,'system_screenshots','System screenshots attached','Attach system cash/exception evidence used during the call.','pass_fail_na',true,'always','on_non_compliance','medium',20)
  on conflict(audit_type_id,code) do update set label=excluded.label,guidance=excluded.guidance,response_type=excluded.response_type,is_required=excluded.is_required,evidence_rule=excluded.evidence_rule,action_rule=excluded.action_rule,default_severity_code=excluded.default_severity_code,sort_order=excluded.sort_order,updated_at=now();

  select id into v_section from public.ops_audit_checklist_sections where audit_type_id=v_physical and code='shipment_reconciliation';
  insert into public.ops_audit_checklist_items(company_id,audit_type_id,section_id,code,label,guidance,response_type,is_required,evidence_rule,action_rule,default_severity_code,sort_order) values
  (v_company,v_physical,v_section,'all_packages_scanned','Every physical package scanned','Scan each package and compare with system status.','pass_fail_na',true,'on_non_compliance','on_non_compliance','critical',10),
  (v_company,v_physical,v_section,'system_vs_physical','System and physical package counts reconciled','Record system count, physical count and all missing/excess items.','pass_fail_na',true,'on_non_compliance','on_non_compliance','critical',20),
  (v_company,v_physical,v_section,'tad_status','TAD-level outcome updated','Each exception must have a configured physical outcome and corrective action.','pass_fail_na',true,'on_non_compliance','on_non_compliance','high',30)
  on conflict(audit_type_id,code) do update set label=excluded.label,guidance=excluded.guidance,response_type=excluded.response_type,is_required=excluded.is_required,evidence_rule=excluded.evidence_rule,action_rule=excluded.action_rule,default_severity_code=excluded.default_severity_code,sort_order=excluded.sort_order,updated_at=now();
  select id into v_section from public.ops_audit_checklist_sections where audit_type_id=v_physical and code='cod_reconciliation';
  insert into public.ops_audit_checklist_items(company_id,audit_type_id,section_id,code,label,guidance,response_type,is_required,evidence_rule,action_rule,default_severity_code,sort_order) values
  (v_company,v_physical,v_section,'cash_system_value','System COD amount captured','Enter COD as per system.','amount',true,'on_non_compliance','on_non_compliance','high',10),
  (v_company,v_physical,v_section,'cash_physical_value','Physical COD amount counted','Enter live physical count; denomination rows remain mandatory.','amount',true,'always','on_non_compliance','high',20),
  (v_company,v_physical,v_section,'cash_security','Cash locker and cash security checked','Verify locker, security and no unauthorised cash rolling.','pass_fail_na',true,'on_non_compliance','on_non_compliance','critical',30),
  (v_company,v_physical,v_section,'cash_remittance','Cash deposit/remittance verified','Validate deposit and remittance process / evidence.','pass_fail_na',true,'on_non_compliance','on_non_compliance','high',40)
  on conflict(audit_type_id,code) do update set label=excluded.label,guidance=excluded.guidance,response_type=excluded.response_type,is_required=excluded.is_required,evidence_rule=excluded.evidence_rule,action_rule=excluded.action_rule,default_severity_code=excluded.default_severity_code,sort_order=excluded.sort_order,updated_at=now();
  select id into v_section from public.ops_audit_checklist_sections where audit_type_id=v_physical and code='operations';
  insert into public.ops_audit_checklist_items(company_id,audit_type_id,section_id,code,label,guidance,response_type,is_required,evidence_rule,action_rule,default_severity_code,sort_order) values
  (v_company,v_physical,v_section,'tdr_inbound_outbound','TDR and inbound/outbound checklist complete','Verify process controls are followed and recorded.','pass_fail_na',true,'on_non_compliance','on_non_compliance','high',10),
  (v_company,v_physical,v_section,'rts_process','RTS process and reconciliation followed','Check RTS table/process, consumables and 100% RTS reconciliation.','pass_fail_na',true,'on_non_compliance','on_non_compliance','high',20),
  (v_company,v_physical,v_section,'package_handling','Package handling and placement meet standards','Packages on pallets/crates; HFR/HFC/reject/HV/orphan areas correctly marked.','pass_fail_na',true,'on_non_compliance','on_non_compliance','high',30),
  (v_company,v_physical,v_section,'ageing_clearance','Ageing and unprocessed shipments cleared','Verify ageing clearance, DA monitoring and status boards.','pass_fail_na',true,'on_non_compliance','on_non_compliance','medium',40),
  (v_company,v_physical,v_section,'cctv_process','CCTV process and coverage adequate','Confirm required retention, working cameras and no blind spots.','pass_fail_na',true,'on_non_compliance','on_non_compliance','high',50)
  on conflict(audit_type_id,code) do update set label=excluded.label,guidance=excluded.guidance,response_type=excluded.response_type,is_required=excluded.is_required,evidence_rule=excluded.evidence_rule,action_rule=excluded.action_rule,default_severity_code=excluded.default_severity_code,sort_order=excluded.sort_order,updated_at=now();
  select id into v_section from public.ops_audit_checklist_sections where audit_type_id=v_physical and code='safety_hygiene';
  insert into public.ops_audit_checklist_items(company_id,audit_type_id,section_id,code,label,guidance,response_type,is_required,evidence_rule,action_rule,default_severity_code,sort_order) values
  (v_company,v_physical,v_section,'five_s','5S and station markings complete','Verify 5S, marked floors, dock doors, cages and assembly/fire exits.','pass_fail_na',true,'on_non_compliance','on_non_compliance','medium',10),
  (v_company,v_physical,v_section,'fire_safety','Fire safety equipment and PASS board valid','Check fire extinguishers, expiry and visual instruction board.','pass_fail_na',true,'on_non_compliance','on_non_compliance','critical',20),
  (v_company,v_physical,v_section,'staff_hygiene','Staff hygiene and visitor controls followed','Verify grooming, blue badges, visitor register and PPE.','pass_fail_na',true,'on_non_compliance','on_non_compliance','medium',30),
  (v_company,v_physical,v_section,'facility_hygiene','Facility hygiene, bathroom and first aid are adequate','Check cleaning, functional facilities and first-aid kit.','pass_fail_na',true,'on_non_compliance','on_non_compliance','medium',40),
  (v_company,v_physical,v_section,'equipment','Operational equipment and infrastructure functional','Check scanner/Dolphin, electrical equipment, office equipment and volumetric pallets.','pass_fail_na',true,'on_non_compliance','on_non_compliance','medium',50)
  on conflict(audit_type_id,code) do update set label=excluded.label,guidance=excluded.guidance,response_type=excluded.response_type,is_required=excluded.is_required,evidence_rule=excluded.evidence_rule,action_rule=excluded.action_rule,default_severity_code=excluded.default_severity_code,sort_order=excluded.sort_order,updated_at=now();
end $$;

alter table public.ops_audit_types enable row level security;
alter table public.ops_audit_checklist_sections enable row level security;
alter table public.ops_audit_reference_options enable row level security;
alter table public.ops_audit_checklist_items enable row level security;
alter table public.ops_station_audits enable row level security;
alter table public.ops_station_audit_cash_counts enable row level security;
alter table public.ops_station_audit_check_responses enable row level security;
alter table public.ops_station_audit_shipments enable row level security;
alter table public.ops_station_audit_actions enable row level security;
alter table public.ops_station_audit_comments enable row level security;
alter table public.ops_station_audit_evidence enable row level security;
alter table public.ops_station_audit_events enable row level security;
alter table public.ops_station_audit_email_threads enable row level security;
