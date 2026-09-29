-- Correct Van Fuel to its business-owned approval chain:
-- Location request -> Fleet Manager -> Business Head -> Finance processing.

begin;

do $$
declare
  v_company record;
  v_head record;
  v_request record;
  v_fleet_manager uuid;
  v_business_head uuid;
  v_national_head uuid;
  v_final_candidates jsonb;
  v_snapshot jsonb;
  v_min_step integer;
  v_target_step integer;
  v_target_role uuid;
  v_target_user uuid;
begin
  for v_company in
    select distinct company_id
    from public.payment_heads
    where code = 'VAN_FUEL' and is_active = true
  loop
    select id into v_fleet_manager from public.user_roles
      where company_id = v_company.company_id and code = 'OPERATIONS_FLTM' and is_active = true;
    select id into v_business_head from public.user_roles
      where company_id = v_company.company_id and code = 'OPERATIONS_BH' and is_active = true;
    select id into v_national_head from public.user_roles
      where company_id = v_company.company_id and code = 'OPERATIONS_NH' and is_active = true;

    if v_fleet_manager is null or v_business_head is null then
      raise exception 'Cannot configure Van Fuel approvals for company %: Fleet Manager and Business Head roles are required', v_company.company_id;
    end if;

    v_final_candidates := jsonb_build_array(
      jsonb_build_object('role_id', v_business_head, 'scope', 'company')
    );
    if v_national_head is not null then
      v_final_candidates := v_final_candidates || jsonb_build_array(
        jsonb_build_object('role_id', v_national_head, 'scope', 'company')
      );
    end if;

    for v_head in
      select id, code
      from public.payment_heads
      where company_id = v_company.company_id and code = 'VAN_FUEL' and is_active = true
    loop
      delete from public.payment_head_approval_steps
      where company_id = v_company.company_id and payment_head_id = v_head.id;

      insert into public.payment_head_approval_steps
        (company_id, payment_head_id, step_order, candidates, is_required)
      values
        (v_company.company_id, v_head.id, 1,
          jsonb_build_array(jsonb_build_object('role_id', v_fleet_manager, 'scope', 'company')), true),
        (v_company.company_id, v_head.id, 2, v_final_candidates, true);

      update public.payment_heads
      set request_expense_approval = true,
          initial_approval_role_id = v_fleet_manager,
          initial_approval_role_ids = array[v_fleet_manager],
          final_approval_role_id = v_business_head,
          final_approval_role_ids = case
            when v_national_head is null then array[v_business_head]
            else array[v_business_head, v_national_head]
          end,
          updated_at = now()
      where id = v_head.id and company_id = v_company.company_id;

      select jsonb_agg(
        jsonb_build_object('step_order', step_order, 'candidates', candidates, 'is_required', is_required)
        order by step_order
      )
      into v_snapshot
      from public.payment_head_approval_steps
      where company_id = v_company.company_id and payment_head_id = v_head.id;

      insert into public.payment_audit_events(event, actor_role, remarks)
      values (
        'approval_master_corrected',
        'SYSTEM_MIGRATION',
        jsonb_build_object(
          'payment_head_id', v_head.id,
          'payment_head_code', v_head.code,
          'workflow', 'Fleet Manager required -> Business Head required',
          'approver_source', 'Payment Head Master with live role membership',
          'finance_mode', 'processing_only'
        )::text
      );

      for v_request in
        select request.id, request.request_no, request.status, request.approval_status,
               request.current_approver_user_id, request.current_approver_role_id,
               role.code as current_role_code
        from public.payment_requests request
        left join public.user_roles role
          on role.id = request.current_approver_role_id and role.company_id = request.company_id
        where request.company_id = v_company.company_id
          and request.payment_head_id = v_head.id
          and lower(coalesce(request.status, '')) not in
            ('approved', 'processed', 'processing', 'returned', 'rejected', 'cancelled')
        for update of request
      loop
        v_min_step := case v_request.current_role_code
          when 'OPERATIONS_BH' then 2
          when 'OPERATIONS_NH' then 2
          else 1
        end;
        v_target_step := null;
        v_target_role := null;
        v_target_user := null;

        with candidate_roles(step_order, candidate_priority, role_id) as (
          values
            (1, 1, v_fleet_manager),
            (2, 1, v_business_head),
            (2, 2, v_national_head)
        ),
        eligible_roles as (
          select * from candidate_roles
          where role_id is not null and step_order >= v_min_step
        ),
        possible_targets as (
          select eligible.step_order, eligible.candidate_priority, eligible.role_id,
                 assignment.profile_id as user_id, 1 as source_priority,
                 case when assignment.assignment_type = 'acting' then 0 else 1 end as assignment_priority,
                 assignment.valid_from, assignment.created_at, profile.full_name
          from eligible_roles eligible
          join public.org_positions position
            on position.company_id = v_company.company_id
           and position.role_id = eligible.role_id
           and position.is_active = true
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

          union all

          select eligible.step_order, eligible.candidate_priority, eligible.role_id,
                 membership.user_id, 2 as source_priority, 0 as assignment_priority,
                 null::date as valid_from, membership.created_at, profile.full_name
          from eligible_roles eligible
          join public.company_product_memberships membership
            on membership.company_id = v_company.company_id
           and membership.role_id = eligible.role_id
           and membership.is_active = true
          join public.profiles profile
            on profile.id = membership.user_id
           and profile.company_id = v_company.company_id
           and profile.is_active = true

          union all

          select eligible.step_order, eligible.candidate_priority, eligible.role_id,
                 profile.id as user_id, 3 as source_priority, 0 as assignment_priority,
                 null::date as valid_from, profile.created_at, profile.full_name
          from eligible_roles eligible
          join public.profiles profile
            on profile.company_id = v_company.company_id
           and profile.role_id = eligible.role_id
           and profile.is_active = true
        )
        select target.step_order, target.role_id, target.user_id
        into v_target_step, v_target_role, v_target_user
        from possible_targets target
        order by target.step_order, target.candidate_priority, target.source_priority,
                 target.assignment_priority, target.valid_from desc nulls last,
                 target.created_at desc nulls last, target.full_name
        limit 1;

        insert into public.payment_audit_events(event, actor_role, remarks)
        values (
          'pending_approval_reconciled',
          'SYSTEM_MIGRATION',
          jsonb_build_object(
            'request_id', v_request.id,
            'request_no', v_request.request_no,
            'payment_head_code', v_head.code,
            'previous_role_id', v_request.current_approver_role_id,
            'new_role_id', v_target_role,
            'new_step_order', coalesce(v_target_step, v_min_step),
            'source', 'Corrected Van Fuel approval master'
          )::text
        );

        update public.payment_requests
        set current_step_order = coalesce(v_target_step, v_min_step),
            total_steps = 2,
            approval_steps_snapshot = coalesce(v_snapshot, '[]'::jsonb),
            current_approver_user_id = v_target_user,
            current_approver_role_id = v_target_role,
            current_approver_role_ids = case
              when v_target_role is not null then array[v_target_role]
              when v_min_step = 1 then array[v_fleet_manager]
              when v_national_head is null then array[v_business_head]
              else array[v_business_head, v_national_head]
            end,
            approval_status = case
              when v_target_user is null then 'NO_APPROVER_CONFIGURED'
              when upper(coalesce(v_request.approval_status, '')) = 'NO_APPROVER_CONFIGURED' then 'PENDING'
              else v_request.approval_status
            end,
            email_next_reminder_at = null,
            updated_at = now()
        where id = v_request.id and company_id = v_company.company_id;
      end loop;
    end loop;
  end loop;
end;
$$;

commit;
