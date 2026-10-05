-- Retain reports/evidence when an authorized leader removes an audit from work queues.
alter table public.ops_station_audits add column if not exists deleted_at timestamptz,
 add column if not exists deleted_by uuid, add column if not exists deletion_reason text,
 add column if not exists assignment_verified boolean not null default false,
 add column if not exists cash_variance_reason text, add column if not exists email_error text;
alter table public.ops_station_audits drop constraint if exists ops_station_audits_company_id_audit_type_id_location_id_cyc_key;
create unique index if not exists ops_station_audit_live_slot on public.ops_station_audits(company_id,audit_type_id,location_id,cycle_key,period_slot) where deleted_at is null;
create index if not exists ops_station_audit_personal_queue on public.ops_station_audits(company_id,assigned_to,scheduled_for) where deleted_at is null;
-- Only verify an old assignment when its stored identity agrees exactly with its user.
update public.ops_station_audits a set assignment_verified=true
from public.profiles p where p.id=a.assigned_to and p.company_id=a.company_id and p.is_active
 and lower(regexp_replace(a.assigned_name,'[^a-zA-Z0-9]','','g'))=lower(regexp_replace(p.full_name,'[^a-zA-Z0-9]','','g'));
-- Keep existing appointments; revised windows govern new bookings and changes.
update public.ops_audit_types set cadence_unit='monthly',required_count=3,
 scheduling_config=scheduling_config || '{"period_slots":[{"code":"cod_1","label":"COD audit 1","start_day":1,"end_day":10},{"code":"cod_2","label":"COD audit 2","start_day":11,"end_day":20},{"code":"cod_3","label":"COD audit 3","start_day":21,"end_day":31}]}'::jsonb
where code='virtual_cod';
update public.ops_audit_reference_options set is_active=false where option_group='cash_denomination' and (code='2000' or metadata->>'value'='2000');
-- These facts are captured by the cash/proof form; do not ask the auditor to repeat them.
update public.ops_audit_checklist_items set is_active=false where code in ('system_cash','physical_cash','cash_match','system_screenshots','video_recording','cash_system_value','cash_physical_value');

create or replace function public.manage_station_audit(p_company_id uuid,p_audit_id uuid,p_operation text,p_expected_updated_at timestamptz,p_assigned_to uuid,p_reason text,p_actor_id uuid,p_actor_name text,p_actor_email text,p_actor_role text)
returns void language plpgsql security invoker set search_path='' as $$
declare v public.ops_station_audits%rowtype; target public.profiles%rowtype; before_value jsonb;
begin
 select * into v from public.ops_station_audits where id=p_audit_id and company_id=p_company_id and deleted_at is null for update;
 if not found then raise exception 'Audit unavailable.'; end if;
 if v.updated_at is distinct from p_expected_updated_at then raise exception 'This audit changed. Refresh and try again.'; end if;
 if coalesce(length(trim(p_reason)),0)=0 or length(p_reason)>500 then raise exception 'Enter a reason up to 500 characters.'; end if;
 before_value=jsonb_build_object('assigned_to',v.assigned_to,'assigned_name',v.assigned_name,'status_code',v.status_code);
 if p_operation='delete' then
  if not exists(select 1 from public.profiles p where p.id=p_actor_id and p.company_id=p_company_id and p.is_active and (p.is_master_owner or exists(
   select 1 from public.company_product_memberships m join public.user_roles r on r.id=m.role_id and r.company_id=m.company_id and r.is_active
   where m.company_id=p_company_id and m.user_id=p.id and m.is_active and m.product_code='operations'
   and r.code in ('OPERATIONS_BH','OPERATIONS_HLM','OPERATIONS_SLPM','OPERATIONS_NH','OPERATIONS_NATIONAL_HEAD','NATIONAL_HEAD')
   and (m.has_all_location_access or r.location_access_mode='all_locations' or v.location_id=any(m.location_scope_ids)))))
  then raise exception 'Your role cannot delete audits.'; end if;
  update public.ops_station_audits set deleted_at=now(),deleted_by=p_actor_id,deletion_reason=trim(p_reason),updated_at=now() where id=v.id;
 elsif p_operation='reassign' then
  if v.started_at is not null or v.status_code<>'scheduled' then raise exception 'Only an unstarted audit can be reassigned.'; end if;
  select * into target from public.profiles where id=p_assigned_to and company_id=p_company_id and is_active;
  if not found then raise exception 'Choose an active auditor.'; end if;
  update public.ops_station_audits set assigned_to=target.id,assigned_name=target.full_name,assigned_email=target.email,assignment_verified=true,updated_at=now() where id=v.id;
 else raise exception 'Unknown audit action.';
 end if;
 insert into public.ops_station_audit_events(company_id,audit_id,event_type,before_data,after_data,actor_user_id,actor_name,actor_email,actor_role)
 values(p_company_id,v.id,case when p_operation='delete' then 'deleted' else 'reassigned' end,before_value,jsonb_build_object('reason',trim(p_reason),'assigned_to',p_assigned_to,'assigned_name',target.full_name),p_actor_id,p_actor_name,p_actor_email,p_actor_role);
end; $$;
revoke all on function public.manage_station_audit(uuid,uuid,text,timestamptz,uuid,text,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.manage_station_audit(uuid,uuid,text,timestamptz,uuid,text,uuid,text,text,text) to service_role;

-- Enforce date windows for all new bookings and reschedules, including direct service calls.
create or replace function public.check_station_audit_window() returns trigger language plpgsql security invoker set search_path='' as $$
declare t public.ops_audit_types%rowtype; s jsonb; d date; old_d date; first_day integer; last_day integer;
begin
 if new.deleted_at is not null then return new; end if;
 if tg_op='UPDATE' then
  if old.deleted_at is not null then raise exception 'Deleted audit is read-only.'; end if;
  if new.scheduled_for is not distinct from old.scheduled_for and new.period_slot is not distinct from old.period_slot then return new; end if;
 end if;
 select * into t from public.ops_audit_types where id=new.audit_type_id and company_id=new.company_id;
 if t.cadence_unit<>'monthly' then return new; end if;
 d=(new.scheduled_for at time zone 'Asia/Kolkata')::date;
 select value into s from jsonb_array_elements(t.scheduling_config->'period_slots') where value->>'code'=new.period_slot;
 if s is null then raise exception 'Choose a valid audit window.'; end if;
 first_day=coalesce((s->>'start_day')::integer,1); last_day=coalesce((s->>'end_day')::integer,31);
 if extract(day from d)<first_day or extract(day from d)>last_day then raise exception 'Audit date must stay within its configured window.'; end if;
 if tg_op='UPDATE' then
  old_d=(old.scheduled_for at time zone 'Asia/Kolkata')::date;
  if date_trunc('month',old_d)<>date_trunc('month',d) then raise exception 'Reschedule within the same month.'; end if;
  if extract(day from old_d)<first_day or extract(day from old_d)>last_day then raise exception 'Keep this audit in its original date window.'; end if;
 end if;
 perform pg_advisory_xact_lock(hashtextextended(new.company_id::text || new.audit_type_id::text || new.location_id::text || to_char(d,'YYYY-MM'),0));
 if exists(select 1 from public.ops_station_audits a where a.company_id=new.company_id and a.audit_type_id=new.audit_type_id and a.location_id=new.location_id and a.id<>new.id and a.deleted_at is null
 and date_trunc('month',a.scheduled_for at time zone 'Asia/Kolkata')=date_trunc('month',d)
 and extract(day from a.scheduled_for at time zone 'Asia/Kolkata') between first_day and last_day)
 then raise exception 'This station already has an audit in this date window. Open that audit to reschedule it.'; end if;
 return new;
end; $$;
revoke all on function public.check_station_audit_window() from public,anon,authenticated;
create trigger check_station_audit_window before insert or update of scheduled_for,period_slot on public.ops_station_audits for each row execute function public.check_station_audit_window();

-- Save the report, findings and evidence atomically: failed uploads/validation never mark an audit completed.
create or replace function public.submit_station_audit_report(p_company_id uuid,p_audit_id uuid,p_expected_updated_at timestamptz,p_patch jsonb,p_checks jsonb,p_counts jsonb,p_shipments jsonb,p_actions jsonb,p_evidence jsonb,p_actor_id uuid,p_actor_name text,p_actor_email text,p_actor_role text)
returns void language plpgsql security invoker set search_path='' as $$
declare v public.ops_station_audits%rowtype; n public.ops_station_audits%rowtype;
begin
 select * into v from public.ops_station_audits where id=p_audit_id and company_id=p_company_id and deleted_at is null for update;
 if not found then raise exception 'Audit unavailable.'; end if;
 if v.updated_at is distinct from p_expected_updated_at then raise exception 'This audit changed. Reopen the report before saving.'; end if;
 if not v.assignment_verified or v.assigned_to is distinct from p_actor_id then raise exception 'Only the assigned auditor may submit findings.'; end if;
 if v.started_at is null or v.status_code not in ('in_progress','under_review','awaiting_station_response') then raise exception 'Start the audit before submitting findings.'; end if;
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
