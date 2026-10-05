-- Audit Master owns every check and collection requirement.
alter table public.ops_audit_types add column if not exists shipment_reconciliation_enabled boolean not null default false;
alter table public.ops_audit_checklist_items add column if not exists photo_on_non_compliance boolean not null default false;
alter table public.ops_audit_checklist_items add column if not exists remarks_required boolean not null default false;
alter table public.ops_audit_checklist_items add column if not exists employee_selection text not null default 'none' check(employee_selection in ('none','single','multiple'));
alter table public.ops_station_audit_shipments add column if not exists station_response jsonb;
create table if not exists public.ops_audit_shipment_lists (
 audit_id uuid primary key references public.ops_station_audits(id), company_id uuid not null,
 expected text[] not null default '{}', scanned text[] not null default '{}', recorded_at timestamptz not null default now(), recorded_by uuid
);
alter table public.ops_audit_shipment_lists enable row level security;
revoke all on public.ops_audit_shipment_lists from anon,authenticated;
grant all on public.ops_audit_shipment_lists to service_role;
update public.ops_audit_types set shipment_reconciliation_enabled=true where code='physical_station';
update public.ops_audit_checklist_items i set remarks_required=true from public.ops_audit_types t where i.audit_type_id=t.id and t.code='physical_station' and i.code='washroom_cleaning_frequency';

with definitions(code,label,guidance,employee_selection,photo_required,remarks_required,sort_order) as (values
('office_key_custody','Office keys have identified employee custodians','Select every employee who holds an office key, including spare keys. Confirm directly with the station team. If no custodian is identifiable, mark non-compliant and explain. Never photograph keys or key-cut patterns.','multiple',false,true,110),
('office_key_carried','Office keys are carried away, not left at or near the station','Confirm keys are not hidden inside the office, under mats, near doors or elsewhere around the premises after closing. Record how handover is controlled.','none',false,false,120),
('cash_key_custody','Cash locker and counter keys have identified employee custodians','Select the employee(s) who usually hold locker and cash counter keys, including spares. Confirm handover control. Do not photograph key patterns, PINs or combinations.','multiple',false,true,130),
('cash_lock_control','Cash locker and cash counter are locked; keys are not left at station','Check closing practice and access control with the team. Confirm the locker/counter is locked whenever unattended and keys are carried by the custodian. Record any lapse.','none',false,false,140),
('cctv_retention','CCTV has at least 60 days of retrievable backup','Open and play footage dated at least 60 days before this audit. Record the oldest retrievable date and camera coverage. Attach a timestamped playback screenshot without passwords.','none',true,true,150),
('unloading_cctv','Morning and unloading CCTV shows safe shipment handling','Review a recent morning unloading sequence. Record date/time and observed handling; check for throwing, dragging, crushing or unattended shipments. Add a relevant still or clip if a handling gap is observed.','none',false,true,160),
('shipment_bins_labels','All shipments are in designated, labelled bins or areas','Walk the station: check clear name boards, labels and bins for each shipment status. No shipments should be scattered, left in walkways or placed in unmarked areas. Photograph the storage layout.','none',true,false,170),
('damage_process','Damaged shipments follow the damage reporting and segregation process','Sample damaged shipments and confirm damage entry, evidence, safe segregation and escalation as required by the client process. Record sample TIDs, or explain if there are no damaged shipments.','none',false,true,180),
('orphan_connection','Orphan shipments are identified and connected in the system','Check orphan shipments against the system and confirm connection/escalation with an owner. Record sampled TIDs or confirm none found.','none',false,true,190),
('delivered_at_station','No delivered-status shipment is physically present at the station','Cross-check physical TIDs against system status. If a delivered shipment is found, record its TID in observations and the corrective action. Do not mark compliant until the discrepancy is explained.','none',false,true,200)
)
insert into public.ops_audit_checklist_items(company_id,audit_type_id,section_id,code,label,guidance,response_type,response_options,is_required,evidence_rule,action_rule,default_severity_code,sort_order,employee_selection,photo_required,remarks_required)
select t.company_id,t.id,s.id,d.code,d.label,d.guidance,'pass_fail_na','[{"value":"pass","label":"Compliant","is_compliant":true},{"value":"fail","label":"Non-compliant","is_compliant":false,"requires_action":true,"requires_evidence":true},{"value":"na","label":"Not applicable — explain"}]'::jsonb,true,case when d.photo_required then 'always' else 'on_non_compliance' end,'on_non_compliance','medium',d.sort_order,d.employee_selection,d.photo_required,d.remarks_required
from public.ops_audit_types t join public.ops_audit_checklist_sections s on s.audit_type_id=t.id and s.code='operations' cross join definitions d where t.code='physical_station'
on conflict(audit_type_id,code) do update set label=excluded.label,guidance=excluded.guidance,employee_selection=excluded.employee_selection,photo_required=excluded.photo_required,remarks_required=excluded.remarks_required;
update public.ops_audit_checklist_items i set label='RTS / RTSW processing and segregation are followed',guidance='Sample returned shipments. Verify return reason/status, RTS/RTSW scan events, timely processing, separate labelled bins and handover evidence against the client procedure. Record sample TIDs and any gap.',remarks_required=true from public.ops_audit_types t where t.id=i.audit_type_id and t.code='physical_station' and i.code='rts_process';
-- Superseded broad checks retain historical answers but are no longer repeated in new reports.
update public.ops_audit_checklist_items i set is_active=false from public.ops_audit_types t where t.id=i.audit_type_id and t.code='physical_station' and i.code in ('cctv_process','package_handling','all_packages_scanned','system_vs_physical');
with defs(code,label,metadata,ord) as (values
 ('missing','Still missing / investigating','{"requires_employee":false}'::jsonb,10),
 ('lost','Confirmed lost','{"requires_employee":true}'::jsonb,20),
 ('found','Located / found','{"requires_employee":false}'::jsonb,30),
 ('system_corrected','System record corrected','{"requires_employee":false}'::jsonb,40),
 ('excess_connected','Excess shipment connected','{"requires_employee":false}'::jsonb,50),
 ('returned','Returned / handed over','{"requires_employee":false}'::jsonb,60)
)
insert into public.ops_audit_reference_options(company_id,option_group,code,label,metadata,sort_order)
select distinct t.company_id,'shipment_response_status',d.code,d.label,d.metadata,d.ord from public.ops_audit_types t cross join defs d
on conflict(company_id,option_group,code) do nothing;

update public.ops_audit_checklist_items i set photo_on_non_compliance=true from public.ops_audit_types t where t.id=i.audit_type_id and t.code='physical_station' and i.is_active and not i.photo_required and i.code not in ('office_key_custody','office_key_carried','cash_key_custody','cash_lock_control','staff_hygiene');
update public.ops_audit_checklist_items i set evidence_rule='none',response_options='[{"value":"pass","label":"Compliant","is_compliant":true},{"value":"fail","label":"Non-compliant","is_compliant":false,"requires_action":true},{"value":"na","label":"Not applicable — explain"}]'::jsonb from public.ops_audit_types t where t.id=i.audit_type_id and t.code='physical_station' and i.code in ('office_key_custody','office_key_carried','cash_key_custody','cash_lock_control','staff_hygiene');
-- Minimal, private directory: base-station People and workforce plus current station responsibilities.
-- Salary, bank, personal contact and identity-document fields never leave this query.
create or replace function public.station_audit_employee_directory(p_company uuid,p_station uuid)
returns table(ref text,employee_code text,full_name text,designation text,is_active boolean)
language sql stable security invoker set search_path=public as $$
select 'employee:'||e.id,e.employee_code,e.full_name,coalesce(d.name,'People'),e.is_active
from employees e left join designations d on d.id=e.designation_id and d.company_id=p_company
where e.company_id=p_company and e.deleted_at is null and nullif(e.employee_code,'') is not null and (
 e.location_id=p_station or exists (
  select 1 from hr_engagements g join hr_work_assignments a on a.engagement_id=g.id and a.company_id=p_company
  where g.company_id=p_company and g.employee_id=e.id and g.start_date<=current_date and coalesce(g.end_date,current_date)>=current_date
  and a.effective_from<=current_date and coalesce(a.effective_to,current_date)>=current_date
  and (a.location_id=p_station or exists(select 1 from station_responsibility_assignments r where r.company_id=p_company and r.station_id=p_station and r.effective_from<=now() and coalesce(r.effective_to,now())>=now()
   and (r.assignment_id=a.id or exists(select 1 from hr_user_person_links l where l.company_id=p_company and l.person_id=g.person_id and l.user_id=r.assignee_user_id and l.status='active'))))
 ) or exists(select 1 from profiles p join station_responsibility_assignments r on r.assignee_user_id=p.id and r.company_id=p_company
   where p.company_id=p_company and (p.employee_id=e.id::text or p.employee_id=e.employee_code) and r.station_id=p_station and r.effective_from<=now() and coalesce(r.effective_to,now())>=now())
)
union all
select 'workforce:'||w.id,w.dropx_id,w.full_name,coalesce(w.designation,'Workforce'),w.is_active
from workforce w where w.company_id=p_company and w.location_id=p_station and w.deleted_at is null and nullif(w.dropx_id,'') is not null
order by full_name,employee_code;
$$;
revoke all on function public.station_audit_employee_directory(uuid,uuid) from public,anon,authenticated;
grant execute on function public.station_audit_employee_directory(uuid,uuid) to service_role;

-- A complete station response is atomic and never automatically closes an audit or makes a payroll charge.
create or replace function public.respond_station_audit_report(p_company uuid,p_audit uuid,p_expected timestamptz,p_body text,p_shipments jsonb,p_action uuid,p_actor uuid,p_name text,p_email text,p_role text)
returns void language plpgsql security invoker set search_path='' as $$
declare a public.ops_station_audits%rowtype; s public.ops_station_audit_shipments%rowtype; r jsonb; opt public.ops_audit_reference_options%rowtype; person jsonb;
begin
 select * into a from public.ops_station_audits where company_id=p_company and id=p_audit and deleted_at is null for update;
 if not found or a.completed_at is null or a.status_code<>'awaiting_station_response' or a.station_response_status<>'requested' then raise exception 'Audit is not awaiting a station response.'; end if;
 if a.updated_at is distinct from p_expected then raise exception 'Audit changed. Reopen it before responding.'; end if;
 if nullif(trim(p_body),'') is null then raise exception 'Add a station response.'; end if;
 if jsonb_array_length(p_shipments)<>(select count(*) from public.ops_station_audit_shipments where company_id=p_company and audit_id=p_audit and not is_resolved) or (select count(distinct x->>'id') from jsonb_array_elements(p_shipments) x)<>jsonb_array_length(p_shipments) then raise exception 'Respond to every shipment exactly once.'; end if;
 for s in select * from public.ops_station_audit_shipments where company_id=p_company and audit_id=p_audit and not is_resolved loop
  select x into r from jsonb_array_elements(p_shipments) x where x->>'id'=s.id::text;
  if r is null or nullif(trim(r->>'remarks'),'') is null then raise exception 'Respond to every shipment with its status and remarks.'; end if;
  select * into opt from public.ops_audit_reference_options where company_id=p_company and option_group='shipment_response_status' and code=r->>'status' and is_active;
  if not found then raise exception 'Choose an available shipment response status.'; end if;
  person=null;
  if nullif(r->>'employee_ref','') is not null then
   select to_jsonb(d) into person from public.station_audit_employee_directory(p_company,a.location_id) d where d.ref=r->>'employee_ref';
   if person is null then raise exception 'Employee is not linked to this station.'; end if;
  end if;
  if coalesce((opt.metadata->>'requires_employee')::boolean,false) and person is null then raise exception 'This shipment status requires a station-linked employee ID.'; end if;
  update public.ops_station_audit_shipments set station_response=jsonb_build_object('status',opt.code,'label',opt.label,'remarks',r->>'remarks','employee',person,'responded_by',p_actor,'responded_name',p_name,'responded_at',now()),updated_at=now() where id=s.id;
 end loop;
 if p_action is not null then
  update public.ops_station_audit_actions set status_code='completed',completed_at=now(),completion_note=p_body where company_id=p_company and audit_id=p_audit and id=p_action;
  if not found then raise exception 'Action does not belong to this audit.'; end if;
 end if;
 insert into public.ops_station_audit_comments(company_id,audit_id,body,audience,requests_station_response,created_by,author_name,author_email) values(p_company,p_audit,p_body,'managers',false,p_actor,p_name,p_email);
 update public.ops_station_audits set status_code='under_review',station_response_status='submitted',station_summary=p_body,updated_at=now() where id=p_audit;
 insert into public.ops_station_audit_events(company_id,audit_id,event_type,before_data,after_data,actor_user_id,actor_name,actor_email,actor_role)
 values(p_company,p_audit,'station_responded',jsonb_build_object('status',a.status_code),jsonb_build_object('status','under_review','shipments',p_shipments),p_actor,p_name,p_email,p_role);
end; $$;
revoke all on function public.respond_station_audit_report(uuid,uuid,timestamptz,text,jsonb,uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.respond_station_audit_report(uuid,uuid,timestamptz,text,jsonb,uuid,uuid,text,text,text) to service_role;

create or replace function public.submit_station_audit_report(p_company_id uuid,p_audit_id uuid,p_expected_updated_at timestamptz,p_patch jsonb,p_checks jsonb,p_counts jsonb,p_shipments jsonb,p_actions jsonb,p_evidence jsonb,p_actor_id uuid,p_actor_name text,p_actor_email text,p_actor_role text)
returns void language plpgsql security invoker set search_path='' as $$
declare v public.ops_station_audits%rowtype; n public.ops_station_audits%rowtype; old_lists jsonb;
begin
 select * into v from public.ops_station_audits where id=p_audit_id and company_id=p_company_id and deleted_at is null for update;
 if not found then raise exception 'Audit unavailable.'; end if;
 if v.updated_at is distinct from p_expected_updated_at then raise exception 'This audit changed. Reopen the report before saving.'; end if;
 if not v.assignment_verified or v.assigned_to is distinct from p_actor_id then raise exception 'Only the assigned auditor may submit findings.'; end if;
 if v.started_at is null or v.status_code not in ('in_progress','under_review','awaiting_station_response') then raise exception 'Start the audit before submitting findings.'; end if;

 if exists (
  select 1 from public.ops_audit_checklist_items i
  where i.company_id=p_company_id and i.audit_type_id=v.audit_type_id and i.is_active and (i.photo_required or (i.photo_on_non_compliance and exists(select 1 from jsonb_array_elements(p_checks) c where c->>'checklist_item_id'=i.id::text and c->>'is_compliant'='false')))
  and not exists(select 1 from public.ops_station_audit_evidence e where e.company_id=p_company_id and e.audit_id=v.id and e.checklist_item_id=i.id and e.evidence_kind_code='checklist_photo' and e.content_type in ('image/jpeg','image/png','image/webp','image/heic','image/heif'))
 ) then raise exception 'Attach a photo to every safety and hygiene check, including compliant answers.'; end if;
 if exists(select 1 from public.ops_audit_types where id=v.audit_type_id and shipment_reconciliation_enabled) and (p_patch->'shipment_reconciliation' is null or p_patch->'shipment_reconciliation'='null'::jsonb) then raise exception 'Complete the ERP list and physical scan reconciliation.'; end if;
 select to_jsonb(l) into old_lists from public.ops_audit_shipment_lists l where audit_id=v.id;
 if p_patch->'shipment_reconciliation' is not null and p_patch->'shipment_reconciliation'<>'null'::jsonb then
  insert into public.ops_audit_shipment_lists(audit_id,company_id,expected,scanned,recorded_by)
  values(v.id,p_company_id,array(select jsonb_array_elements_text(p_patch->'shipment_reconciliation'->'expected')),array(select jsonb_array_elements_text(p_patch->'shipment_reconciliation'->'scanned')),p_actor_id)
  on conflict(audit_id) do update set expected=excluded.expected,scanned=excluded.scanned,recorded_by=excluded.recorded_by,recorded_at=now();
 end if;
 n=jsonb_populate_record(v,p_patch);
 update public.ops_station_audits set status_code=n.status_code,station_response_status=n.station_response_status,response_due_at=n.response_due_at,
 system_cash_amount=n.system_cash_amount,physical_cash_amount=n.physical_cash_amount,cash_variance_amount=n.cash_variance_amount,cash_variance_reason=n.cash_variance_reason,
 system_shipment_count=n.system_shipment_count,physical_shipment_count=n.physical_shipment_count,shipment_missing_count=n.shipment_missing_count,shipment_excess_count=n.shipment_excess_count,shipment_unresolved_count=n.shipment_unresolved_count,
 video_call_url=n.video_call_url,video_call_verified_at=n.video_call_verified_at,overall_summary=n.overall_summary,manager_summary=n.manager_summary,
 completed_at=coalesce(v.completed_at,now()),completed_by=coalesce(v.completed_by,p_actor_id),updated_at=now() where id=v.id;
 insert into public.ops_station_audit_events(company_id,audit_id,event_type,before_data,after_data,actor_user_id,actor_name,actor_email,actor_role)
 values(p_company_id,v.id,case when v.completed_at is null then 'submitted' else 'amended' end,
 jsonb_build_object('report',to_jsonb(v),'shipment_lists',old_lists,'checks',(select jsonb_agg(c) from public.ops_station_audit_check_responses c where c.audit_id=v.id),'shipments',(select jsonb_agg(s) from public.ops_station_audit_shipments s where s.audit_id=v.id),'cash',(select jsonb_agg(c) from public.ops_station_audit_cash_counts c where c.audit_id=v.id)),p_patch,p_actor_id,p_actor_name,p_actor_email,p_actor_role);
 delete from public.ops_station_audit_check_responses where company_id=p_company_id and audit_id=v.id;
 insert into public.ops_station_audit_check_responses(company_id,audit_id,checklist_item_id,response_value,is_compliant,remarks,response_source,responded_by) select p_company_id,v.id,c.checklist_item_id,c.response_value,c.is_compliant,c.remarks,c.response_source,c.responded_by from jsonb_populate_recordset(null::public.ops_station_audit_check_responses,coalesce(p_checks,'[]'::jsonb)) c;
 delete from public.ops_station_audit_cash_counts where company_id=p_company_id and audit_id=v.id;
 insert into public.ops_station_audit_cash_counts(company_id,audit_id,cash_side,denomination_option_id,denomination_value,note_count) select p_company_id,v.id,c.cash_side,c.denomination_option_id,c.denomination_value,c.note_count from jsonb_populate_recordset(null::public.ops_station_audit_cash_counts,coalesce(p_counts,'[]'::jsonb)) c;
 delete from public.ops_station_audit_shipments where company_id=p_company_id and audit_id=v.id;
 insert into public.ops_station_audit_shipments(company_id,audit_id,tracking_id,system_status_code,physical_status_code,discrepancy_code,remarks,required_action,due_at) select p_company_id,v.id,c.tracking_id,c.system_status_code,c.physical_status_code,c.discrepancy_code,c.remarks,c.required_action,c.due_at from jsonb_populate_recordset(null::public.ops_station_audit_shipments,coalesce(p_shipments,'[]'::jsonb)) c;
 delete from public.ops_station_audit_actions where company_id=p_company_id and audit_id=v.id and status_code='open';
 insert into public.ops_station_audit_actions(company_id,audit_id,checklist_item_id,title,corrective_action,preventive_action,severity_code,status_code,owner_user_id,owner_name,owner_email,due_at,created_by) select p_company_id,v.id,c.checklist_item_id,c.title,c.corrective_action,c.preventive_action,c.severity_code,c.status_code,c.owner_user_id,c.owner_name,c.owner_email,c.due_at,c.created_by from jsonb_populate_recordset(null::public.ops_station_audit_actions,coalesce(p_actions,'[]'::jsonb)) c;
 insert into public.ops_station_audit_evidence(company_id,audit_id,evidence_kind_code,file_name,media_url,caption,uploaded_by) select p_company_id,v.id,c.evidence_kind_code,c.file_name,c.media_url,c.caption,c.uploaded_by from jsonb_populate_recordset(null::public.ops_station_audit_evidence,coalesce(p_evidence,'[]'::jsonb)) c;
end; $$;
revoke all on function public.submit_station_audit_report(uuid,uuid,timestamptz,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.submit_station_audit_report(uuid,uuid,timestamptz,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid,text,text,text) to service_role;
