-- Fleet heads remain configured in the approval master. Amazon Now has no
-- vehicle hierarchy, so those heads use its normal Operations chain:
-- City Manager -> Regional Manager -> National Head.
-- Other business models retain CLM -> AOM fallback -> configured final.

do $$
declare
  v_company uuid;
  v_head uuid;
  v_cluster_manager uuid;
  v_area_manager uuid;
  v_city_manager uuid;
  v_regional_manager uuid;
  v_now_models uuid[];
  v_other_models uuid[];
  v_final_candidates jsonb;
begin
  for v_company in
    select distinct company_id
    from public.payment_heads
    where is_active = true
  loop
    select id into v_cluster_manager
    from public.user_roles
    where company_id = v_company and code = 'OPERATIONS_CLM' and is_active = true
    order by created_at nulls last, id
    limit 1;

    select id into v_area_manager
    from public.user_roles
    where company_id = v_company and code = 'OPERATIONS_AOM' and is_active = true
    order by created_at nulls last, id
    limit 1;

    select id into v_city_manager
    from public.user_roles
    where company_id = v_company and code = 'OPERATIONS_CM' and is_active = true
    order by created_at nulls last, id
    limit 1;

    select id into v_regional_manager
    from public.user_roles
    where company_id = v_company and code = 'OPERATIONS_RM' and is_active = true
    order by created_at nulls last, id
    limit 1;

    select coalesce(array_agg(id order by code), '{}'::uuid[])
    into v_now_models
    from public.location_models
    where company_id = v_company
      and is_active = true
      and code = 'NOW';

    select coalesce(array_agg(id order by code), '{}'::uuid[])
    into v_other_models
    from public.location_models
    where company_id = v_company
      and is_active = true
      and not (id = any(v_now_models));

    if v_cluster_manager is null
      or v_area_manager is null
      or v_city_manager is null
      or v_regional_manager is null
      or cardinality(v_now_models) = 0
      or cardinality(v_other_models) = 0
    then
      continue;
    end if;

    for v_head in
      select id
      from public.payment_heads
      where company_id = v_company
        and is_active = true
        and upper(code) in
          ('VAN_ADHOC', 'VAN_FUEL', 'VEHICLE_REPAIR', 'VEHICLE_SERVICE')
    loop
      select candidates into v_final_candidates
      from public.payment_head_approval_steps
      where company_id = v_company
        and payment_head_id = v_head
      order by step_order desc
      limit 1;

      if v_final_candidates is null
        or jsonb_array_length(v_final_candidates) = 0
      then
        continue;
      end if;

      delete from public.payment_head_approval_steps
      where company_id = v_company
        and payment_head_id = v_head;

      insert into public.payment_head_approval_steps
        (company_id, payment_head_id, step_order, candidates, is_required, created_at, updated_at)
      values
        (
          v_company,
          v_head,
          1,
          jsonb_build_array(
            jsonb_build_object(
              'role_id', v_cluster_manager,
              'scope', 'station',
              'location_model_ids', to_jsonb(v_other_models)
            ),
            jsonb_build_object(
              'role_id', v_city_manager,
              'scope', 'station',
              'location_model_ids', to_jsonb(v_now_models)
            ),
            jsonb_build_object(
              'role_id', v_area_manager,
              'scope', 'station',
              'location_model_ids', to_jsonb(v_other_models)
            )
          ),
          false,
          now(),
          now()
        ),
        (
          v_company,
          v_head,
          2,
          jsonb_build_array(
            jsonb_build_object(
              'role_id', v_regional_manager,
              'scope', 'station',
              'location_model_ids', to_jsonb(v_now_models)
            )
          ),
          false,
          now(),
          now()
        ),
        (
          v_company,
          v_head,
          3,
          v_final_candidates,
          true,
          now(),
          now()
        );
    end loop;

    update public.payment_heads
    set initial_approval_role_id = v_cluster_manager,
        initial_approval_role_ids = array[
          v_cluster_manager,
          v_city_manager,
          v_area_manager,
          v_regional_manager
        ],
        updated_at = now()
    where company_id = v_company
      and is_active = true
      and upper(code) in
        ('VAN_ADHOC', 'VAN_FUEL', 'VEHICLE_REPAIR', 'VEHICLE_SERVICE');

    update public.payment_requests request
    set approval_steps_snapshot = configured.steps,
        total_steps = configured.total_steps,
        current_step_order = case
          when model.code = 'NOW' then
            case
              when upper(coalesce(request.approval_status, request.status, '')) in
                ('OPERATIONS_RM_APPROVED', 'OPERATIONS_AOM_APPROVED')
                then 3
              when upper(coalesce(request.approval_status, request.status, '')) =
                'OPERATIONS_CM_APPROVED'
                then 2
              else 1
            end
          when upper(coalesce(request.approval_status, request.status, '')) in
            (
              'OPERATIONS_CLM_APPROVED',
              'OPERATIONS_CM_APPROVED',
              'OPERATIONS_AOM_APPROVED',
              'OPERATIONS_RM_APPROVED'
            )
            then 3
          else 1
        end,
        approval_status = case
          when request.approval_status = 'NO_APPROVER_CONFIGURED' then 'PENDING'
          else request.approval_status
        end,
        current_approver_user_id = case
          when model.code = 'NOW'
            and upper(coalesce(request.approval_status, request.status, 'PENDING')) in
              ('PENDING', 'NO_APPROVER_CONFIGURED', 'RESUBMITTED', 'RE_PENDING')
            and not exists (
              select 1
              from public.payment_request_approvals approval
              where approval.company_id = request.company_id
                and approval.payment_request_id = request.id
                and lower(approval.action) = 'approved'
            )
            then null
          else request.current_approver_user_id
        end,
        current_approver_role_id = case
          when model.code = 'NOW'
            and upper(coalesce(request.approval_status, request.status, 'PENDING')) in
              ('PENDING', 'NO_APPROVER_CONFIGURED', 'RESUBMITTED', 'RE_PENDING')
            and not exists (
              select 1
              from public.payment_request_approvals approval
              where approval.company_id = request.company_id
                and approval.payment_request_id = request.id
                and lower(approval.action) = 'approved'
            )
            then null
          else request.current_approver_role_id
        end,
        current_approver_role_ids = case
          when model.code = 'NOW'
            and upper(coalesce(request.approval_status, request.status, 'PENDING')) in
              ('PENDING', 'NO_APPROVER_CONFIGURED', 'RESUBMITTED', 'RE_PENDING')
            and not exists (
              select 1
              from public.payment_request_approvals approval
              where approval.company_id = request.company_id
                and approval.payment_request_id = request.id
                and lower(approval.action) = 'approved'
            )
            then '{}'::uuid[]
          else request.current_approver_role_ids
        end,
        email_next_reminder_at = null,
        updated_at = now()
    from (
      select
        step.company_id,
        step.payment_head_id,
        count(*)::integer as total_steps,
        jsonb_agg(
          jsonb_build_object(
            'step_order', step.step_order,
            'candidates', step.candidates,
            'is_required', step.is_required
          )
          order by step.step_order
        ) as steps
      from public.payment_head_approval_steps step
      where step.company_id = v_company
      group by step.company_id, step.payment_head_id
    ) configured,
    public.stations station,
    public.location_models model
    where request.company_id = configured.company_id
      and request.payment_head_id = configured.payment_head_id
      and station.company_id = configured.company_id
      and station.id = request.location_id
      and model.company_id = station.company_id
      and model.id = station.location_model_id
      and request.adhoc_approval_steps is null
      and upper(coalesce(request.status, '')) not in
        ('APPROVED', 'PROCESSED', 'PROCESSING', 'RETURNED', 'REJECTED', 'CANCELLED')
      and upper(coalesce(request.approval_status, '')) not in
        ('FINAL_APPROVED', 'PROCESSED', 'PROCESSING', 'RETURNED', 'REJECTED', 'CANCELLED');
  end loop;
end
$$;
