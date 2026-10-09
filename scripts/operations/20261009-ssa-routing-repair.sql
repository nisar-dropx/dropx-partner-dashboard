-- Reviewed one-time routing repair for existing DropX One SSA requests.
-- Run only after the SSA station-manager resolver is deployed. No approval is
-- granted here: earlier decisions remain, unresolved TL steps are skipped, and
-- the existing CM/AOM step (or HR after an already-approved manager) takes over.
-- The station snapshot is a guard for this repair, not application configuration.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $repair$
declare
  company uuid := '43866344-b550-4e8a-9a2d-9d23f3d8a997';
  station_managers jsonb := '[{"station_id":"cf439d21-6d3f-451b-8301-99ef5e56f61d","person_id":"b7d8137d-6973-4e92-ad95-b233d4dfd48e","user_id":"d4485a4a-9072-4fea-8763-1ea9527f3e89"},{"station_id":"f19aa4d9-ee28-4c77-8a2a-1a60111065c0","person_id":"52bc480e-8010-4e64-b86e-ccd6cae5bf1b","user_id":"53216c47-1e77-4314-8e8c-e6b177df6751"},{"station_id":"1088134c-c784-4651-9f04-b42686579b64","person_id":"52bc480e-8010-4e64-b86e-ccd6cae5bf1b","user_id":"53216c47-1e77-4314-8e8c-e6b177df6751"},{"station_id":"138d40d5-2628-4648-a5e8-9cdb188d0a5b","person_id":"b7d8137d-6973-4e92-ad95-b233d4dfd48e","user_id":"d4485a4a-9072-4fea-8763-1ea9527f3e89"},{"station_id":"dea6c1af-6bb9-4081-9b2d-74de6d48bf6b","person_id":"63875e4d-171f-489c-8b71-d98ac6c6e61f","user_id":"09ac9012-fcc3-4f90-a49c-38938b6e53bf"},{"station_id":"507ea7d7-826e-4673-8d8f-c8e2daaebc24","person_id":"63875e4d-171f-489c-8b71-d98ac6c6e61f","user_id":"09ac9012-fcc3-4f90-a49c-38938b6e53bf"},{"station_id":"df806e3c-1d3a-4f41-81de-39472e1f1551","person_id":"63875e4d-171f-489c-8b71-d98ac6c6e61f","user_id":"09ac9012-fcc3-4f90-a49c-38938b6e53bf"},{"station_id":"5735ab5d-67af-4d6f-ae7b-96c437da796b","person_id":"04267170-1b09-4754-aff2-198dc73343b8","user_id":"16023ab1-7de6-48b6-b651-541d93381f26"},{"station_id":"5d87e6f6-888a-478c-afb2-453ae94b67fb","person_id":"fb823b56-9200-41fc-a5cb-dc2cc14f74e0","user_id":"30f90187-177a-4fc1-97fa-d641d7a03ac4"},{"station_id":"60739b41-7556-4015-87cd-7a2c130e030e","person_id":"fb823b56-9200-41fc-a5cb-dc2cc14f74e0","user_id":"30f90187-177a-4fc1-97fa-d641d7a03ac4"},{"station_id":"f2a68194-8b31-4f68-aace-3a710298ac8d","person_id":"0104e6c5-6e8c-4e6b-9e27-a2664d81733b","user_id":"c2ce82ff-1431-49fd-a2bc-f15decdbf848"},{"station_id":"2f17dd94-bfca-4dc3-9411-777cbe5be3ec","person_id":"b7d8137d-6973-4e92-ad95-b233d4dfd48e","user_id":"d4485a4a-9072-4fea-8763-1ea9527f3e89"},{"station_id":"44bfa9cb-a353-4886-8cc6-7b41890232fa","person_id":"fb823b56-9200-41fc-a5cb-dc2cc14f74e0","user_id":"30f90187-177a-4fc1-97fa-d641d7a03ac4"},{"station_id":"9ae9a7c6-b236-453a-bd22-dbb3afe130db","person_id":"0104e6c5-6e8c-4e6b-9e27-a2664d81733b","user_id":"c2ce82ff-1431-49fd-a2bc-f15decdbf848"},{"station_id":"4a718663-ed64-46c8-9cf7-fb29c0da61e9","person_id":"52bc480e-8010-4e64-b86e-ccd6cae5bf1b","user_id":"53216c47-1e77-4314-8e8c-e6b177df6751"},{"station_id":"81f6abc1-04df-482c-8672-e9109c36322e","person_id":"04267170-1b09-4754-aff2-198dc73343b8","user_id":"16023ab1-7de6-48b6-b651-541d93381f26"},{"station_id":"6ffa107c-c1cd-49fe-9f59-015f31fb9c6c","person_id":"52bc480e-8010-4e64-b86e-ccd6cae5bf1b","user_id":"53216c47-1e77-4314-8e8c-e6b177df6751"},{"station_id":"e143974c-5a08-4710-8310-965ad6d581e0","person_id":"52bc480e-8010-4e64-b86e-ccd6cae5bf1b","user_id":"53216c47-1e77-4314-8e8c-e6b177df6751"},{"station_id":"48b3e3a3-d608-42b0-8ce9-80da9d9cc39e","person_id":"04b4761c-4bc4-47cf-9ae6-b9e2dca983fc","user_id":"9088c04b-c457-47a2-a456-a500addd2de4"},{"station_id":"4750e746-8dc6-47bd-aa19-95ca3444fd90","person_id":"04b4761c-4bc4-47cf-9ae6-b9e2dca983fc","user_id":"9088c04b-c457-47a2-a456-a500addd2de4"},{"station_id":"4bbcd376-605f-4460-a99c-2ae651f863e4","person_id":"04267170-1b09-4754-aff2-198dc73343b8","user_id":"16023ab1-7de6-48b6-b651-541d93381f26"},{"station_id":"433c455c-9ef1-446f-8a88-bc262e74137c","person_id":"0104e6c5-6e8c-4e6b-9e27-a2664d81733b","user_id":"c2ce82ff-1431-49fd-a2bc-f15decdbf848"},{"station_id":"1a1e94db-2615-4971-bc0c-e0e0f2aad335","person_id":"04b4761c-4bc4-47cf-9ae6-b9e2dca983fc","user_id":"9088c04b-c457-47a2-a456-a500addd2de4"},{"station_id":"6b656352-0462-4ea5-b0ef-1c2942333557","person_id":"fb823b56-9200-41fc-a5cb-dc2cc14f74e0","user_id":"30f90187-177a-4fc1-97fa-d641d7a03ac4"},{"station_id":"d646e5ae-316d-4787-b586-164ce1eb9e1f","person_id":"0104e6c5-6e8c-4e6b-9e27-a2664d81733b","user_id":"c2ce82ff-1431-49fd-a2bc-f15decdbf848"},{"station_id":"526197a3-da51-4509-9b5f-8f40b6029d11","person_id":"fb823b56-9200-41fc-a5cb-dc2cc14f74e0","user_id":"30f90187-177a-4fc1-97fa-d641d7a03ac4"},{"station_id":"c8d0c5ff-85b8-490f-97bc-b74eb079d9ec","person_id":"04267170-1b09-4754-aff2-198dc73343b8","user_id":"16023ab1-7de6-48b6-b651-541d93381f26"},{"station_id":"affd0714-decc-424d-879d-7ade962e081c","person_id":"b7d8137d-6973-4e92-ad95-b233d4dfd48e","user_id":"d4485a4a-9072-4fea-8763-1ea9527f3e89"},{"station_id":"95ec0bce-4ba2-4f08-bfec-ea8bcdb9272a","person_id":"04267170-1b09-4754-aff2-198dc73343b8","user_id":"16023ab1-7de6-48b6-b651-541d93381f26"},{"station_id":"f19be65c-8b89-43c2-8579-29ac1783431a","person_id":"0104e6c5-6e8c-4e6b-9e27-a2664d81733b","user_id":"c2ce82ff-1431-49fd-a2bc-f15decdbf848"},{"station_id":"1313184d-3a06-4628-9a20-200553a34bf2","person_id":"63875e4d-171f-489c-8b71-d98ac6c6e61f","user_id":"09ac9012-fcc3-4f90-a49c-38938b6e53bf"},{"station_id":"fd569a1c-50ae-4712-84b7-6c56e725cee3","person_id":"04267170-1b09-4754-aff2-198dc73343b8","user_id":"16023ab1-7de6-48b6-b651-541d93381f26"},{"station_id":"6ce85e7e-d5c4-4577-960f-7a6f35f341b7","person_id":"0104e6c5-6e8c-4e6b-9e27-a2664d81733b","user_id":"c2ce82ff-1431-49fd-a2bc-f15decdbf848"},{"station_id":"9d6cad67-aa58-49ff-a0ea-a3047ea2fa11","person_id":"fb823b56-9200-41fc-a5cb-dc2cc14f74e0","user_id":"30f90187-177a-4fc1-97fa-d641d7a03ac4"}]'::jsonb;
  item record;
  attendance_count integer := 0;
  hr_count integer := 0;
  leave_count integer := 0;
  swap_count integer := 0;
begin
  if exists (
    select 1 from jsonb_to_recordset(station_managers) as m(station_id uuid,person_id uuid,user_id uuid)
    where not exists (
      select 1 from hr_user_person_links l
      join profiles p on p.id=l.user_id and p.company_id=l.company_id and p.is_active
      join hr_engagements e on e.person_id=l.person_id and e.company_id=l.company_id and e.status='active'
      join hr_work_assignments a on a.engagement_id=e.id and a.company_id=e.company_id and a.is_primary
        and a.effective_from<=current_date and (a.effective_to is null or a.effective_to>=current_date)
      join designations d on d.id=a.designation_id and d.company_id=a.company_id and d.code in ('CLM','CM','AOM')
      where l.company_id=company and l.status='active' and l.person_id=m.person_id and l.user_id=m.user_id
    )
  ) then raise exception 'A station manager mapping or login changed; re-audit'; end if;
  -- Freeze current request rows before inspecting their unresolved steps.
  for item in
    select distinct r.id, r.status, s.id as old_step_id, target.id as manager_step_id,
      target.status as manager_status, target.approver_person_id
    from attendance_regularization_requests r
    join hr_engagements e on e.company_id=r.company_id and e.worker_type=r.profile_type
      and coalesce(e.employee_id,e.contractor_id)=r.profile_id and e.status='active'
    join hr_work_assignments a on a.company_id=e.company_id and a.engagement_id=e.id and a.is_primary
      and a.effective_from<=current_date and (a.effective_to is null or a.effective_to>=current_date)
    join designations d on d.company_id=a.company_id and d.id=a.designation_id and d.code='SSA'
    join jsonb_to_recordset(station_managers) as m(station_id uuid,person_id uuid,user_id uuid) on m.station_id=a.location_id
    join attendance_regularization_approval_steps s on s.company_id=r.company_id and s.request_id=r.id and s.status='pending'
    join hr_engagements me on me.company_id=s.company_id and me.person_id=s.approver_person_id and me.status='active'
    join hr_work_assignments ma on ma.company_id=me.company_id and ma.engagement_id=me.id and ma.is_primary
      and ma.effective_from<=current_date and (ma.effective_to is null or ma.effective_to>=current_date)
    join designations md on md.company_id=ma.company_id and md.id=ma.designation_id and md.code='TL'
    join attendance_regularization_approval_steps target on target.company_id=r.company_id and target.request_id=r.id
      and target.approver_person_id=m.person_id and target.approver_user_id=m.user_id and target.status in ('queued','approved')
    where r.company_id=company and r.status='pending_manager'
  loop
    perform 1 from attendance_regularization_requests where id=item.id and company_id=company and status='pending_manager' for update;
    if not found then raise exception 'Attendance request changed during routing repair'; end if;
    update attendance_regularization_approval_steps
      set status='skipped', decided_at=now(), decision_note='Routing correction: SSA requests belong to the station Cluster Manager, or AOM when no Cluster Manager is mapped. No approval decision made.'
      where id=item.old_step_id and company_id=company and request_id=item.id and status='pending';
    if not found then raise exception 'Attendance TL step changed during routing repair'; end if;
    if item.manager_status='queued' then
      update attendance_regularization_approval_steps set status='pending'
        where id=item.manager_step_id and company_id=company and request_id=item.id and status='queued';
      if not found then raise exception 'Attendance manager step changed during routing repair'; end if;
    else
      if exists (select 1 from attendance_regularization_approval_steps where request_id=item.id and company_id=company and status in ('pending','queued')) then
        raise exception 'Unexpected unresolved step after previous manager approval';
      end if;
      update attendance_regularization_requests set status='pending_hr',updated_at=now()
        where id=item.id and company_id=company and status='pending_manager';
      hr_count := hr_count+1;
    end if;
    attendance_count := attendance_count+1;
  end loop;

  for item in
    select r.id,s.id old_step_id,target.id manager_step_id
    from hr_leave_requests r
    join hr_engagements e on e.company_id=r.company_id and e.status='active'
      and ((e.worker_type='employee' and e.employee_id=r.employee_id) or (e.worker_type='contractor' and e.contractor_id=r.contractor_id))
    join hr_work_assignments a on a.company_id=e.company_id and a.engagement_id=e.id and a.is_primary
      and a.effective_from<=current_date and (a.effective_to is null or a.effective_to>=current_date)
    join designations d on d.company_id=a.company_id and d.id=a.designation_id and d.code='SSA'
    join jsonb_to_recordset(station_managers) as m(station_id uuid,person_id uuid,user_id uuid) on m.station_id=a.location_id
    join hr_leave_approval_steps s on s.company_id=r.company_id and s.request_id=r.id and s.status='pending' and s.step_name='Team Lead approval'
    join hr_leave_approval_steps target on target.company_id=r.company_id and target.request_id=r.id
      and target.approver_person_id=m.person_id and target.approver_user_id=m.user_id and target.status='queued'
    where r.company_id=company and r.status='pending'
  loop
    perform 1 from hr_leave_requests where id=item.id and company_id=company and status='pending' for update;
    if not found then raise exception 'Leave request changed during routing repair'; end if;
    update hr_leave_approval_steps set status='skipped',decided_at=now(),
      decision_note='Routing correction: SSA requests go directly to the station Cluster Manager, or AOM when no Cluster Manager is mapped. No approval decision made.'
      where id=item.old_step_id and company_id=company and request_id=item.id and status='pending';
    if not found then raise exception 'Leave TL step changed during routing repair'; end if;
    update hr_leave_approval_steps set status='pending'
      where id=item.manager_step_id and company_id=company and request_id=item.id and status='queued';
    if not found then raise exception 'Leave manager step changed during routing repair'; end if;
    leave_count := leave_count+1;
  end loop;

  for item in
    select r.id,r.approver_user_id as old_user_id,m.user_id
    from hr_roster_swap_requests r
    join hr_engagements e on e.company_id=r.company_id and e.worker_type=r.requester_worker_type
      and coalesce(e.employee_id,e.contractor_id)=r.requester_worker_id and e.status='active'
    join hr_work_assignments a on a.company_id=e.company_id and a.engagement_id=e.id and a.is_primary
      and a.effective_from<=current_date and (a.effective_to is null or a.effective_to>=current_date)
    join designations d on d.company_id=a.company_id and d.id=a.designation_id and d.code='SSA'
    join jsonb_to_recordset(station_managers) as m(station_id uuid,person_id uuid,user_id uuid) on m.station_id=a.location_id
    where r.company_id=company and r.status in ('pending_partner','pending_manager') and r.approver_user_id<>m.user_id
  loop
    update hr_roster_swap_requests set approver_user_id=item.user_id,updated_at=now(),
      manager_note=concat_ws(E'\n',nullif(manager_note,''),'Routing correction: SSA manager approval reassigned from '||item.old_user_id||' to the station Cluster Manager/AOM. No decision made.')
      where id=item.id and company_id=company and status in ('pending_partner','pending_manager') and approver_user_id=item.old_user_id;
    if not found then raise exception 'Roster swap changed during routing repair'; end if;
    swap_count := swap_count+1;
  end loop;

  -- Reflect the corrected leave seat in the existing approval master.
  update hr_approval_workflow_routes r set
    level_1_designation_id=cm.id,level_1_search_scope='manager_above_team_lead',
    level_2_required=false,level_2_designation_id=null,updated_at=now()
    from designations requester,designations cm,designations previous
    where r.company_id=company and r.is_active and r.workflow_code='leave_request'
      and requester.company_id=company and requester.id=r.requester_designation_id and requester.code='SSA'
      and cm.company_id=company and cm.code='CLM' and cm.is_active
      and previous.company_id=company and previous.id=r.level_1_designation_id and previous.code='TL'
      and r.level_2_designation_id=cm.id and r.level_2_required;
  if not found then raise exception 'SSA leave route changed; re-audit'; end if;

  if attendance_count<>166 or hr_count<>20 or leave_count<>1 or swap_count<>8 then
    raise exception 'Queue changed; re-audit before applying. Attendance %, HR %, leave %, swaps %',attendance_count,hr_count,leave_count,swap_count;
  end if;
end;
$repair$;
commit;
