-- Coordinated release: deploy People and Dashboard consumers before enabling traffic.
-- Existing request/approval/bank records stay intact. Old paid registers are
-- retained as historical evidence; new bank payments use pay_advances only.
begin;
lock table public.workforce_advances,public.workforce_advance_recoveries,public.hr_pay_advance_requests,public.payment_requests in share row exclusive mode;
do $$
begin
  if exists(select 1 from public.hr_pay_advance_requests r left join public.payment_requests p on p.company_id=r.company_id and p.id=r.payment_request_id
    where r.status in ('disbursed','partially_recovered','recovered') and (p.bank_status is distinct from 'Paid' or nullif(trim(p.utr_cin),'') is null or p.amount is distinct from r.approved_amount)) then
    raise exception 'Reconcile paid advances without matching bank confirmation before cutover';
  end if;
  if exists(select 1 from public.workforce_advances w join public.hr_pay_advance_requests r on r.company_id=w.company_id and w.external_reference='PAY_ADVANCE:'||r.id::text
    where w.amount is distinct from r.approved_amount or w.workforce_id is distinct from r.worker_id or r.worker_type<>'workforce') then
    raise exception 'Conflicting legacy advance link';
  end if;
end $$;

insert into public.pay_advances(id,company_id,worker_type,worker_id,worker_code,request_id,payment_request_id,amount,paid_at,first_due_period,installments,evidence_type,bank_reference,source_key,provenance)
select r.id,r.company_id,r.worker_type,r.worker_id,r.worker_code,r.id,p.id,r.approved_amount,
  coalesce(r.disbursed_at,r.decided_at,r.requested_at),date_trunc('month',timezone('Asia/Kolkata',coalesce(r.disbursed_at,r.decided_at,r.requested_at)))::date,
  case when r.recovery_mode='installments' then coalesce(r.approved_installments,r.requested_installments,1) else 1 end,
  'bank_confirmed',trim(p.utr_cin),'payment:'||p.id::text,
  jsonb_build_object('legacy_request_id',r.id,'legacy_workforce_id',w.id,'request_number',r.request_number)
from public.hr_pay_advance_requests r join public.payment_requests p on p.company_id=r.company_id and p.id=r.payment_request_id
left join public.workforce_advances w on w.company_id=r.company_id and w.external_reference='PAY_ADVANCE:'||r.id::text
where p.bank_status='Paid' and nullif(trim(p.utr_cin),'') is not null and p.amount=r.approved_amount
  and r.status in ('disbursed','partially_recovered','recovered')
on conflict(company_id,source_key) do nothing;

insert into public.pay_advances(id,company_id,worker_type,worker_id,worker_code,amount,paid_at,first_due_period,evidence_type,bank_reference,source_key,provenance)
select w.id,w.company_id,'workforce',w.workforce_id,w.imported_dropx_id,w.amount,w.advance_date::timestamp at time zone 'Asia/Kolkata',
  date_trunc('month',w.advance_date)::date,'legacy_recorded',w.payment_reference,'workforce:'||w.id::text,
  jsonb_build_object('legacy_workforce_id',w.id,'advance_number',w.advance_number,'source_type',w.source_type,
    'source_batch_id',w.source_batch_id,'external_reference',w.external_reference,'station_id',w.station_id)
from public.workforce_advances w
where not exists(select 1 from public.pay_advances a where a.company_id=w.company_id and a.provenance->>'legacy_workforce_id'=w.id::text)
on conflict(company_id,source_key) do nothing;

insert into public.pay_advance_deductions(company_id,advance_id,target_kind,target_key,period_start,amount,status,source_key,provenance)
select r.company_id,a.id,'legacy',r.id::text,date_trunc('month',coalesce(r.period_start,a.first_due_period))::date,r.amount,
  case when r.status='deducted' then 'confirmed' else 'reversed' end,'workforce_recovery:'||r.id::text,
  jsonb_build_object('legacy_recovery_id',r.id,'deduction_value_id',r.deduction_value_id,'recovery_type',r.recovery_type,'period_end',r.period_end)
from public.workforce_advance_recoveries r join public.pay_advances a on a.company_id=r.company_id and a.provenance->>'legacy_workforce_id'=r.advance_id::text
where not exists(select 1 from public.pay_advance_deductions d where d.company_id=r.company_id and d.source_key='workforce_recovery:'||r.id::text)
on conflict(company_id,source_key) do nothing;

insert into public.pay_advance_deductions(company_id,advance_id,target_kind,target_key,period_start,amount,status,source_key,provenance)
select r.company_id,a.id,'legacy',r.id::text,date_trunc('month',r.due_period)::date,r.recovered_amount,'confirmed','people_recovery:'||r.id::text,
  jsonb_build_object('legacy_recovery_id',r.id,'payroll_run_id',r.payroll_run_id)
from public.hr_pay_advance_recoveries r join public.pay_advances a on a.company_id=r.company_id and a.request_id=r.request_id
where r.recovered_amount>0 and not exists(select 1 from public.pay_advance_deductions d where d.company_id=r.company_id and d.source_key='people_recovery:'||r.id::text) on conflict(company_id,source_key) do nothing;

-- The 16 September MANUAL_ADVANCE entries are expressly excluded. They remain
-- historical payroll deductions, not evidence of an additional paid principal.
-- Preserve actual draft schedule allocations; never migrate merely approved pay.
insert into public.pay_advance_deductions(company_id,advance_id,target_kind,target_key,period_start,amount,status,source_key,provenance)
select p.company_id,a.id,'people',p.run_id::text||':'||p.worker_type||':'||p.worker_id::text,r.period_start,
  sum(rec.scheduled_amount),
  case when r.status='locked' or exists(select 1 from public.hr_payroll_bank_lines b where b.company_id=p.company_id and b.run_id=p.run_id and b.worker_type=p.worker_type and b.worker_id=p.worker_id and b.status='paid') then 'confirmed' else 'reserved' end,
  'people:'||p.run_id::text||':'||p.worker_type||':'||p.worker_id::text||':'||a.id::text,
  jsonb_build_object('legacy_schedule',true)
from public.hr_payroll_run_items i join public.hr_payroll_run_people p on p.id=i.run_person_id and p.company_id=i.company_id
join public.hr_payroll_runs r on r.id=p.run_id and r.company_id=p.company_id
join public.hr_pay_advance_recoveries rec on rec.company_id=p.company_id and rec.id::text in (select jsonb_array_elements_text(coalesce(i.metadata->'recovery_ids','[]'::jsonb)))
join public.pay_advances a on a.company_id=rec.company_id and a.request_id=rec.request_id
where i.code='PAY_ADVANCE_RECOVERY' and rec.status in ('scheduled','applied') and p.calculation_status<>'blocked'
  and not exists(select 1 from public.pay_advance_deductions d where d.company_id=p.company_id and d.source_key='people:'||p.run_id::text||':'||p.worker_type||':'||p.worker_id::text||':'||a.id::text)
group by p.company_id,a.id,p.run_id,p.worker_type,p.worker_id,r.period_start,r.status
on conflict(company_id,source_key) do nothing;

create or replace function public.hr_mark_pay_advance_disbursed(p_company_id uuid,p_request_id uuid,p_actor_user_id uuid,p_reference text,p_note text)
returns void language plpgsql security definer set search_path='' as $$
declare v_payment uuid; v_advance uuid;
begin
  select payment_request_id into v_payment from public.hr_pay_advance_requests where company_id=p_company_id and id=p_request_id;
  v_advance:=public.pay_advance_record_bank_payment(p_company_id,v_payment);
  update public.hr_pay_advance_requests r set status='disbursed',current_stage='recovery',
    disbursed_at=a.paid_at,disbursement_reference=a.bank_reference,disbursement_note=p_note,disbursed_by=p_actor_user_id,updated_at=now()
    from public.pay_advances a where a.company_id=p_company_id and a.id=v_advance and r.id=p_request_id and r.company_id=p_company_id and r.status='approved';
end $$;

-- Approval no longer writes a repayment schedule.
create or replace function public.hr_schedule_pay_advance_recoveries(p_company_id uuid,p_request_id uuid)
returns void language plpgsql security invoker set search_path='' as $$ begin return; end $$;

create or replace function public.pay_advance_record_recovery_status() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  update public.hr_pay_advance_requests r set recovered_amount=s.amount,
    status=case when s.amount>=a.amount then 'recovered' when s.amount>0 then 'partially_recovered' else 'disbursed' end,
    current_stage=case when s.amount>=a.amount then 'closed' else 'recovery' end,
    closed_at=case when s.amount>=a.amount then now() else null end,updated_at=now()
  from public.pay_advances a cross join lateral(
    select coalesce(sum(d.amount),0) amount from public.pay_advance_deductions d where d.company_id=a.company_id and d.advance_id=a.id and d.status in ('confirmed','waived')
  )s where a.company_id=new.company_id and a.id=new.advance_id and r.company_id=a.company_id and r.id=a.request_id;
  return new;
end $$;
drop trigger if exists pay_advance_recovered_status on public.pay_advance_deductions;
create trigger pay_advance_recovered_status after insert or update on public.pay_advance_deductions for each row execute function public.pay_advance_record_recovery_status();

-- No new standalone manual advance can be added to payroll. Existing imported
-- historical values are retained unchanged.
create or replace function public.guard_new_manual_payroll_advance() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if (tg_op='INSERT' and coalesce(new.advance_amount,0)<>0)
    or (tg_op='UPDATE' and new.advance_amount is distinct from old.advance_amount) then
    raise exception 'Manual advances are retired. Request an advance from the People or Workforce profile.';
  end if;
  return new;
end $$;
drop trigger if exists hr_manual_advance_retired on public.hr_payroll_run_manual_entries;
create trigger hr_manual_advance_retired before insert or update of advance_amount on public.hr_payroll_run_manual_entries for each row execute function public.guard_new_manual_payroll_advance();

CREATE OR REPLACE FUNCTION public.hr_sync_expense_payment_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_claim public.hr_expense_claims%rowtype;
  v_new_status text;
  v_event text;
  v_reference text;
begin
  if new.source_id is null then return new; end if;
  if new.source_type = 'pay_advance' then
    if new.bank_status='Paid' and nullif(trim(new.utr_cin),'') is not null then
      perform public.hr_mark_pay_advance_disbursed(new.company_id,new.source_id,new.requested_by,new.utr_cin,new.bank_processing_remarks);
      update public.payment_advance_requests target set status='closed',updated_at=now()
        from public.hr_pay_advance_requests r where r.company_id=new.company_id and r.id=new.source_id
        and target.company_id=r.company_id and target.id::text=r.external_reference and r.external_source='payment_advance_requests';
    end if;
    return new;
  end if;

  if new.source_type is distinct from 'employee_reimbursement' then return new; end if;
  select * into v_claim from public.hr_expense_claims where company_id = new.company_id and id = new.source_id for update;
  if not found then return new; end if;
  v_new_status := case
    when upper(coalesce(new.approval_status, new.status)) = 'PROCESSED' or lower(new.status) = 'processed' then 'paid'
    when upper(coalesce(new.approval_status, new.status)) = 'PROCESSING' or lower(new.status) = 'processing' then 'payment_processing'
    when upper(coalesce(new.approval_status, new.status)) = 'REJECTED' or lower(new.status) = 'rejected' then 'payment_rejected'
    when upper(coalesce(new.approval_status, new.status)) = 'RETURNED' or lower(new.status) = 'returned' then 'payment_returned'
    else 'approved_for_payment' end;
  if v_claim.status is distinct from v_new_status then
    v_event := case when v_new_status = 'paid' then 'payment_completed' when v_new_status = 'payment_processing' then 'payment_processing' when v_new_status = 'payment_returned' then 'payment_returned' when v_new_status = 'payment_rejected' then 'payment_rejected' else 'payment_updated' end;
    update public.hr_expense_claims set status = v_new_status, updated_at = now() where id = v_claim.id;
    insert into public.hr_expense_events(company_id, claim_id, event_type, from_status, to_status, actor_user_id, actor_name, actor_role, comments, metadata)
    values (new.company_id, v_claim.id, v_event, v_claim.status, v_new_status, null, 'Payments', 'Payment processing', coalesce(new.bank_processing_remarks, new.remarks), jsonb_build_object('payment_request_id', new.id, 'request_no', new.request_no, 'utr_cin', new.utr_cin, 'bank_status', new.bank_status));
  elsif new.utr_cin is distinct from old.utr_cin or new.bank_status is distinct from old.bank_status then
    insert into public.hr_expense_events(company_id, claim_id, event_type, from_status, to_status, actor_user_id, actor_name, actor_role, comments, metadata)
    values (new.company_id, v_claim.id, 'payment_reference_updated', v_claim.status, v_claim.status, null, 'Payments', 'Payment processing', coalesce(new.bank_processing_remarks, 'Payment reference updated.'), jsonb_build_object('payment_request_id', new.id, 'request_no', new.request_no, 'utr_cin', new.utr_cin, 'bank_status', new.bank_status));
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.hr_transition_payroll_run(p_company_id uuid, p_run_id uuid, p_target_status text, p_actor_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare current_status text; run_end date; calculated_through date; published_count integer; pending_review_summary text;
begin
  select status,period_end,calculation_through into current_status,run_end,calculated_through from public.hr_payroll_runs where id=p_run_id and company_id=p_company_id for update;
  if current_status is null then raise exception 'Payroll run was not found'; end if;
  if p_target_status='reviewed' and current_status<>'calculated' then raise exception 'Only calculated payroll can be reviewed'; end if;
  if p_target_status='approved' and current_status<>'reviewed' then raise exception 'Only reviewed payroll can be approved'; end if;
  if p_target_status='locked' and current_status<>'approved' then raise exception 'Only approved payroll can be locked'; end if;
  if p_target_status not in ('reviewed','approved','locked') then raise exception 'Invalid payroll transition'; end if;
  if p_target_status='reviewed' and calculated_through<>run_end then raise exception 'Final payroll review requires calculation through the period end'; end if;

  if p_target_status='locked' then
    select string_agg(worker_name || ' (' || coalesce(nullif(worker_code,''), worker_id::text) || ': ' ||
        trim(trailing '0' from trim(trailing '.' from round(coalesce((calculation_snapshot->>'pending_review_days')::numeric,0), 2)::text)) || ' day(s))', ', ')
      into pending_review_summary
      from public.hr_payroll_run_people
      where run_id=p_run_id and company_id=p_company_id
        and calculation_status <> 'blocked'
        and coalesce((calculation_snapshot->>'pending_review_days')::numeric,0) > 0;
    if pending_review_summary is not null then
      raise exception 'Resolve attendance still marked Needs review before locking payroll, or set manual present days for them (Attendance > Needs review): %', pending_review_summary;
    end if;
  end if;

  update public.hr_payroll_runs set status=p_target_status,reviewed_by=case when p_target_status='reviewed' then p_actor_user_id else reviewed_by end,reviewed_at=case when p_target_status='reviewed' then now() else reviewed_at end,approved_by=case when p_target_status='approved' then p_actor_user_id else approved_by end,approved_at=case when p_target_status='approved' then now() else approved_at end,locked_by=case when p_target_status='locked' then p_actor_user_id else locked_by end,locked_at=case when p_target_status='locked' then now() else locked_at end,updated_at=now() where id=p_run_id and company_id=p_company_id;
  if p_target_status='locked' then
    select public.hr_publish_pay_documents(p_company_id,p_run_id,p_actor_user_id) into published_count;
  end if;
  insert into public.hr_audit_log(company_id,actor_user_id,entity_type,entity_id,action,after_data) values(p_company_id,p_actor_user_id,'payroll_run',p_run_id,p_target_status,jsonb_build_object('previous_status',current_status,'pay_documents_published',coalesce(published_count,0)));
end $function$;


CREATE OR REPLACE FUNCTION public.hr_replace_payroll_run_snapshot_before_unified_advances(p_company_id uuid, p_run_id uuid, p_calculation_from date, p_calculation_through date, p_people jsonb, p_settings_snapshot jsonb, p_rules_snapshot jsonb, p_actor_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '90000'
AS $function$
declare
  person jsonb;
  item jsonb;
  saved_person_id uuid;
begin
  if jsonb_typeof(p_people) <> 'array' then raise exception 'Payroll people snapshot must be an array'; end if;
  if p_calculation_from is null or p_calculation_through is null then raise exception 'Payroll calculation range is required'; end if;
  if not exists (
    select 1 from public.hr_payroll_runs where id = p_run_id and company_id = p_company_id
      and status in ('draft','calculated')
      and p_calculation_from between period_start and period_end
      and p_calculation_through between p_calculation_from and period_end
    for update
  ) then raise exception 'Only an open payroll can be recalculated inside its period'; end if;

  delete from public.hr_payroll_run_people where run_id = p_run_id and company_id = p_company_id;
  for person in select value from jsonb_array_elements(p_people) loop
    insert into public.hr_payroll_run_people (
      company_id, run_id, client_key, worker_type, worker_id, worker_code, worker_name,
      location_id, location_name, department_name, designation_name, payment_basis,
      expected_days, present_days, paid_leave_days, unpaid_leave_days, absence_days, half_days,
      late_occurrences, deduction_days, payable_days, weekoff_days, wfh_days, missing_punch_days,
      gross_pay, other_earnings, statutory_deductions, attendance_deductions, other_deductions,
      employer_contributions, net_pay, adjusted_net_pay, adjustment_note, is_adjusted,
      salary_versions, calculation_status, review_notes, calculation_snapshot,
      monthly_gross_salary, monthly_ctc
    ) values (
      p_company_id, p_run_id, person->>'client_key', person->>'worker_type', (person->>'worker_id')::uuid,
      nullif(person->>'worker_code',''), person->>'worker_name', nullif(person->>'location_id','')::uuid,
      nullif(person->>'location_name',''), nullif(person->>'department_name',''), nullif(person->>'designation_name',''),
      nullif(person->>'payment_basis',''), coalesce((person->>'expected_days')::numeric,0),
      coalesce((person->>'present_days')::numeric,0), coalesce((person->>'paid_leave_days')::numeric,0),
      coalesce((person->>'unpaid_leave_days')::numeric,0),
      coalesce((person->>'absence_days')::numeric,0), coalesce((person->>'half_days')::numeric,0),
      coalesce((person->>'late_occurrences')::integer,0), coalesce((person->>'deduction_days')::numeric,0),
      coalesce((person->>'payable_days')::numeric,0), coalesce((person->>'weekoff_days')::numeric,0),
      coalesce((person->>'wfh_days')::numeric,0), coalesce((person->>'missing_punch_days')::numeric,0),
      coalesce((person->>'gross_pay')::numeric,0), coalesce((person->>'other_earnings')::numeric,0),
      coalesce((person->>'statutory_deductions')::numeric,0),
      coalesce((person->>'attendance_deductions')::numeric,0), coalesce((person->>'other_deductions')::numeric,0),
      coalesce((person->>'employer_contributions')::numeric,0), coalesce((person->>'net_pay')::numeric,0),
      nullif(person->>'adjusted_net_pay','')::numeric, nullif(person->>'adjustment_note',''),
      coalesce((person->>'is_adjusted')::boolean,false),
      coalesce(person->'salary_versions','[]'::jsonb),
      person->>'calculation_status', coalesce(array(select jsonb_array_elements_text(person->'review_notes')), '{}'),
      coalesce(person->'calculation_snapshot','{}'::jsonb),
      coalesce((person->>'monthly_gross_salary')::numeric,0), coalesce((person->>'monthly_ctc')::numeric,0)
    ) returning id into saved_person_id;

    for item in select value from jsonb_array_elements(coalesce(person->'items','[]'::jsonb)) loop
      insert into public.hr_payroll_run_items (
        company_id, run_person_id, code, name, item_type, amount, source, display_order, metadata
      ) values (
        p_company_id, saved_person_id, item->>'code', item->>'name', item->>'item_type',
        coalesce((item->>'amount')::numeric,0), item->>'source', coalesce((item->>'display_order')::integer,100),
        coalesce(item->'metadata','{}'::jsonb)
      );
    end loop;
  end loop;

  update public.hr_payroll_runs set
    status = 'calculated', calculation_from = p_calculation_from, calculation_through = p_calculation_through,
    settings_snapshot = coalesce(p_settings_snapshot,'{}'::jsonb), rules_snapshot = coalesce(p_rules_snapshot,'[]'::jsonb),
    people_count = jsonb_array_length(p_people),
    ready_count = (select count(*) from public.hr_payroll_run_people where run_id = p_run_id and calculation_status = 'ready'),
    review_count = (select count(*) from public.hr_payroll_run_people where run_id = p_run_id and calculation_status = 'review'),
    blocked_count = (select count(*) from public.hr_payroll_run_people where run_id = p_run_id and calculation_status = 'blocked'),
    gross_total = (select coalesce(sum(gross_pay + other_earnings),0) from public.hr_payroll_run_people where run_id = p_run_id),
    deduction_total = (select coalesce(sum(statutory_deductions + attendance_deductions + other_deductions),0) from public.hr_payroll_run_people where run_id = p_run_id),
    net_total = (select coalesce(sum(coalesce(adjusted_net_pay, net_pay)),0) from public.hr_payroll_run_people where run_id = p_run_id),
    calculated_by = p_actor_user_id, calculated_at = now(), reviewed_by = null, reviewed_at = null,
    approved_by = null, approved_at = null, locked_by = null, locked_at = null, updated_at = now()
  where id = p_run_id and company_id = p_company_id;

  insert into public.audit_logs(actor_id, action, entity_table, entity_id, new_values, reason)
  values (p_actor_user_id, 'calculate_live', 'hr_payroll_runs', p_run_id,
    jsonb_build_object('company_id',p_company_id,'people_count',jsonb_array_length(p_people),'calculation_from',p_calculation_from,'calculation_through',p_calculation_through),
    'Live payroll refresh');
end;
$function$;


create or replace function public.hr_replace_payroll_run_snapshot(p_company_id uuid,p_run_id uuid,p_calculation_from date,p_calculation_through date,p_people jsonb,p_settings_snapshot jsonb,p_rules_snapshot jsonb,p_actor_user_id uuid)
returns void language plpgsql security definer set search_path='' set statement_timeout='90000' as $$
declare person record; lines jsonb; period date; removed record;
begin
  select period_start into period from public.hr_payroll_runs where company_id=p_company_id and id=p_run_id for update;
  perform public.hr_replace_payroll_run_snapshot_before_unified_advances(p_company_id,p_run_id,p_calculation_from,p_calculation_through,p_people,p_settings_snapshot,p_rules_snapshot,p_actor_user_id);
  for person in select * from public.hr_payroll_run_people where company_id=p_company_id and run_id=p_run_id order by worker_type,worker_id loop
    select coalesce(jsonb_agg(jsonb_build_object('advance_id',x.advance_id,'amount',x.amount)),'[]'::jsonb) into lines from (
      select (i.metadata->>'advance_id')::uuid advance_id,sum(i.amount) amount
      from public.hr_payroll_run_items i where i.company_id=p_company_id and i.run_person_id=person.id and i.source='unified_advance'
      group by 1
      union all
      -- Frozen pre-cutover snapshots still contain their original request keys.
      select a.id,sum(rec.scheduled_amount) from public.hr_payroll_run_items i
      join public.hr_pay_advance_recoveries rec on rec.company_id=i.company_id and rec.id::text in(select jsonb_array_elements_text(coalesce(i.metadata->'recovery_ids','[]'::jsonb)))
      join public.pay_advances a on a.company_id=rec.company_id and a.request_id=rec.request_id
      where i.company_id=p_company_id and i.run_person_id=person.id and i.source='pay_advance'
      group by a.id
    )x;
    perform public.pay_advance_reserve(p_company_id,person.worker_type,person.worker_id,period,'people',
      p_run_id::text||':'||person.worker_type||':'||person.worker_id::text,lines);
  end loop;
  for removed in select distinct a.worker_type,a.worker_id from public.pay_advance_deductions d
    join public.pay_advances a on a.company_id=d.company_id and a.id=d.advance_id
    where d.company_id=p_company_id and d.target_kind='people' and d.target_key like p_run_id::text||':%'
      and d.status in ('reserved','confirmed') and not exists(select 1 from public.hr_payroll_run_people p
        where p.company_id=p_company_id and p.run_id=p_run_id and p.worker_type=a.worker_type and p.worker_id=a.worker_id)
    order by a.worker_type,a.worker_id loop
    perform public.pay_advance_reserve(p_company_id,removed.worker_type,removed.worker_id,period,'people',
      p_run_id::text||':'||removed.worker_type||':'||removed.worker_id::text,'[]'::jsonb);
  end loop;
end $$;
revoke all on function public.hr_replace_payroll_run_snapshot_before_unified_advances(uuid,uuid,date,date,jsonb,jsonb,jsonb,uuid) from public,anon,authenticated,service_role;

create or replace function public.pay_advance_payroll_finalized() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_table_name='hr_payroll_runs' and new.status='locked' then
    update public.pay_advance_deductions set status='confirmed',updated_at=now()
      where company_id=new.company_id and target_kind='people' and target_key like new.id::text||':%' and status='reserved';
  elsif tg_table_name='hr_payroll_bank_lines' and new.status='paid' then
    update public.pay_advance_deductions set status='confirmed',updated_at=now()
      where company_id=new.company_id and target_kind='people'
        and target_key=new.run_id::text||':'||new.worker_type||':'||new.worker_id::text and status='reserved';
  elsif tg_table_name='workforce_payout_payment_items' and new.status='paid' then
    update public.pay_advance_deductions set status='confirmed',updated_at=now()
      where company_id=new.company_id and target_kind='workforce'
        and target_key=new.workforce_id::text||':'||new.period_start::text and status='reserved';
  end if;
  return new;
end $$;
drop trigger if exists pay_advance_run_finalized on public.hr_payroll_runs;
create trigger pay_advance_run_finalized after update of status on public.hr_payroll_runs for each row execute function public.pay_advance_payroll_finalized();
drop trigger if exists pay_advance_people_paid on public.hr_payroll_bank_lines;
create trigger pay_advance_people_paid after insert or update of status on public.hr_payroll_bank_lines for each row execute function public.pay_advance_payroll_finalized();
drop trigger if exists pay_advance_workforce_paid on public.workforce_payout_payment_items;
create trigger pay_advance_workforce_paid after insert or update of status on public.workforce_payout_payment_items for each row execute function public.pay_advance_payroll_finalized();

create or replace function public.pay_advance_publication_saved() returns trigger
language plpgsql security definer set search_path='' as $$
declare lines jsonb;
begin
  if new.publication_kind is distinct from 'worksheet' then return new; end if;
  if extract(day from new.period_start)<>1 or new.period_end<>(new.period_start+interval '1 month - 1 day')::date then
    if jsonb_path_exists(new.snapshot,'$.worksheet.deduction_breakdown[*] ? (@.code == "ADVANCE_RECOVERY")') then raise exception 'Advance deductions require a full monthly payout'; end if;
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(new.company_id::text||':workforce:'||new.workforce_id::text||':paid-advances',0));
  select coalesce(jsonb_agg(jsonb_build_object('advance_id',x.advance_id,'amount',x.amount)),'[]'::jsonb) into lines from (
    select substring(item->>'recoveryKey' from 9)::uuid advance_id,sum((item->>'amount')::numeric) amount
    from (select distinct on (p.station_id) p.snapshot from public.workforce_payout_publications p
      where p.company_id=new.company_id and p.workforce_id=new.workforce_id and p.period_start=new.period_start and p.period_end=new.period_end and p.publication_kind='worksheet'
      order by p.station_id,p.revision desc,p.published_at desc,p.id desc) latest
    cross join lateral jsonb_array_elements(coalesce(latest.snapshot->'worksheet'->'deduction_breakdown','[]'::jsonb)) item
    where item->>'code'='ADVANCE_RECOVERY' and item->>'recoveryKey' like 'ADVANCE:%' group by 1
  )x;
  perform public.pay_advance_reserve(new.company_id,'workforce',new.workforce_id,new.period_start,'workforce',new.workforce_id::text||':'||new.period_start::text,lines);
  return new;
end $$;
drop trigger if exists pay_advance_publication_saved on public.workforce_payout_publications;
create trigger pay_advance_publication_saved after insert on public.workforce_payout_publications for each row execute function public.pay_advance_publication_saved();

CREATE OR REPLACE FUNCTION public.workforce_advance_recovery_snapshot_hash_before_unified(p_company_id uuid, p_period_start date, p_period_end date)
 RETURNS text
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with requested_months as (
    select month_value::date as period_month
    from generate_series(
      date_trunc('month', p_period_start)::date,
      date_trunc('month', p_period_end)::date,
      interval '1 month'
    ) month_value
  ), period_material as (
    select coalesce(string_agg(
      requested.period_month::text || '=' || coalesce(revision.revision, 0)::text,
      ',' order by requested.period_month
    ), '') as value
    from requested_months requested
    left join public.workforce_payout_period_dependency_revisions revision
      on revision.company_id = p_company_id
     and revision.period_month = requested.period_month
  )
  select md5(
    p_company_id::text || ':' ||
    p_period_start::text || ':' ||
    p_period_end::text || ':' ||
    (statement_timestamp() at time zone 'Asia/Kolkata')::date::text || ':' ||
    coalesce(company_revision.revision, 0)::text || ':' ||
    period_material.value
  )
  from period_material
  left join public.workforce_payout_dependency_revisions company_revision
    on company_revision.company_id = p_company_id;
$function$;

create or replace function public.workforce_advance_recovery_snapshot_hash(p_company_id uuid,p_period_start date,p_period_end date)
returns text language sql stable security definer set search_path='' as $$
  select md5(public.workforce_advance_recovery_snapshot_hash_before_unified(p_company_id,p_period_start,p_period_end)||':'||
    coalesce((select jsonb_agg(jsonb_build_array(a.id,a.amount,a.first_due_period,a.installments) order by a.id)::text
      from public.pay_advances a where a.company_id=p_company_id and a.worker_type='workforce' and a.first_due_period<=p_period_end),'[]')||':'||
    coalesce((select jsonb_agg(jsonb_build_array(d.id,d.amount,d.status,d.target_key) order by d.id)::text
      from public.pay_advance_deductions d join public.pay_advances a on a.company_id=d.company_id and a.id=d.advance_id
      where d.company_id=p_company_id and a.worker_type='workforce' and d.period_start<>p_period_start),'[]'));
$$;
revoke all on function public.workforce_advance_recovery_snapshot_hash_before_unified(uuid,date,date) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.hr_loss_payroll_refresh_state(p_company uuid, p_run uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record; due jsonb; bank jsonb; stored_count integer;
begin
  select * into r from public.hr_payroll_runs where company_id=p_company and id=p_run;
  if not found then raise exception 'Payroll run not found'; end if;
  select coalesce(jsonb_agg(to_jsonb(d) order by d.recovery_key),'[]'::jsonb) into due
    from public.nl_loss_recovery_due(p_company,to_char(r.period_start,'YYYY-MM'),'hrms',p_run) d;
  due:=due||coalesce((select jsonb_agg(to_jsonb(a) order by a.advance_id) from public.pay_advance_period_due(p_company,r.period_start,'people',p_run) a),'[]'::jsonb);
  select coalesce(jsonb_agg(jsonb_build_array(b.id,b.status,b.amount,b.updated_at) order by b.id),'[]'::jsonb) into bank
    from public.hr_payroll_bank_lines b where b.company_id=p_company and b.run_id=p_run;
  select count(*) into stored_count from public.hr_payroll_run_items i join public.hr_payroll_run_people p on p.id=i.run_person_id
    where p.company_id=p_company and p.run_id=p_run and i.code in ('OPS_LOSS_RECOVERY','PAY_ADVANCE_RECOVERY','ADVANCE_RECOVERY');
  return jsonb_build_object('due_hash',md5(due::text),'bank_hash',md5(bank::text),'updated_at',r.updated_at,
    'needs_refresh',r.status in ('draft','calculated') and
      (r.settings_snapshot->>'ops_loss_due_hash' is distinct from md5(due::text)
       or r.settings_snapshot->>'ops_loss_bank_hash' is distinct from md5(bank::text)) and
      (r.settings_snapshot ? 'ops_loss_due_hash' or jsonb_array_length(due)>0 or stored_count>0));
end $function$;

revoke all on function public.pay_advance_record_recovery_status(),public.guard_new_manual_payroll_advance(),public.pay_advance_payroll_finalized(),public.pay_advance_publication_saved() from public,anon,authenticated;


CREATE OR REPLACE FUNCTION public.hr_create_pay_advance_request_v2(p_company_id uuid, p_worker_type text, p_worker_id uuid, p_requested_amount numeric, p_recovery_mode text, p_requested_installments integer, p_reason text, p_needed_by date, p_requester uuid, p_steps jsonb, p_outstanding_pay numeric, p_eligibility_percent numeric, p_max_eligible_amount numeric, p_external_reference uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  request_id uuid;
  request_no text;
  worker_name text;
  worker_code text;
  worker_location uuid;
  step jsonb;
  step_number integer := 0;
begin
  if p_company_id is null or p_worker_id is null or p_requester is null or p_worker_type is null or p_requested_amount is null or p_requested_amount='NaN'::numeric or p_max_eligible_amount is null or p_max_eligible_amount='NaN'::numeric then raise exception 'Invalid advance request'; end if;
  if p_worker_type not in ('employee','contractor','workforce') then raise exception 'Invalid workforce category'; end if;
  if p_requested_amount < 500 then raise exception 'Advance amount must be at least 500'; end if;
  if p_outstanding_pay < 0 or p_eligibility_percent <> 25 or p_max_eligible_amount < 0 then
    raise exception 'Advance eligibility snapshot is invalid';
  end if;
  if p_requested_amount > p_max_eligible_amount then
    raise exception 'Advance amount cannot exceed 25%% of outstanding pay';
  end if;
  if p_recovery_mode not in ('one_time','installments') then raise exception 'Invalid recovery method'; end if;
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
    and status in ('pending','approved')) then
    raise exception 'An advance request is already awaiting approval or bank payment for this worker';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_company_id::text||':advance-number',0));
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
    case when p_external_reference is null then 'one_app' else 'payment_advance_requests' end,p_external_reference::text
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
$function$;


create or replace function public.hr_cancel_pay_advance_request(p_company_id uuid,p_payment_advance_request_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_request_id uuid;
begin
  select id into v_request_id from public.hr_pay_advance_requests
  where company_id=p_company_id and (id=p_payment_advance_request_id or
    (external_source='payment_advance_requests' and external_reference=p_payment_advance_request_id::text))
    and status in ('pending','returned') for update;
  if v_request_id is null then return false; end if;
  update public.hr_pay_advance_requests set status='cancelled',current_stage='closed',closed_at=now(),updated_at=now() where id=v_request_id;
  update public.hr_pay_advance_steps set status='skipped',updated_at=now() where request_id=v_request_id and status in ('pending','queued');
  update public.payment_advance_requests set status='cancelled',updated_at=now()
    where company_id=p_company_id and id::text=(select external_reference from public.hr_pay_advance_requests where id=v_request_id)
      and status in ('submitted','in_review');
  return true;
end $$;
revoke all on function public.hr_cancel_pay_advance_request(uuid,uuid) from public,anon,authenticated;
grant execute on function public.hr_cancel_pay_advance_request(uuid,uuid) to service_role;
revoke all on function public.hr_create_pay_advance_request_v2(uuid,text,uuid,numeric,text,integer,text,date,uuid,jsonb,numeric,numeric,numeric,uuid) from public,anon,authenticated;
grant execute on function public.hr_create_pay_advance_request_v2(uuid,text,uuid,numeric,text,integer,text,date,uuid,jsonb,numeric,numeric,numeric,uuid) to service_role;

alter table public.hr_pay_advance_requests add column if not exists email_root_message_id text;
alter table public.hr_pay_advance_requests add column if not exists email_last_message_id text;
alter table public.hr_pay_advance_requests add column if not exists email_send_count integer not null default 0;
alter table public.hr_pay_advance_requests add column if not exists email_next_reminder_at timestamptz;
update public.hr_pay_advance_requests r set email_root_message_id=p.email_root_message_id,
  email_last_message_id=p.email_last_message_id,email_send_count=coalesce(p.email_send_count,0),email_next_reminder_at=p.email_next_reminder_at
from public.payment_advance_requests p where r.company_id=p.company_id and r.external_source='payment_advance_requests'
  and r.external_reference=p.id::text and r.email_root_message_id is null and p.email_root_message_id is not null;
create index if not exists hr_advance_reminder_due on public.hr_pay_advance_requests(email_next_reminder_at) where status='pending';

-- Withdraw write privileges from the retired manual/import interfaces.
revoke execute on function public.workforce_apply_advance_recoveries(uuid,uuid,date,date,jsonb,uuid[]),
 public.workforce_reassign_advance(uuid,uuid,uuid,uuid,integer,text,uuid,uuid[]),
 public.workforce_apply_advance_import(uuid,text,text,jsonb,uuid,uuid[]),
 public.hr_create_pay_advance_request(uuid,text,uuid,numeric,text,integer,text,date,uuid,jsonb),
 public.hr_record_pay_advance_recovery(uuid,uuid,uuid,numeric,text,text),
 public.hr_sync_external_pay_advance(uuid,text,text,text,uuid,text,text,uuid,numeric,text,text,integer,uuid)
 from public,anon,authenticated,service_role;
revoke insert,update,delete on public.workforce_advances,public.workforce_advance_recoveries,public.payment_advance_requests from anon,authenticated,service_role;

create or replace function public.pay_advance_queue_payout_refresh() returns trigger
language plpgsql security definer set search_path='' as $$
declare a public.pay_advances%rowtype; location record; refresh_from date;
begin
  if tg_table_name='pay_advances' then a:=new; refresh_from:=a.first_due_period;
  else select * into a from public.pay_advances where company_id=new.company_id and id=new.advance_id; refresh_from:=(new.period_start+interval '1 month')::date; end if;
  if a.worker_type='workforce' and a.worker_id is not null then
    for location in select distinct station_id from public.workforce_payout_publications
      where company_id=a.company_id and workforce_id=a.worker_id and period_end>=a.first_due_period loop
      perform public.enqueue_workforce_payout_dependency_refresh(a.company_id,a.worker_id,location.station_id,
        refresh_from,
        '9999-12-31'::date,null);
    end loop;
  end if;
  return new;
end $$;
drop trigger if exists pay_advance_refresh_paid on public.pay_advances;
create trigger pay_advance_refresh_paid after insert on public.pay_advances for each row execute function public.pay_advance_queue_payout_refresh();
drop trigger if exists pay_advance_refresh_recovery on public.pay_advance_deductions;
create trigger pay_advance_refresh_recovery after insert or update on public.pay_advance_deductions for each row execute function public.pay_advance_queue_payout_refresh();
revoke all on function public.pay_advance_queue_payout_refresh() from public,anon,authenticated;
CREATE OR REPLACE FUNCTION public.hr_decide_pay_advance_step(p_company_id uuid, p_request_id uuid, p_actor_user_id uuid, p_decision text, p_note text, p_approved_amount numeric, p_approved_installments integer)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    recovery_mode=case when coalesce(p_approved_installments,request_row.requested_installments)>1 then 'installments' else 'one_time' end,
    decided_by=p_actor_user_id,decided_at=now(),decision_note=nullif(btrim(p_note),'') where id=p_request_id;
  insert into public.hr_audit_log(company_id,actor_user_id,entity_type,entity_id,action,after_data)
  values(p_company_id,p_actor_user_id,'pay_advance_request',p_request_id,'finance_approve',
    jsonb_build_object('approved_amount',v_amount,'comment',nullif(btrim(p_note),'')));
  perform public.hr_pay_advance_send_to_payment(p_company_id,p_request_id,p_actor_user_id);
  return 'approved';
end;
$function$;


revoke all on function public.hr_mark_pay_advance_disbursed(uuid,uuid,uuid,text,text),
 public.hr_schedule_pay_advance_recoveries(uuid,uuid),
 public.hr_replace_payroll_run_snapshot(uuid,uuid,date,date,jsonb,jsonb,jsonb,uuid),
 public.hr_transition_payroll_run(uuid,uuid,text,uuid),public.hr_loss_payroll_refresh_state(uuid,uuid),
 public.hr_decide_pay_advance_step(uuid,uuid,uuid,text,text,numeric,integer)
 from public,anon,authenticated;
grant execute on function public.hr_mark_pay_advance_disbursed(uuid,uuid,uuid,text,text),
 public.hr_replace_payroll_run_snapshot(uuid,uuid,date,date,jsonb,jsonb,jsonb,uuid),
 public.hr_transition_payroll_run(uuid,uuid,text,uuid),public.hr_loss_payroll_refresh_state(uuid,uuid),
 public.hr_decide_pay_advance_step(uuid,uuid,uuid,text,text,numeric,integer) to service_role;
commit;
