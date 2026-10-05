-- Attach inspection photos to the exact checklist item; legacy evidence remains intact.
alter table public.ops_audit_checklist_items add column if not exists photo_required boolean not null default false;
alter table public.ops_station_audit_evidence add column if not exists checklist_item_id uuid references public.ops_audit_checklist_items(id);
alter table public.ops_station_audit_evidence add column if not exists content_type text;
create index if not exists ops_audit_evidence_check_idx on public.ops_station_audit_evidence(company_id,audit_id,checklist_item_id) where checklist_item_id is not null;

-- Replace the bundled facility question with specific inspectable checks; preserve its old answers.
update public.ops_audit_checklist_items i set is_active=false from public.ops_audit_types t where i.audit_type_id=t.id and t.code='physical_station' and i.code='facility_hygiene';
update public.ops_audit_checklist_items i set section_id=s.id,label='Visitor access and staff entry controls are followed',guidance='Check the visitor register, authorized access and staff entry procedure. Record any gap without photographing personal identity documents.' from public.ops_audit_types t,public.ops_audit_checklist_sections s where i.audit_type_id=t.id and s.audit_type_id=t.id and t.code='physical_station' and s.code='operations' and i.code='staff_hygiene';
with definitions(code,label,guidance,sort_order) as (values
('wet_mopping','Floors are wet-mopped and clean','Inspect the floor, corners and under racks for dirt, spills and standing water. Confirm wet mopping against the latest cleaning entry; photograph the floor and cleaning record.',10),
('station_dust','Station surfaces and racks are dust-free','Inspect sorting tables, racks, shelves, corners and window ledges. Photograph representative surfaces, including any dust build-up.',20),
('it_assets_clean','Systems, laptops and printers are dust-free','Inspect desktops, laptops, keyboards, monitors and printers, including vents. Add clear photos covering the equipment present; do not expose passwords or personal records.',30),
('fans_clean','Fans and ventilation are dust-free','Inspect fan blades, guards and ventilation grilles. Photograph them safely from ground level; do not touch running equipment.',40),
('waste_control','Waste bins and work areas are clean','Check bins are emptied, waste is segregated and no food waste, pests or stagnant water is visible. Photograph bins and the waste area.',50),
('washroom_toilet_clean','Toilets and washroom floors are clean','Inspect toilet pan/seat, floor, walls and drains for stains, waste, leakage and odour. Photograph the empty washroom; never photograph a person using it.',60),
('washroom_water_soap','Washroom has water, soap and working drainage','Check water supply, handwash/soap, washbasin and drains. Photograph facilities and supplies; record any missing or non-working item.',70),
('washroom_cleaning_frequency','Washroom cleaning is recorded at least twice a week','Verify at least two dated cleaning entries in the latest completed seven days. Record those dates in Observation and photograph the dated cleaning log. If the record is missing or frequency is lower, mark non-compliant.',80),
('first_aid','First-aid kit is accessible, stocked and in date','Photograph the open kit and visible expiry labels. Check the required supplies are present and access is unobstructed.',110),
('electrical_safety','Electrical points and cables are safe','Inspect for exposed wires, damaged plugs, overloaded sockets and cables across walkways. Photograph the points checked; isolate hazards through the station team.',120)
)
insert into public.ops_audit_checklist_items(company_id,audit_type_id,section_id,code,label,guidance,response_type,is_required,evidence_rule,action_rule,default_severity_code,sort_order,photo_required)
select t.company_id,t.id,s.id,d.code,d.label,d.guidance,'pass_fail_na',true,'always','on_non_compliance','medium',d.sort_order,true from public.ops_audit_types t join public.ops_audit_checklist_sections s on s.audit_type_id=t.id and s.code='safety_hygiene' cross join definitions d where t.code='physical_station'
on conflict(audit_type_id,code) do update set label=excluded.label,guidance=excluded.guidance,section_id=excluded.section_id,sort_order=excluded.sort_order,is_active=true,is_required=true,evidence_rule='always',photo_required=true;
update public.ops_audit_checklist_items i set
 photo_required=true,evidence_rule='always',is_required=true,
 response_options='[{"value":"pass","label":"Compliant","is_compliant":true,"requires_evidence":true},{"value":"fail","label":"Non-compliant","is_compliant":false,"requires_action":true,"requires_evidence":true},{"value":"na","label":"Not applicable — explain","requires_evidence":true}]'::jsonb,
 sort_order=case i.code when 'five_s' then 90 when 'fire_safety' then 100 when 'equipment' then 130 else i.sort_order end,
 guidance=case i.code
 when 'five_s' then 'Check labelled storage, segregation, station markings and clear aisles/exits. Photograph the storage layout and access routes.'
 when 'fire_safety' then 'Check extinguishers are accessible, within their service date, with a readable gauge/seal and visible PASS instructions. Photograph equipment, service labels and unobstructed access.'
 when 'equipment' then 'Check scanners, weighing scales, printers and essential station equipment actually work. Photograph equipment checked and note any unavailable or faulty asset.' else i.guidance end
from public.ops_audit_checklist_sections s join public.ops_audit_types t on t.id=s.audit_type_id
where i.section_id=s.id and s.code='safety_hygiene' and t.code='physical_station' and i.is_active;
update public.ops_audit_checklist_sections s set guidance='Inspect each item on site. A photo is mandatory for every outcome, including compliant, non-compliant and not applicable. Use observations to explain gaps; non-compliance also needs a corrective action. Photos are linked to the individual check.' from public.ops_audit_types t where t.id=s.audit_type_id and t.code='physical_station' and s.code='safety_hygiene';

create or replace function public.submit_station_audit_report(p_company_id uuid,p_audit_id uuid,p_expected_updated_at timestamptz,p_patch jsonb,p_checks jsonb,p_counts jsonb,p_shipments jsonb,p_actions jsonb,p_evidence jsonb,p_actor_id uuid,p_actor_name text,p_actor_email text,p_actor_role text)
returns void language plpgsql security invoker set search_path='' as $$
declare v public.ops_station_audits%rowtype; n public.ops_station_audits%rowtype;
begin
 select * into v from public.ops_station_audits where id=p_audit_id and company_id=p_company_id and deleted_at is null for update;
 if not found then raise exception 'Audit unavailable.'; end if;
 if v.updated_at is distinct from p_expected_updated_at then raise exception 'This audit changed. Reopen the report before saving.'; end if;
 if not v.assignment_verified or v.assigned_to is distinct from p_actor_id then raise exception 'Only the assigned auditor may submit findings.'; end if;
 if v.started_at is null or v.status_code not in ('in_progress','under_review','awaiting_station_response') then raise exception 'Start the audit before submitting findings.'; end if;

 if exists (
  select 1 from public.ops_audit_checklist_items i
  where i.company_id=p_company_id and i.audit_type_id=v.audit_type_id and i.is_active and i.photo_required
  and not exists(select 1 from public.ops_station_audit_evidence e where e.company_id=p_company_id and e.audit_id=v.id and e.checklist_item_id=i.id and e.evidence_kind_code='checklist_photo' and e.content_type in ('image/jpeg','image/png','image/webp','image/heic','image/heif'))
 ) then raise exception 'Attach a photo to every safety and hygiene check, including compliant answers.'; end if;
 n=jsonb_populate_record(v,p_patch);
 update public.ops_station_audits set status_code=n.status_code,station_response_status=n.station_response_status,response_due_at=n.response_due_at,
 system_cash_amount=n.system_cash_amount,physical_cash_amount=n.physical_cash_amount,cash_variance_amount=n.cash_variance_amount,cash_variance_reason=n.cash_variance_reason,
 system_shipment_count=n.system_shipment_count,physical_shipment_count=n.physical_shipment_count,shipment_missing_count=n.shipment_missing_count,shipment_excess_count=n.shipment_excess_count,shipment_unresolved_count=n.shipment_unresolved_count,
 video_call_url=n.video_call_url,video_call_verified_at=n.video_call_verified_at,overall_summary=n.overall_summary,manager_summary=n.manager_summary,
 completed_at=coalesce(v.completed_at,now()),completed_by=coalesce(v.completed_by,p_actor_id),updated_at=now() where id=v.id;
 insert into public.ops_station_audit_events(company_id,audit_id,event_type,before_data,after_data,actor_user_id,actor_name,actor_email,actor_role)
 values(p_company_id,v.id,case when v.completed_at is null then 'submitted' else 'amended' end,
 jsonb_build_object('report',to_jsonb(v),'checks',(select jsonb_agg(c) from public.ops_station_audit_check_responses c where c.audit_id=v.id),'cash',(select jsonb_agg(c) from public.ops_station_audit_cash_counts c where c.audit_id=v.id)),p_patch,p_actor_id,p_actor_name,p_actor_email,p_actor_role);
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
