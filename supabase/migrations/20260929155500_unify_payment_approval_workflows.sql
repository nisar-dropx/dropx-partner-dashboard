-- Make ordered approval steps the single workflow source of truth.
-- Finance roles remain payment processors only. The high-volume ad-hoc heads
-- use three sequential approvals resolved from current People position data:
-- optional CLM -> optional AOM -> required Business Head (National Head fallback).

begin;

do $$
declare
  v_company record;
  v_head record;
  v_clm uuid;
  v_aom uuid;
  v_bh uuid;
  v_nh uuid;
  v_final_candidates jsonb;
begin
  for v_company in
    select distinct company_id
    from public.payment_heads
    where code in ('ADHOC_DA', 'ADHOC_DRIVER', 'VAN_ADHOC')
  loop
    select id into v_clm from public.user_roles
      where company_id = v_company.company_id and code = 'OPERATIONS_CLM' and is_active = true;
    select id into v_aom from public.user_roles
      where company_id = v_company.company_id and code = 'OPERATIONS_AOM' and is_active = true;
    select id into v_bh from public.user_roles
      where company_id = v_company.company_id and code = 'OPERATIONS_BH' and is_active = true;
    select id into v_nh from public.user_roles
      where company_id = v_company.company_id and code = 'OPERATIONS_NH' and is_active = true;

    if v_clm is null or v_aom is null or v_bh is null then
      raise exception 'Cannot configure payment approvals for company %: CLM, AOM and BH roles are required', v_company.company_id;
    end if;

    v_final_candidates := jsonb_build_array(jsonb_build_object('role_id', v_bh, 'scope', 'company'));
    if v_nh is not null then
      v_final_candidates := v_final_candidates || jsonb_build_array(jsonb_build_object('role_id', v_nh, 'scope', 'company'));
    end if;

    for v_head in
      select id, code from public.payment_heads
      where company_id = v_company.company_id
        and code in ('ADHOC_DA', 'ADHOC_DRIVER', 'VAN_ADHOC')
        and is_active = true
    loop
      delete from public.payment_head_approval_steps
      where company_id = v_company.company_id and payment_head_id = v_head.id;

      insert into public.payment_head_approval_steps
        (company_id, payment_head_id, step_order, candidates, is_required)
      values
        (v_company.company_id, v_head.id, 1,
          jsonb_build_array(jsonb_build_object('role_id', v_clm, 'scope', 'station')), false),
        (v_company.company_id, v_head.id, 2,
          jsonb_build_array(jsonb_build_object('role_id', v_aom, 'scope', 'station')), false),
        (v_company.company_id, v_head.id, 3, v_final_candidates, true);

      update public.payment_heads
      set initial_approval_role_id = v_clm,
          initial_approval_role_ids = array[v_clm, v_aom],
          final_approval_role_id = v_bh,
          final_approval_role_ids = case when v_nh is null then array[v_bh] else array[v_bh, v_nh] end,
          updated_at = now()
      where id = v_head.id and company_id = v_company.company_id;

      insert into public.payment_audit_events(event, actor_role, remarks)
      values (
        'approval_master_corrected',
        'SYSTEM_MIGRATION',
        jsonb_build_object(
          'payment_head_id', v_head.id,
          'payment_head_code', v_head.code,
          'workflow', 'CLM optional -> AOM optional -> Business Head required',
          'approver_source', 'People org_positions and position_assignments',
          'finance_mode', 'processing_only'
        )::text
      );
    end loop;
  end loop;
end;
$$;

-- Remove every payment processor role from approval candidates on all heads.
-- This is derived from each head's processor configuration rather than from
-- hardcoded Finance role ids.
do $$
declare
  v_step record;
  v_candidates jsonb;
  v_head record;
  v_order integer;
begin
  for v_step in
    select step.id, step.company_id, step.payment_head_id, step.candidates,
           coalesce(head.payment_process_role_ids, '{}'::uuid[]) as processor_role_ids
    from public.payment_head_approval_steps step
    join public.payment_heads head
      on head.id = step.payment_head_id and head.company_id = step.company_id
    for update of step
  loop
    select jsonb_agg(candidate order by ordinal)
    into v_candidates
    from jsonb_array_elements(v_step.candidates) with ordinality item(candidate, ordinal)
    where not ((candidate ->> 'role_id')::uuid = any(v_step.processor_role_ids));

    if v_candidates is null then
      delete from public.payment_head_approval_steps where id = v_step.id;
    elsif v_candidates is distinct from v_step.candidates then
      update public.payment_head_approval_steps
      set candidates = v_candidates, updated_at = now()
      where id = v_step.id;
    end if;
  end loop;

  -- Compress any gaps left by removed processor-only steps.
  for v_head in
    select distinct company_id, payment_head_id
    from public.payment_head_approval_steps
  loop
    v_order := 0;
    for v_step in
      select id, step_order
      from public.payment_head_approval_steps
      where company_id = v_head.company_id and payment_head_id = v_head.payment_head_id
      order by step_order
    loop
      v_order := v_order + 1;
      if v_step.step_order <> v_order then
        update public.payment_head_approval_steps
        set step_order = v_order, updated_at = now()
        where id = v_step.id;
      end if;
    end loop;
  end loop;

  -- Keep legacy columns as a read-compatible mirror; ordered steps remain authoritative.
  update public.payment_heads head
  set initial_approval_role_id = mirror.initial_roles[1],
      initial_approval_role_ids = mirror.initial_roles,
      final_approval_role_id = mirror.final_roles[1],
      final_approval_role_ids = mirror.final_roles,
      updated_at = now()
  from (
    select payment_head_id,
      array(select (candidate ->> 'role_id')::uuid from jsonb_array_elements(first_step.candidates) candidate) as initial_roles,
      array(select (candidate ->> 'role_id')::uuid from jsonb_array_elements(last_step.candidates) candidate) as final_roles
    from (
      select distinct on (payment_head_id) payment_head_id, candidates
      from public.payment_head_approval_steps order by payment_head_id, step_order
    ) first_step
    join lateral (
      select candidates from public.payment_head_approval_steps last_row
      where last_row.payment_head_id = first_step.payment_head_id
      order by step_order desc limit 1
    ) last_step on true
  ) mirror
  where head.id = mirror.payment_head_id;
end;
$$;

-- Requests that already completed Business Head approval but were left on an
-- obsolete Finance approval step are approval-complete and move to processing.
do $$
declare
  v_request record;
  v_step_count integer;
  v_snapshot jsonb;
begin
  for v_request in
    select request.id, request.request_no, request.company_id, request.payment_head_id,
           request.status, request.approval_status
    from public.payment_requests request
    join public.payment_heads head
      on head.id = request.payment_head_id and head.company_id = request.company_id
    where request.current_approver_role_id = any(coalesce(head.payment_process_role_ids, '{}'::uuid[]))
      and upper(coalesce(request.approval_status, request.status, '')) like '%BH_APPROVED'
      and lower(coalesce(request.status, '')) not in ('approved', 'processed', 'processing', 'returned', 'rejected', 'cancelled')
    for update of request
  loop
    select count(*), jsonb_agg(
      jsonb_build_object('step_order', step_order, 'candidates', candidates, 'is_required', is_required)
      order by step_order
    )
    into v_step_count, v_snapshot
    from public.payment_head_approval_steps
    where company_id = v_request.company_id and payment_head_id = v_request.payment_head_id;

    insert into public.payment_audit_events(event, actor_role, remarks)
    values (
      'legacy_finance_approval_cleared',
      'SYSTEM_MIGRATION',
      jsonb_build_object(
        'request_id', v_request.id,
        'request_no', v_request.request_no,
        'before_status', v_request.status,
        'before_approval_status', v_request.approval_status,
        'reason', 'Business Head approval was complete; Finance is payment processing only'
      )::text
    );

    update public.payment_requests
    set status = 'approved',
        approval_status = 'FINAL_APPROVED',
        current_step_order = greatest(v_step_count, 1),
        total_steps = v_step_count,
        approval_steps_snapshot = coalesce(v_snapshot, '[]'::jsonb),
        current_approver_user_id = null,
        current_approver_role_id = null,
        current_approver_role_ids = '{}'::uuid[],
        email_next_reminder_at = null,
        updated_at = now()
    where id = v_request.id and company_id = v_request.company_id;
  end loop;
end;
$$;

-- Preserve completed approvals on still-pending ad-hoc requests while mapping
-- their current role to the new three-step sequence. No completed history is rewritten.
update public.payment_requests request
set current_step_order = case role.code
      when 'OPERATIONS_CLM' then 1
      when 'OPERATIONS_AOM' then 2
      when 'OPERATIONS_BH' then 3
      when 'OPERATIONS_NH' then 3
      else request.current_step_order
    end,
    total_steps = 3,
    approval_steps_snapshot = (
      select jsonb_agg(
        jsonb_build_object('step_order', step.step_order, 'candidates', step.candidates, 'is_required', step.is_required)
        order by step.step_order
      )
      from public.payment_head_approval_steps step
      where step.company_id = request.company_id and step.payment_head_id = request.payment_head_id
    ),
    updated_at = now()
from public.payment_heads head
join public.user_roles role on role.company_id = head.company_id
where head.id = request.payment_head_id
  and head.company_id = request.company_id
  and role.id = request.current_approver_role_id
  and head.code in ('ADHOC_DA', 'ADHOC_DRIVER', 'VAN_ADHOC')
  and lower(coalesce(request.status, '')) not in ('approved', 'processed', 'processing', 'returned', 'rejected', 'cancelled');

commit;
