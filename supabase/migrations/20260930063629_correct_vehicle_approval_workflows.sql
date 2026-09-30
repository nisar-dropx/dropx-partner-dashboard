-- Fleet-owned payment heads must be approved by Fleet, then the Business Head.
-- Finance remains a processor only. Restart every still-open affected request
-- at Fleet so records created under the superseded Ops workflow are corrected.

begin;

do $$
declare
  v_company record;
  v_head record;
  v_request record;
  v_fleet_role uuid;
  v_business_role uuid;
  v_national_role uuid;
  v_fleet_user uuid;
  v_final_candidates jsonb;
  v_snapshot jsonb;
begin
  for v_company in
    select distinct company_id
    from public.payment_heads
    where code in ('VAN_FUEL', 'VEHICLE_SERVICE', 'VEHICLE_REPAIR')
      and is_active = true
  loop
    select id into v_fleet_role
    from public.user_roles
    where company_id = v_company.company_id
      and code = 'OPERATIONS_FLTM'
      and is_active = true;

    select id into v_business_role
    from public.user_roles
    where company_id = v_company.company_id
      and code = 'OPERATIONS_BH'
      and is_active = true;

    select id into v_national_role
    from public.user_roles
    where company_id = v_company.company_id
      and code = 'OPERATIONS_NH'
      and is_active = true;

    if v_fleet_role is null or v_business_role is null then
      raise exception 'Cannot configure fleet approvals for company %: Fleet Manager and Business Head roles are required', v_company.company_id;
    end if;

    -- Resolve from People positions first, then the active product membership,
    -- and retain profile.role_id only as the final legacy fallback.
    with candidates as (
      select assignment.profile_id as user_id, 1 as source_priority,
             case when assignment.assignment_type = 'acting' then 0 else 1 end as assignment_priority,
             assignment.valid_from, assignment.created_at, profile.full_name
      from public.org_positions position
      join public.position_assignments assignment
        on assignment.company_id = v_company.company_id
       and assignment.position_id = position.id
       and assignment.is_active = true
       and assignment.valid_from <= current_date
       and (assignment.valid_until is null or assignment.valid_until >= current_date)
      join public.profiles profile
        on profile.id = assignment.profile_id
       and profile.company_id = v_company.company_id
       and profile.is_active = true
      where position.company_id = v_company.company_id
        and position.role_id = v_fleet_role
        and position.is_active = true

      union all

      select membership.user_id, 2 as source_priority, 0 as assignment_priority,
             null::date as valid_from, membership.created_at, profile.full_name
      from public.company_product_memberships membership
      join public.profiles profile
        on profile.id = membership.user_id
       and profile.company_id = v_company.company_id
       and profile.is_active = true
      where membership.company_id = v_company.company_id
        and membership.role_id = v_fleet_role
        and membership.is_active = true

      union all

      select profile.id, 3 as source_priority, 0 as assignment_priority,
             null::date as valid_from, profile.created_at, profile.full_name
      from public.profiles profile
      where profile.company_id = v_company.company_id
        and profile.role_id = v_fleet_role
        and profile.is_active = true
    )
    select candidate.user_id
    into v_fleet_user
    from candidates candidate
    order by candidate.source_priority, candidate.assignment_priority,
             candidate.valid_from desc nulls last,
             candidate.created_at desc nulls last, candidate.full_name
    limit 1;

    if v_fleet_user is null then
      raise exception 'Cannot configure fleet approvals for company %: no active Fleet Manager is assigned', v_company.company_id;
    end if;

    v_final_candidates := jsonb_build_array(
      jsonb_build_object('role_id', v_business_role, 'scope', 'company')
    );
    if v_national_role is not null then
      v_final_candidates := v_final_candidates || jsonb_build_array(
        jsonb_build_object('role_id', v_national_role, 'scope', 'company')
      );
    end if;

    for v_head in
      select id, code
      from public.payment_heads
      where company_id = v_company.company_id
        and code in ('VAN_FUEL', 'VEHICLE_SERVICE', 'VEHICLE_REPAIR')
        and is_active = true
    loop
      delete from public.payment_head_approval_steps
      where company_id = v_company.company_id
        and payment_head_id = v_head.id;

      insert into public.payment_head_approval_steps
        (company_id, payment_head_id, step_order, candidates, is_required)
      values
        (
          v_company.company_id,
          v_head.id,
          1,
          jsonb_build_array(jsonb_build_object('role_id', v_fleet_role, 'scope', 'company')),
          true
        ),
        (
          v_company.company_id,
          v_head.id,
          2,
          v_final_candidates,
          true
        );

      update public.payment_heads
      set initial_approval_role_id = v_fleet_role,
          initial_approval_role_ids = array[v_fleet_role],
          final_approval_role_id = v_business_role,
          final_approval_role_ids = case
            when v_national_role is null then array[v_business_role]
            else array[v_business_role, v_national_role]
          end,
          updated_at = now()
      where id = v_head.id
        and company_id = v_company.company_id;

      select jsonb_agg(
        jsonb_build_object(
          'step_order', step_order,
          'candidates', candidates,
          'is_required', is_required
        ) order by step_order
      )
      into v_snapshot
      from public.payment_head_approval_steps
      where company_id = v_company.company_id
        and payment_head_id = v_head.id;

      insert into public.payment_audit_events(event, actor_role, remarks)
      values (
        'approval_master_corrected',
        'SYSTEM_MIGRATION',
        jsonb_build_object(
          'payment_head_id', v_head.id,
          'payment_head_code', v_head.code,
          'workflow', 'Fleet Manager required -> Business Head required',
          'finance_mode', 'processing_only',
          'reason', 'Removed superseded CLM/AOM and Finance approval steps'
        )::text
      );

      for v_request in
        select request.id, request.request_no, request.approval_cycle,
               request.current_approver_user_id, request.current_approver_role_id,
               request.current_step_order, request.total_steps,
               request.status, request.approval_status
        from public.payment_requests request
        where request.company_id = v_company.company_id
          and request.payment_head_id = v_head.id
          and upper(coalesce(request.status, '')) not in
            ('APPROVED', 'FINAL_APPROVED', 'PROCESSED', 'PROCESSING', 'RETURNED', 'REJECTED', 'CANCELLED')
          and upper(coalesce(request.approval_status, '')) not in
            ('FINAL_APPROVED', 'PROCESSED', 'PROCESSING', 'RETURNED', 'REJECTED', 'CANCELLED')
        for update of request
      loop
        insert into public.payment_audit_events(event, actor_role, remarks)
        values (
          'pending_approval_reconciled',
          'SYSTEM_MIGRATION',
          jsonb_build_object(
            'request_id', v_request.id,
            'request_no', v_request.request_no,
            'payment_head_code', v_head.code,
            'previous_status', v_request.status,
            'previous_approval_status', v_request.approval_status,
            'previous_approver_user_id', v_request.current_approver_user_id,
            'previous_approver_role_id', v_request.current_approver_role_id,
            'previous_step_order', v_request.current_step_order,
            'previous_total_steps', v_request.total_steps,
            'new_approver_user_id', v_fleet_user,
            'new_approver_role_id', v_fleet_role,
            'source', 'Fleet-owned payment workflow correction'
          )::text
        );

        update public.payment_requests
        set status = 'pending',
            approval_status = 'PENDING',
            approval_cycle = coalesce(v_request.approval_cycle, 1) + 1,
            current_step_order = 1,
            total_steps = 2,
            approval_steps_snapshot = coalesce(v_snapshot, '[]'::jsonb),
            current_approver_user_id = v_fleet_user,
            current_approver_role_id = v_fleet_role,
            current_approver_role_ids = array[v_fleet_role],
            final_approval_role_id = v_business_role,
            final_approval_role_ids = case
              when v_national_role is null then array[v_business_role]
              else array[v_business_role, v_national_role]
            end,
            email_next_reminder_at = now(),
            updated_at = now()
        where id = v_request.id
          and company_id = v_company.company_id;
      end loop;
    end loop;
  end loop;
end;
$$;

commit;
