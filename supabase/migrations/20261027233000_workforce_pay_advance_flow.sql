-- Workforce/People advances: 25% payable cap, one operational review, Finance
-- processing, transparent per-step amounts, and Workforce payout recovery.

begin;

alter table public.hr_pay_advance_requests
  add column if not exists outstanding_pay_snapshot numeric(14,2),
  add column if not exists eligibility_percent_snapshot numeric(5,2),
  add column if not exists max_eligible_amount_snapshot numeric(14,2);

alter table public.hr_pay_advance_steps
  add column if not exists approved_amount numeric(14,2);

alter table public.payment_advance_requests drop constraint if exists payment_advance_requests_profile_type_check;
alter table public.payment_advance_requests add constraint payment_advance_requests_profile_type_check
  check (profile_type in ('employee','field_executive','contractor','vendor','worker','workforce'));
alter table public.payment_advance_requests drop constraint if exists payment_advance_requests_status_check;
alter table public.payment_advance_requests add constraint payment_advance_requests_status_check
  check (status in ('submitted','in_review','returned','approved','rejected','cancelled','closed'));

alter table public.hr_pay_advance_requests drop constraint if exists hr_pay_advance_worker_check;
alter table public.hr_pay_advance_requests add constraint hr_pay_advance_worker_check
  check (worker_type in ('employee','contractor','workforce'));
alter table public.hr_pay_advance_requests drop constraint if exists hr_pay_advance_status_check;
alter table public.hr_pay_advance_requests add constraint hr_pay_advance_status_check
  check (status in ('pending','returned','rejected','approved','disbursed','partially_recovered','recovered','cancelled'));
alter table public.hr_pay_advance_requests drop constraint if exists hr_pay_advance_amount_check;
alter table public.hr_pay_advance_requests add constraint hr_pay_advance_amount_check check (
  requested_amount > 0
  and (approved_amount is null or approved_amount > 0
    and approved_amount <= coalesce(max_eligible_amount_snapshot, requested_amount))
  and (outstanding_pay_snapshot is null or outstanding_pay_snapshot >= 0)
  and (eligibility_percent_snapshot is null or eligibility_percent_snapshot > 0 and eligibility_percent_snapshot <= 100)
  and (max_eligible_amount_snapshot is null or max_eligible_amount_snapshot >= requested_amount)
);

alter table public.hr_pay_advance_recoveries drop constraint if exists hr_pay_advance_recovery_worker_check;
alter table public.hr_pay_advance_recoveries add constraint hr_pay_advance_recovery_worker_check
  check (worker_type in ('employee','contractor','workforce'));

alter table public.hr_pay_advance_steps drop constraint if exists hr_pay_advance_step_amount_check;
alter table public.hr_pay_advance_steps add constraint hr_pay_advance_step_amount_check
  check (approved_amount is null or approved_amount > 0);
alter table public.hr_pay_advance_steps drop constraint if exists hr_pay_advance_step_status_check;
alter table public.hr_pay_advance_steps add constraint hr_pay_advance_step_status_check
  check (status in ('queued','pending','approved','rejected','returned','skipped'));

create or replace function public.hr_create_pay_advance_request_v2(
  p_company_id uuid,
  p_worker_type text,
  p_worker_id uuid,
  p_requested_amount numeric,
  p_recovery_mode text,
  p_requested_installments integer,
  p_reason text,
  p_needed_by date,
  p_requester uuid,
  p_steps jsonb,
  p_outstanding_pay numeric,
  p_eligibility_percent numeric,
  p_max_eligible_amount numeric,
  p_external_reference uuid
) returns uuid
language plpgsql security definer set search_path=public as $$
declare
  request_id uuid;
  request_no text;
  worker_name text;
  worker_code text;
  worker_location uuid;
  step jsonb;
  step_number integer := 0;
begin
  if p_worker_type not in ('employee','contractor','workforce') then raise exception 'Invalid workforce category'; end if;
  if p_requested_amount < 500 then raise exception 'Advance amount must be at least 500'; end if;
  if p_outstanding_pay < 0 or p_eligibility_percent <> 25 or p_max_eligible_amount < 0 then
    raise exception 'Advance eligibility snapshot is invalid';
  end if;
  if p_requested_amount > p_max_eligible_amount then
    raise exception 'Advance amount cannot exceed 25%% of outstanding pay';
  end if;
  if p_recovery_mode not in ('one_time','installments','manual') then raise exception 'Invalid recovery method'; end if;
  if p_requested_installments not between 1 and 12 then raise exception 'Installments must be between 1 and 12'; end if;
  if length(btrim(coalesce(p_reason,''))) < 10 then raise exception 'A clear reason is required'; end if;
  if jsonb_typeof(p_steps) <> 'array' or jsonb_array_length(p_steps) <> 2 then
    raise exception 'A Cluster Manager/AOM step and a Finance step are required';
  end if;

  if p_worker_type='employee' then
    select full_name,employee_code,location_id into worker_name,worker_code,worker_location
    from public.employees where company_id=p_company_id and id=p_worker_id and is_active;
  elsif p_worker_type='contractor' then
    select full_name,dropx_id,location_id into worker_name,worker_code,worker_location
    from public.contractors where company_id=p_company_id and id=p_worker_id and is_active;
  else
    select full_name,dropx_id,location_id into worker_name,worker_code,worker_location
    from public.workforce where company_id=p_company_id and id=p_worker_id and is_active and deleted_at is null;
  end if;
  if worker_name is null then raise exception 'Active worker was not found'; end if;
  if worker_location is null then raise exception 'The worker does not have an active station mapping'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_company_id::text||':'||p_worker_type||':'||p_worker_id::text||':pay-advance',0));
  if exists(select 1 from public.hr_pay_advance_requests where company_id=p_company_id
    and worker_type=p_worker_type and worker_id=p_worker_id
    and status in ('pending','approved','disbursed','partially_recovered')) then
    raise exception 'An advance request is already pending or has an outstanding recovery for this worker';
  end if;

  request_no := 'ADV-'||to_char(timezone('Asia/Kolkata', now()),'YYYYMM')||'-'||
    lpad((1+(select count(*) from public.hr_pay_advance_requests where company_id=p_company_id
      and request_number like 'ADV-'||to_char(timezone('Asia/Kolkata', now()),'YYYYMM')||'-%'))::text,5,'0');
  insert into public.hr_pay_advance_requests(
    company_id,request_number,worker_type,worker_id,worker_name,worker_code,location_id,
    requested_amount,recovery_mode,requested_installments,reason,needed_by,requested_by,
    outstanding_pay_snapshot,eligibility_percent_snapshot,max_eligible_amount_snapshot,
    external_source,external_reference
  ) values (
    p_company_id,request_no,p_worker_type,p_worker_id,worker_name,worker_code,worker_location,
    p_requested_amount,p_recovery_mode,p_requested_installments,btrim(p_reason),p_needed_by,p_requester,
    p_outstanding_pay,p_eligibility_percent,p_max_eligible_amount,
    'payment_advance_requests',p_external_reference::text
  ) returning id into request_id;

  for step in select value from jsonb_array_elements(p_steps) loop
    step_number := step_number + 1;
    if step_number = 1 and step->>'step_type' <> 'manager' then raise exception 'First advance step must be an operational manager'; end if;
    if step_number = 2 and step->>'step_type' <> 'finance' then raise exception 'Final advance step must be Finance'; end if;
    insert into public.hr_pay_advance_steps(
      company_id,request_id,step_order,step_type,step_name,approver_user_id,approver_person_id,status
    ) values (
      p_company_id,request_id,step_number,step->>'step_type',
      coalesce(nullif(btrim(step->>'step_name'),''),'Advance approval'),
      (step->>'approver_user_id')::uuid,nullif(step->>'approver_person_id','')::uuid,
      case when step_number=1 then 'pending' else 'queued' end
    );
  end loop;
  insert into public.hr_audit_log(company_id,actor_user_id,entity_type,entity_id,action,after_data)
  values(p_company_id,p_requester,'pay_advance_request',request_id,'create',jsonb_build_object(
    'request_number',request_no,'amount',p_requested_amount,'outstanding_pay',p_outstanding_pay,
    'eligibility_percent',p_eligibility_percent,'maximum_eligible_amount',p_max_eligible_amount,'steps',step_number));
  return request_id;
end;
$$;

create or replace function public.hr_pay_advance_send_to_payment(
  p_company_id uuid,
  p_request_id uuid,
  p_actor_user_id uuid
) returns uuid
language plpgsql security definer set search_path=public as $$
declare
  request_row public.hr_pay_advance_requests%rowtype;
  v_payment_head public.payment_heads%rowtype;
  v_payment_id uuid;
  v_request_no text;
  v_worker_name text;
  v_email text;
  v_mobile text;
  v_bank text;
  v_ifsc text;
  v_location_code text;
begin
  select * into request_row from public.hr_pay_advance_requests
  where company_id=p_company_id and id=p_request_id for update;
  if not found then raise exception 'Advance request was not found.'; end if;
  if request_row.payment_request_id is not null then
    if request_row.worker_type <> 'workforce' then perform public.hr_schedule_pay_advance_recoveries(p_company_id,p_request_id); end if;
    return request_row.payment_request_id;
  end if;
  if request_row.status <> 'approved' then raise exception 'Only an approved advance can be sent to Payments.'; end if;

  select head.* into v_payment_head from public.payment_heads head
  where head.company_id=p_company_id and head.is_active
    and cardinality(coalesce(head.payment_process_role_ids,'{}'::uuid[]))>0
    and (upper(head.code) in ('SALARY_ADVANCE','PAY_ADVANCE','ADVANCE')
      or head.name ilike '%salary advance%' or head.name ilike '%pay advance%')
  order by case when upper(head.code)='SALARY_ADVANCE' then 0 when upper(head.code) in ('PAY_ADVANCE','ADVANCE') then 1 else 2 end
  limit 1;
  if not found then raise exception 'Add an active payment head coded SALARY_ADVANCE, with payment processor roles, before an advance can be sent to Payments.'; end if;

  if request_row.worker_type='employee' then
    select full_name,email,mobile,bank_account_no,ifsc into v_worker_name,v_email,v_mobile,v_bank,v_ifsc
    from public.employees where company_id=p_company_id and id=request_row.worker_id;
  elsif request_row.worker_type='contractor' then
    select full_name,email,mobile,bank_account_no,ifsc_code into v_worker_name,v_email,v_mobile,v_bank,v_ifsc
    from public.contractors where company_id=p_company_id and id=request_row.worker_id;
  else
    select full_name,email,mobile,bank_account_no,ifsc_code into v_worker_name,v_email,v_mobile,v_bank,v_ifsc
    from public.workforce where company_id=p_company_id and id=request_row.worker_id;
  end if;
  if nullif(trim(coalesce(v_bank,'')),'') is null or nullif(trim(coalesce(v_ifsc,'')),'') is null then
    raise exception 'Bank account and IFSC must be completed before this advance can be sent to Payments.';
  end if;
  select station_code into v_location_code from public.stations where id=request_row.location_id;
  v_payment_id:=gen_random_uuid();
  v_request_no:='PA'||to_char(clock_timestamp(),'YYMMDD')||upper(substr(replace(v_payment_id::text,'-',''),1,4));
  insert into public.payment_requests(
    id,company_id,request_no,location_id,location_code,station_code,payment_head_id,category,work_date,
    requested_for_name,amount,amount_requested,payment_mode,bank_account_no,ifsc,account_holder_name,
    contact_no,email,remarks,status,approval_status,current_step,current_step_order,
    current_approver_user_id,current_approver_role_id,current_approver_role_ids,final_approval_role_ids,
    payment_process_role_ids,requested_by,source_type,source_id,source_system,source_record_id,details
  ) values (
    v_payment_id,p_company_id,v_request_no,request_row.location_id,coalesce(v_location_code,'HO'),coalesce(v_location_code,'HO'),
    v_payment_head.id,'pay_advance',current_date,coalesce(v_worker_name,request_row.worker_name),
    request_row.approved_amount,request_row.approved_amount,'account_transfer',v_bank,v_ifsc,
    coalesce(v_worker_name,request_row.worker_name),v_mobile,v_email,
    'Approved pay advance '||request_row.request_number||': '||coalesce(request_row.reason,''),
    'approved','APPROVED','PAYMENT',1,null,null,'{}'::uuid[],'{}'::uuid[],
    v_payment_head.payment_process_role_ids,p_actor_user_id,'pay_advance',request_row.id,
    'PEOPLE_HRMS_PAY_ADVANCE',request_row.id::text,
    jsonb_build_object('request_number',request_row.request_number,'worker_code',request_row.worker_code,
      'worker_type',request_row.worker_type,'maximum_eligible_amount',request_row.max_eligible_amount_snapshot)
  );
  update public.hr_pay_advance_requests set payment_request_id=v_payment_id,current_stage='disbursement',updated_at=now()
  where id=p_request_id;
  if request_row.external_source='payment_advance_requests' and request_row.external_reference is not null then
    update public.payment_advance_requests set status='approved',approved_amount=request_row.approved_amount,
      decision_comment=left('Finance approved and sent to Payments '||v_request_no,500),updated_at=now()
    where company_id=p_company_id and id::text=request_row.external_reference;
  end if;
  if request_row.worker_type <> 'workforce' then perform public.hr_schedule_pay_advance_recoveries(p_company_id,p_request_id); end if;
  return v_payment_id;
end;
$$;

create or replace function public.hr_decide_pay_advance_step(
  p_company_id uuid,p_request_id uuid,p_actor_user_id uuid,p_decision text,p_note text,
  p_approved_amount numeric,p_approved_installments integer
) returns text
language plpgsql security definer set search_path=public as $$
declare
  current_step public.hr_pay_advance_steps%rowtype;
  request_row public.hr_pay_advance_requests%rowtype;
  actor_person uuid;
  subject_person uuid;
  next_step uuid;
  v_amount numeric;
begin
  if p_decision not in ('approved','rejected','returned') then raise exception 'Invalid approval decision'; end if;
  if p_decision in ('rejected','returned') and length(btrim(coalesce(p_note,'')))<3 then
    raise exception 'Add a short note explaining this decision.';
  end if;
  select * into current_step from public.hr_pay_advance_steps
  where company_id=p_company_id and request_id=p_request_id and approver_user_id=p_actor_user_id and status='pending'
  order by step_order limit 1 for update;
  if current_step.id is null then raise exception 'This advance is not assigned to you or is no longer pending'; end if;
  select * into request_row from public.hr_pay_advance_requests
  where company_id=p_company_id and id=p_request_id and status='pending' for update;
  if request_row.id is null then raise exception 'Advance request is no longer pending'; end if;
  select person_id into actor_person from public.hr_user_person_links
  where company_id=p_company_id and user_id=p_actor_user_id and status='active';
  if request_row.worker_type in ('employee','contractor') then
    select person_id into subject_person from public.hr_engagements
    where company_id=p_company_id and worker_type=request_row.worker_type
      and ((request_row.worker_type='employee' and employee_id=request_row.worker_id)
        or (request_row.worker_type='contractor' and contractor_id=request_row.worker_id));
  end if;
  if actor_person is not null and actor_person=subject_person then raise exception 'Self-approval is not allowed'; end if;

  if p_decision='approved' then
    v_amount:=coalesce(p_approved_amount,request_row.approved_amount,request_row.requested_amount);
    if v_amount<=0 or v_amount>coalesce(request_row.max_eligible_amount_snapshot,request_row.requested_amount) then
      raise exception 'Approved amount must be greater than zero and within the 25%% outstanding-pay limit';
    end if;
    if current_step.step_type<>'finance' and v_amount>request_row.requested_amount then
      raise exception 'The operational approver may reduce, but cannot increase, the requested amount';
    end if;
  end if;
  update public.hr_pay_advance_steps set status=p_decision,decision_note=nullif(btrim(p_note),''),
    approved_amount=case when p_decision='approved' then v_amount else null end,
    decided_at=now(),updated_at=now() where id=current_step.id;

  if p_decision in ('rejected','returned') then
    update public.hr_pay_advance_requests set status=p_decision,current_stage='closed',decided_by=p_actor_user_id,
      decided_at=now(),decision_note=nullif(btrim(p_note),'') where id=p_request_id;
    update public.hr_pay_advance_steps set status='skipped',updated_at=now()
      where request_id=p_request_id and status='queued';
    if request_row.external_source='payment_advance_requests' and request_row.external_reference is not null then
      update public.payment_advance_requests set status=p_decision,
        decision_comment=left(coalesce(nullif(btrim(p_note),''),p_decision),500),updated_at=now()
      where company_id=p_company_id and id::text=request_row.external_reference;
    end if;
    insert into public.hr_audit_log(company_id,actor_user_id,entity_type,entity_id,action,after_data)
    values(p_company_id,p_actor_user_id,'pay_advance_request',p_request_id,p_decision,
      jsonb_build_object('step',current_step.step_name,'comment',nullif(btrim(p_note),'')));
    return p_decision;
  end if;

  update public.hr_pay_advance_requests set approved_amount=v_amount,updated_at=now() where id=p_request_id;
  select id into next_step from public.hr_pay_advance_steps
    where company_id=p_company_id and request_id=p_request_id and status='queued'
    order by step_order limit 1 for update;
  if next_step is not null then
    update public.hr_pay_advance_steps set status='pending',updated_at=now() where id=next_step;
    update public.hr_pay_advance_requests set current_stage=(select step_type from public.hr_pay_advance_steps where id=next_step),
      decision_note=nullif(btrim(p_note),''),updated_at=now() where id=p_request_id;
    if request_row.external_source='payment_advance_requests' and request_row.external_reference is not null then
      update public.payment_advance_requests set status='in_review',approved_amount=v_amount,
        decision_comment=left(coalesce(nullif(btrim(p_note),''),'Operational approval completed'),500),updated_at=now()
      where company_id=p_company_id and id::text=request_row.external_reference;
    end if;
    insert into public.hr_audit_log(company_id,actor_user_id,entity_type,entity_id,action,after_data)
    values(p_company_id,p_actor_user_id,'pay_advance_request',p_request_id,'approve_step',
      jsonb_build_object('step',current_step.step_name,'approved_amount',v_amount,'comment',nullif(btrim(p_note),'')));
    return 'pending';
  end if;

  if current_step.step_type<>'finance' then raise exception 'Final decision must be completed by Finance'; end if;
  if coalesce(p_approved_installments,request_row.requested_installments) not between 1 and 12 then
    raise exception 'Approved installments must be between 1 and 12';
  end if;
  update public.hr_pay_advance_requests set status='approved',current_stage='disbursement',approved_amount=v_amount,
    approved_installments=coalesce(p_approved_installments,request_row.requested_installments),
    decided_by=p_actor_user_id,decided_at=now(),decision_note=nullif(btrim(p_note),'') where id=p_request_id;
  insert into public.hr_audit_log(company_id,actor_user_id,entity_type,entity_id,action,after_data)
  values(p_company_id,p_actor_user_id,'pay_advance_request',p_request_id,'finance_approve',
    jsonb_build_object('approved_amount',v_amount,'comment',nullif(btrim(p_note),'')));
  perform public.hr_pay_advance_send_to_payment(p_company_id,p_request_id,p_actor_user_id);
  return 'approved';
end;
$$;

create or replace function public.hr_mark_pay_advance_disbursed(
  p_company_id uuid,p_request_id uuid,p_actor_user_id uuid,p_reference text,p_note text
) returns void
language plpgsql security definer set search_path=public as $$
declare
  request_row public.hr_pay_advance_requests%rowtype;
begin
  select * into request_row from public.hr_pay_advance_requests
  where company_id=p_company_id and id=p_request_id and status='approved' for update;
  if request_row.id is null then raise exception 'Only an approved advance can be disbursed'; end if;
  if length(btrim(coalesce(p_reference,'')))<3 then raise exception 'Bank or UTR reference is required'; end if;
  update public.hr_pay_advance_requests set status='disbursed',current_stage='recovery',disbursed_by=p_actor_user_id,
    disbursed_at=now(),disbursement_reference=btrim(p_reference),disbursement_note=nullif(btrim(p_note),'')
  where id=p_request_id;
  if request_row.worker_type='workforce' then
    insert into public.workforce_advances(
      company_id,workforce_id,station_id,advance_date,amount,payment_mode,payment_reference,
      external_reference,remark,source_type,created_by,updated_by,imported_dropx_id,link_status
    ) select request_row.company_id,request_row.worker_id,request_row.location_id,
      timezone('Asia/Kolkata',coalesce(request_row.disbursed_at,now()))::date,request_row.approved_amount,
      'bank_transfer',btrim(p_reference),'PAY_ADVANCE:'||request_row.id::text,
      'Approved in DropX One: '||request_row.request_number||' · '||request_row.reason,
      'manual',p_actor_user_id,p_actor_user_id,workforce.dropx_id,'linked'
    from public.workforce workforce where workforce.company_id=request_row.company_id and workforce.id=request_row.worker_id
    on conflict (company_id,lower(btrim(external_reference))) where external_reference is not null and btrim(external_reference)<>'' do nothing;
  else
    perform public.hr_schedule_pay_advance_recoveries(p_company_id,p_request_id);
  end if;
  insert into public.hr_audit_log(company_id,actor_user_id,entity_type,entity_id,action,after_data)
  values(p_company_id,p_actor_user_id,'pay_advance_request',p_request_id,'disburse',
    jsonb_build_object('reference',p_reference,'amount',request_row.approved_amount,'recovery_target',request_row.worker_type));
end;
$$;

create or replace function public.hr_cancel_pay_advance_request(
  p_company_id uuid,p_payment_advance_request_id uuid
) returns boolean
language plpgsql security definer set search_path=public as $$
declare v_request_id uuid;
begin
  select id into v_request_id from public.hr_pay_advance_requests
  where company_id=p_company_id and external_source='payment_advance_requests'
    and external_reference=p_payment_advance_request_id::text and status in ('pending','returned')
  for update;
  if v_request_id is null then return false; end if;
  update public.hr_pay_advance_requests set status='cancelled',current_stage='closed',closed_at=now(),updated_at=now()
  where id=v_request_id;
  update public.hr_pay_advance_steps set status='skipped',updated_at=now()
  where request_id=v_request_id and status in ('pending','queued');
  update public.payment_advance_requests set status='cancelled',updated_at=now()
  where company_id=p_company_id and id=p_payment_advance_request_id
    and status in ('submitted','in_review');
  return true;
end;
$$;

revoke all on function public.hr_create_pay_advance_request_v2(uuid,text,uuid,numeric,text,integer,text,date,uuid,jsonb,numeric,numeric,numeric,uuid) from public,anon,authenticated;
revoke all on function public.hr_cancel_pay_advance_request(uuid,uuid) from public,anon,authenticated;
grant execute on function public.hr_create_pay_advance_request_v2(uuid,text,uuid,numeric,text,integer,text,date,uuid,jsonb,numeric,numeric,numeric,uuid) to service_role;
grant execute on function public.hr_cancel_pay_advance_request(uuid,uuid) to service_role;
grant execute on function public.hr_decide_pay_advance_step(uuid,uuid,uuid,text,text,numeric,integer) to service_role;
grant execute on function public.hr_pay_advance_send_to_payment(uuid,uuid,uuid) to service_role;
grant execute on function public.hr_mark_pay_advance_disbursed(uuid,uuid,uuid,text,text) to service_role;

comment on column public.hr_pay_advance_requests.max_eligible_amount_snapshot is
  'Immutable submission-time cap: 25% of outstanding payable salary/payout after committed advances.';
comment on column public.hr_pay_advance_steps.approved_amount is
  'Amount accepted or adjusted by this reviewer; Finance may adjust within the snapshotted eligibility cap.';

notify pgrst,'reload schema';
commit;
