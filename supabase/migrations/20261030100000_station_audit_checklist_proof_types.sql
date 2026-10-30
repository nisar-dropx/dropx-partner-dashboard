-- Station audit submit: accept the same checklist proof types the OpsPulse UI allows.
-- Mandatory photo_required checks still need an image. Non-compliance proof may be
-- image, PDF, Excel or CSV (e.g. missing-TID Excel on findings). Error text now names
-- the missing checks instead of the old hygiene-only wording.
CREATE OR REPLACE FUNCTION public.submit_station_audit_report(p_company_id uuid, p_audit_id uuid, p_expected_updated_at timestamp with time zone, p_patch jsonb, p_checks jsonb, p_counts jsonb, p_shipments jsonb, p_actions jsonb, p_evidence jsonb, p_actor_id uuid, p_actor_name text, p_actor_email text, p_actor_role text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v public.ops_station_audits%rowtype; n public.ops_station_audits%rowtype; old_lists jsonb;
begin
 select * into v from public.ops_station_audits where id=p_audit_id and company_id=p_company_id and deleted_at is null for update;
 if not found then raise exception 'Audit unavailable.'; end if;
 if v.updated_at is distinct from p_expected_updated_at then raise exception 'This audit changed. Reopen the report before saving.'; end if;
 if not v.assignment_verified or v.assigned_to is distinct from p_actor_id then raise exception 'Only the assigned auditor may submit findings.'; end if;
 if v.started_at is null or v.status_code not in ('in_progress','under_review','awaiting_station_response') then raise exception 'Start the audit before submitting findings.'; end if;

 if exists (
  select 1 from public.ops_audit_checklist_items i
  where i.company_id=p_company_id and i.audit_type_id=v.audit_type_id and i.is_active
    and (
      i.photo_required
      or (
        i.photo_on_non_compliance
        and exists (
          select 1 from jsonb_array_elements(p_checks) c
          where c->>'checklist_item_id'=i.id::text and c->>'is_compliant'='false'
        )
      )
    )
    and not exists (
      select 1 from public.ops_station_audit_evidence e
      where e.company_id=p_company_id and e.audit_id=v.id and e.checklist_item_id=i.id
        and e.evidence_kind_code='checklist_photo'
        and (
          (i.photo_required and e.content_type in ('image/jpeg','image/png','image/webp','image/heic','image/heif'))
          or (
            not i.photo_required
            and e.content_type in (
              'image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf',
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'application/vnd.ms-excel','text/csv'
            )
          )
        )
    )
 ) then
  raise exception 'Attach proof for: %. Mandatory photo checks need a JPG/PNG/WEBP/HEIC image; non-compliance checks also accept PDF, Excel or CSV.',
    (
      select string_agg(i.label, '; ' order by i.sort_order, i.label)
      from public.ops_audit_checklist_items i
      where i.company_id=p_company_id and i.audit_type_id=v.audit_type_id and i.is_active
        and (
          i.photo_required
          or (
            i.photo_on_non_compliance
            and exists (
              select 1 from jsonb_array_elements(p_checks) c
              where c->>'checklist_item_id'=i.id::text and c->>'is_compliant'='false'
            )
          )
        )
        and not exists (
          select 1 from public.ops_station_audit_evidence e
          where e.company_id=p_company_id and e.audit_id=v.id and e.checklist_item_id=i.id
            and e.evidence_kind_code='checklist_photo'
            and (
              (i.photo_required and e.content_type in ('image/jpeg','image/png','image/webp','image/heic','image/heif'))
              or (
                not i.photo_required
                and e.content_type in (
                  'image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf',
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                  'application/vnd.ms-excel','text/csv'
                )
              )
            )
        )
    );
 end if;
 if exists(select 1 from public.ops_audit_types where id=v.audit_type_id and shipment_reconciliation_enabled) and (p_patch->'shipment_reconciliation' is null or p_patch->'shipment_reconciliation'='null'::jsonb) then raise exception 'Complete the ERP list and physical scan reconciliation.'; end if;
 select to_jsonb(l) into old_lists from public.ops_audit_shipment_lists l where audit_id=v.id;
 if p_patch->'shipment_reconciliation' is not null and p_patch->'shipment_reconciliation'<>'null'::jsonb then
  insert into public.ops_audit_shipment_lists(audit_id,company_id,expected,scanned,recorded_by)
  values(v.id,p_company_id,array(select jsonb_array_elements_text(p_patch->'shipment_reconciliation'->'expected')),array(select jsonb_array_elements_text(p_patch->'shipment_reconciliation'->'scanned')),p_actor_id)
  on conflict(audit_id) do update set expected=excluded.expected,scanned=excluded.scanned,recorded_by=excluded.recorded_by,recorded_at=now();
 end if;
 n=jsonb_populate_record(v,p_patch);
 update public.ops_station_audits set status_code=n.status_code,station_response_status=n.station_response_status,response_due_at=n.response_due_at,
 score=n.score,score_snapshot=n.score_snapshot,system_cash_amount=n.system_cash_amount,physical_cash_amount=n.physical_cash_amount,cash_variance_amount=n.cash_variance_amount,cash_variance_reason=n.cash_variance_reason,
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
end; $function$

