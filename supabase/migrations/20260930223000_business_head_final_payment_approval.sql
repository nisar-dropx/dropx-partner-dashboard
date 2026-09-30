-- Business Head is the final payment approver. National Head is the fallback
-- in that same final step. Finance and Accounts receive completed requests in
-- the processing queue and never hold an approval step.

begin;

do $$
declare
  v_company uuid := '43866344-b550-4e8a-9a2d-9d23f3d8a997';
  v_clm uuid;
  v_cm uuid;
  v_aom uuid;
  v_rm uuid;
  v_bh uuid;
  v_nh uuid;
  v_head record;
  v_head_count integer;
  v_final_candidates jsonb;
begin
  select id into v_clm from public.user_roles
  where company_id = v_company and code = 'OPERATIONS_CLM' and is_active;
  select id into v_cm from public.user_roles
  where company_id = v_company and code = 'OPERATIONS_CM' and is_active;
  select id into v_aom from public.user_roles
  where company_id = v_company and code = 'OPERATIONS_AOM' and is_active;
  select id into v_rm from public.user_roles
  where company_id = v_company and code = 'OPERATIONS_RM' and is_active;
  select id into v_bh from public.user_roles
  where company_id = v_company and code = 'OPERATIONS_BH' and is_active;
  select id into v_nh from public.user_roles
  where company_id = v_company and code = 'OPERATIONS_NH' and is_active;

  if v_clm is null or v_cm is null or v_aom is null or v_rm is null or v_bh is null then
    raise exception 'Required Operations approval roles are missing; no payment workflow was changed.';
  end if;

  select count(*) into v_head_count
  from public.payment_heads
  where company_id = v_company
    and is_active
    and code in ('ADHOC_DA', 'ADHOC_DRIVER', 'BROADBAND_CHARGE', 'CEANING_EXP',
                 'DRINKING_WATER', 'ELECTRICITY_BILL', 'OFFICE_STATIONARY', 'VAN_ADHOC');
  if v_head_count <> 8 then
    raise exception 'Expected 8 Operations heads with the obsolete Finance approval step, found %; no workflow was changed.', v_head_count;
  end if;

  v_final_candidates := jsonb_build_array(jsonb_build_object('role_id', v_bh, 'scope', 'company'));
  if v_nh is not null then
    v_final_candidates := v_final_candidates || jsonb_build_array(jsonb_build_object('role_id', v_nh, 'scope', 'company'));
  end if;

  for v_head in
    select id, code
    from public.payment_heads
    where company_id = v_company
      and is_active
      and code in ('ADHOC_DA', 'ADHOC_DRIVER', 'BROADBAND_CHARGE', 'CEANING_EXP',
                   'DRINKING_WATER', 'ELECTRICITY_BILL', 'OFFICE_STATIONARY', 'VAN_ADHOC')
    order by code
  loop
    delete from public.payment_head_approval_steps
    where company_id = v_company and payment_head_id = v_head.id;

    insert into public.payment_head_approval_steps
      (company_id, payment_head_id, step_order, candidates, is_required, created_at, updated_at)
    values
      (v_company, v_head.id, 1,
        jsonb_build_array(
          jsonb_build_object('role_id', v_clm, 'scope', 'station'),
          jsonb_build_object('role_id', v_cm, 'scope', 'station'),
          jsonb_build_object('role_id', v_aom, 'scope', 'station')
        ), false, now(), now()),
      (v_company, v_head.id, 2,
        jsonb_build_array(
          jsonb_build_object('role_id', v_aom, 'scope', 'station'),
          jsonb_build_object('role_id', v_rm, 'scope', 'station')
        ), false, now(), now()),
      (v_company, v_head.id, 3, v_final_candidates, true, now(), now());

    update public.payment_heads
    set initial_approval_role_id = v_clm,
        initial_approval_role_ids = array[v_clm, v_cm, v_aom],
        final_approval_role_id = v_bh,
        final_approval_role_ids = case when v_nh is null then array[v_bh] else array[v_bh, v_nh] end,
        updated_at = now()
    where company_id = v_company and id = v_head.id;

    insert into public.payment_audit_events (event, actor_role, remarks)
    values (
      'business_head_final_approval_configured',
      'SYSTEM_MIGRATION',
      jsonb_build_object(
        'payment_head_id', v_head.id,
        'payment_head_code', v_head.code,
        'workflow', 'CLM/CM/AOM optional -> AOM/RM optional -> Business Head required (National Head fallback)',
        'finance_mode', 'processing_only'
      )::text
    );
  end loop;
end;
$$;

-- Requests waiting only for the removed Finance / Accounts approval are
-- complete. Finalize them and retain a record of the automatic transition.
with workflows as (
  select
    step.company_id,
    step.payment_head_id,
    count(*)::int as step_count,
    jsonb_agg(
      jsonb_build_object(
        'step_order', step.step_order,
        'candidates', step.candidates,
        'is_required', step.is_required
      ) order by step.step_order
    ) as step_snapshot
  from public.payment_head_approval_steps step
  join public.payment_heads head
    on head.id = step.payment_head_id and head.company_id = step.company_id
  where step.company_id = '43866344-b550-4e8a-9a2d-9d23f3d8a997'
    and head.code in ('ADHOC_DA', 'ADHOC_DRIVER', 'BROADBAND_CHARGE', 'CEANING_EXP',
                      'DRINKING_WATER', 'ELECTRICITY_BILL', 'OFFICE_STATIONARY', 'VAN_ADHOC')
  group by step.company_id, step.payment_head_id
), finance_roles as (
  select id
  from public.user_roles
  where company_id = '43866344-b550-4e8a-9a2d-9d23f3d8a997'
    and is_active
    and code in ('OPERATIONS_FINMGR', 'OPERATIONS_ACCOUNTS', 'FINANCE_FINMGR',
                 'FINANCE_ACCOUNTS', 'FINANCE_ACE', 'ACCOUNTS', 'WORKFORCE_ACCOUNTS')
), finance_waiting as (
  select request.id, request.request_no, request.company_id, request.payment_head_id,
         request.status as previous_status, request.approval_status as previous_approval_status,
         workflow.step_count, workflow.step_snapshot
  from public.payment_requests request
  join workflows workflow
    on workflow.company_id = request.company_id and workflow.payment_head_id = request.payment_head_id
  where upper(coalesce(request.status, '')) not in
      ('APPROVED', 'FINAL_APPROVED', 'PROCESSED', 'PROCESSING', 'RETURNED', 'REJECTED', 'CANCELLED')
    and upper(coalesce(request.approval_status, '')) not in
      ('FINAL_APPROVED', 'PROCESSED', 'PROCESSING', 'RETURNED', 'REJECTED', 'CANCELLED')
    and (
      request.current_approver_role_id in (select id from finance_roles)
      or exists (
        select 1
        from jsonb_array_elements(coalesce(request.approval_steps_snapshot, '[]'::jsonb)) step
        cross join lateral jsonb_array_elements(coalesce(step->'candidates', '[]'::jsonb)) candidate
        where coalesce((step->>'step_order')::int, 0) = request.current_step_order
          and (candidate->>'role_id')::uuid in (select id from finance_roles)
      )
    )
), finalized as (
  update public.payment_requests request
  set status = 'approved',
      approval_status = 'FINAL_APPROVED',
      current_step_order = finance_waiting.step_count,
      total_steps = finance_waiting.step_count,
      approval_steps_snapshot = finance_waiting.step_snapshot,
      current_approver_user_id = null,
      current_approver_role_id = null,
      current_approver_role_ids = '{}'::uuid[],
      email_next_reminder_at = null,
      updated_at = now()
  from finance_waiting
  where request.id = finance_waiting.id
    and request.company_id = finance_waiting.company_id
  returning request.id, finance_waiting.request_no, finance_waiting.previous_status,
    finance_waiting.previous_approval_status
)
insert into public.payment_audit_events (request_id, event, actor_role, remarks)
select
  finalized.id,
  'finance_approval_removed_request_finalized',
  'SYSTEM_MIGRATION',
  jsonb_build_object(
    'request_no', finalized.request_no,
    'previous_status', finalized.previous_status,
    'previous_approval_status', finalized.previous_approval_status,
    'reason', 'Business Head was the final approver; Finance and Accounts process the approved payment'
  )::text
from finalized;

-- Keep active manager-stage requests aligned with the three-step workflow.
with workflows as (
  select
    step.company_id,
    step.payment_head_id,
    count(*)::int as step_count,
    jsonb_agg(
      jsonb_build_object(
        'step_order', step.step_order,
        'candidates', step.candidates,
        'is_required', step.is_required
      ) order by step.step_order
    ) as step_snapshot
  from public.payment_head_approval_steps step
  join public.payment_heads head
    on head.id = step.payment_head_id and head.company_id = step.company_id
  where step.company_id = '43866344-b550-4e8a-9a2d-9d23f3d8a997'
    and head.code in ('ADHOC_DA', 'ADHOC_DRIVER', 'BROADBAND_CHARGE', 'CEANING_EXP',
                      'DRINKING_WATER', 'ELECTRICITY_BILL', 'OFFICE_STATIONARY', 'VAN_ADHOC')
  group by step.company_id, step.payment_head_id
)
update public.payment_requests request
set total_steps = workflow.step_count,
    approval_steps_snapshot = workflow.step_snapshot,
    updated_at = now()
from workflows workflow
where request.company_id = workflow.company_id
  and request.payment_head_id = workflow.payment_head_id
  and coalesce(request.current_step_order, 1) <= workflow.step_count
  and upper(coalesce(request.status, '')) not in
      ('APPROVED', 'FINAL_APPROVED', 'PROCESSED', 'PROCESSING', 'RETURNED', 'REJECTED', 'CANCELLED')
  and upper(coalesce(request.approval_status, '')) not in
      ('FINAL_APPROVED', 'PROCESSED', 'PROCESSING', 'RETURNED', 'REJECTED', 'CANCELLED');

commit;
