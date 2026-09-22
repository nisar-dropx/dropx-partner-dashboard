-- Reviewed, company-scoped repair. No approvals, amounts, bank details or paid
-- statuses are changed. Before-images are stored in payment_audit_events.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $$
declare
  company uuid := '43866344-b550-4e8a-9a2d-9d23f3d8a997';
  bh uuid := 'd3fa37d9-8c99-40f4-86cd-2aa147d2b8e7';
  nh uuid := '2271ea22-862b-424c-8d11-21c45d271fe8';
  finance uuid := 'cc42b07f-fbae-40ce-b1ea-2458242f5143';
  row_data record;
  manager_id uuid;
  matches integer;
  steps_count integer;
  initial_done boolean;
  changed integer := 0;
begin
  -- Split the six accidentally mixed single-stage heads into local review,
  -- then the existing Business/National Head final review. Preserve processors.
  for row_data in
    select h.id,h.code,to_jsonb(h) as head_before,to_jsonb(s) as step_before,s.id as step_id,s.candidates
    from payment_heads h join payment_head_approval_steps s on s.payment_head_id=h.id and s.company_id=h.company_id
    where h.company_id=company and h.code in ('BROADBAND','CEANING_EXP','DRINKING_WATER','ELECTRICITY','OFFICE_STATIONARY','VAN_FUEL')
      and s.step_order=1 and not exists(select 1 from payment_head_approval_steps x where x.payment_head_id=h.id and x.step_order>1)
  loop
    insert into payment_audit_events(event,actor_role,remarks) values('approval_master_corrected','SYSTEM_REPAIR',jsonb_build_object('reason','Separate station initial review from Business Head final review; user-authorized 2026-09-22','before_head',row_data.head_before,'before_step',row_data.step_before)::text);
    update payment_head_approval_steps set candidates=(select jsonb_agg(c || '{"scope":"station"}'::jsonb order by ord) from jsonb_array_elements(row_data.candidates) with ordinality a(c,ord) where (c->>'role_id')::uuid not in(bh,nh)),is_required=true,updated_at=now() where id=row_data.step_id;
    insert into payment_head_approval_steps(company_id,payment_head_id,step_order,candidates,is_required)
      values(company,row_data.id,2,jsonb_build_array(jsonb_build_object('role_id',bh,'scope','company'),jsonb_build_object('role_id',nh,'scope','company')),true);
    update payment_heads set initial_approval_role_ids=(select array_agg((c->>'role_id')::uuid order by ord) from jsonb_array_elements(row_data.candidates) with ordinality a(c,ord) where (c->>'role_id')::uuid not in(bh,nh)),initial_approval_role_id=(row_data.candidates->0->>'role_id')::uuid,final_approval_role_id=bh,final_approval_role_ids=array[bh,nh],updated_at=now() where id=row_data.id;
  end loop;
  -- A final-review role must not also be offered as initial review fallback.
  for row_data in select s.* from payment_head_approval_steps s where s.company_id=company and s.step_order=1
    and exists(select 1 from payment_head_approval_steps x where x.payment_head_id=s.payment_head_id and x.step_order>1)
    and exists(select 1 from jsonb_array_elements(s.candidates)c where (c->>'role_id')::uuid in(bh,nh))
  loop
    insert into payment_audit_events(event,actor_role,remarks) values('approval_master_corrected','SYSTEM_REPAIR',jsonb_build_object('reason','Keep Business/National Head out of initial approval pool','before',to_jsonb(row_data))::text);
    update payment_head_approval_steps set candidates=(select jsonb_agg(c order by ord) from jsonb_array_elements(row_data.candidates) with ordinality a(c,ord) where (c->>'role_id')::uuid not in(bh,nh)),updated_at=now() where id=row_data.id;
    update payment_heads set initial_approval_role_ids=array_remove(array_remove(initial_approval_role_ids,bh),nh),updated_at=now() where id=row_data.payment_head_id and company_id=company;
  end loop;
  -- Repair only active, unprocessed requests whose current role has exactly
  -- one active Operations manager covering their actual station.
  for row_data in select id,request_no,location_id,payment_head_id,status,approval_status,current_step_order,total_steps,current_approver_user_id,current_approver_role_id,current_approver_role_ids,approval_steps_snapshot from payment_requests
    where company_id=company and status='pending' and approval_status='PENDING' for update
  loop
    select count(distinct m.user_id),(array_agg(distinct m.user_id))[1] into matches,manager_id
      from company_product_memberships m join profiles p on p.id=m.user_id and p.is_active
      where m.company_id=company and m.product_code='operations' and m.is_active and m.role_id=row_data.current_approver_role_id
        and (m.has_all_location_access or row_data.location_id=any(m.location_scope_ids));
    if matches<>1 then raise exception 'Ambiguous/missing manager for %: %',row_data.request_no,matches; end if;
    select exists(select 1 from payment_request_approvals where payment_request_id=row_data.id and company_id=company and action='approved') into initial_done;
    select count(*) into steps_count from payment_head_approval_steps where company_id=company and payment_head_id=row_data.payment_head_id;
    if steps_count<1 or (initial_done and row_data.current_step_order<>2) then raise exception 'Unexpected workflow for %',row_data.request_no; end if;
    insert into payment_audit_events(request_id,event,actor_role,remarks) values(row_data.id,'approval_routing_corrected','SYSTEM_REPAIR',jsonb_build_object('reason','Restore unique station manager assignment; preserve all approval history','before',to_jsonb(row_data),'after_user_id',manager_id)::text);
    update payment_requests set current_approver_user_id=manager_id,current_approver_role_ids=array[row_data.current_approver_role_id],current_step_order=case when initial_done then 2 else 1 end,total_steps=steps_count,
      approval_status=case when initial_done then 'APPROVED' else 'PENDING' end,
      approval_steps_snapshot=(select jsonb_agg(jsonb_build_object('step_order',s.step_order,'candidates',s.candidates,'is_required',s.is_required) order by s.step_order) from payment_head_approval_steps s where s.company_id=company and s.payment_head_id=row_data.payment_head_id),updated_at=now()
      where id=row_data.id and company_id=company;
    changed:=changed+1;
  end loop;
  if changed<>28 then raise exception 'Pending set changed; expected 28, found %',changed; end if;
  -- This legacy standalone reimbursement already has Ujjal's recorded approval.
  -- Route its outstanding Finance review; do NOT mark it approved or paid.
  select id,request_no,status,approval_status,current_step_order,current_approver_user_id,current_approver_role_id,current_approver_role_ids,final_approval_role_id,final_approval_role_ids into row_data from payment_requests
    where id='cb9063a2-ab09-44ad-bc6f-fb3f86044ee1' and company_id=company and status='pending' and approval_status='NO_APPROVER_CONFIGURED' for update;
  if row_data.id is not null then
    if not exists(select 1 from payment_request_approvals where payment_request_id=row_data.id and approver_role_id=bh and action='approved') then raise exception 'Reimbursement initial approval missing'; end if;
    insert into payment_audit_events(request_id,event,actor_role,remarks) values(row_data.id,'approval_routing_corrected','SYSTEM_REPAIR',jsonb_build_object('reason','Restore Finance review after recorded Business Head approval; no financial execution','before',to_jsonb(row_data))::text);
    update payment_requests set current_approver_user_id='2909d787-6d35-4eac-807f-fc3ec71c4dc3',current_approver_role_id=finance,current_approver_role_ids=array[finance],final_approval_role_id=finance,final_approval_role_ids=array[finance],approval_status='APPROVED',updated_at=now() where id=row_data.id;
  end if;
  -- Configuration remains editable in Dashboard Master. New-stage requests and
  -- reminders go to the assigned approver, not a station-email or final-role pool.
  insert into payment_audit_events(event,actor_role,remarks)
    select 'payment_notification_routing_corrected','SYSTEM_REPAIR',jsonb_build_object('before',to_jsonb(t),'reason','Notify current approval stage only')::text from payment_notification_templates t where company_id=company and event_type in('payment_request','payment_approve');
  update payment_notification_templates set to_recipients=array['current_approver'],cc_recipients='{}' where company_id=company and event_type='payment_request';
  update payment_notification_templates set to_recipients=array['initial:current_approver','final:requester','final:payment_processor'] where company_id=company and event_type='payment_approve';
end $$;
commit;
