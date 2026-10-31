-- Payment approval routing is configured entirely in the approval master.
-- Candidate model ids are data, not application constants:
--   EDSP/XPT/AMXL/ODH/MDH -> Head Operations - Last Mile
--   NOW                    -> National Head
-- Other active business models retain Business Head as their final approver.
-- Fleet heads use one local stage with CLM first and AOM as fallback.

do $$
declare
  v_company uuid;
  v_head_operations uuid;
  v_national_head uuid;
  v_business_head uuid;
  v_cluster_manager uuid;
  v_area_manager uuid;
  v_fleet_manager uuid;
  v_operations_models uuid[];
  v_now_models uuid[];
  v_other_models uuid[];
  v_fleet_heads uuid[];
  v_final_candidates jsonb;
begin
  for v_company in
    select distinct company_id
    from public.payment_head_approval_steps
  loop
    select id into v_head_operations
    from public.user_roles
    where company_id = v_company and code = 'OPERATIONS_HLM' and is_active = true
    order by created_at nulls last, id
    limit 1;

    select id into v_national_head
    from public.user_roles
    where company_id = v_company and code = 'OPERATIONS_NH' and is_active = true
    order by created_at nulls last, id
    limit 1;

    select id into v_business_head
    from public.user_roles
    where company_id = v_company and code = 'OPERATIONS_BH' and is_active = true
    order by created_at nulls last, id
    limit 1;

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

    select id into v_fleet_manager
    from public.user_roles
    where company_id = v_company and code = 'OPERATIONS_FLTM' and is_active = true
    order by created_at nulls last, id
    limit 1;

    select coalesce(array_agg(id order by code), '{}'::uuid[])
    into v_operations_models
    from public.location_models
    where company_id = v_company
      and is_active = true
      and code = any(array['EDSP', 'XPT', 'AMXL', 'ODH', 'MDH']);

    select coalesce(array_agg(id order by code), '{}'::uuid[])
    into v_now_models
    from public.location_models
    where company_id = v_company
      and is_active = true
      and code = 'NOW';

    -- Do not partially apply the requested routing in a company whose master
    -- is incomplete. An administrator can finish its roles/models and save the
    -- workflow from Payment Approval Settings later.
    if v_head_operations is null
      or v_national_head is null
      or v_business_head is null
      or v_cluster_manager is null
      or v_area_manager is null
      or cardinality(v_operations_models) <> 5
      or cardinality(v_now_models) <> 1
    then
      continue;
    end if;

    select coalesce(array_agg(id order by code), '{}'::uuid[])
    into v_other_models
    from public.location_models
    where company_id = v_company
      and is_active = true
      and not (id = any(v_operations_models || v_now_models));

    v_final_candidates := jsonb_build_array(
      jsonb_build_object(
        'role_id', v_head_operations,
        'scope', 'company',
        'location_model_ids', to_jsonb(v_operations_models)
      ),
      jsonb_build_object(
        'role_id', v_national_head,
        'scope', 'company',
        'location_model_ids', to_jsonb(v_now_models)
      )
    );

    if cardinality(v_other_models) > 0 then
      v_final_candidates := v_final_candidates || jsonb_build_array(
        jsonb_build_object(
          'role_id', v_business_head,
          'scope', 'company',
          'location_model_ids', to_jsonb(v_other_models)
        )
      );
    end if;

    -- Every configured workflow gets the same model-aware final stage. The
    -- workflow remains independently editable per payment head in the master.
    update public.payment_head_approval_steps step
    set candidates = v_final_candidates,
        is_required = true,
        updated_at = now()
    where step.company_id = v_company
      and step.step_order = (
        select max(last_step.step_order)
        from public.payment_head_approval_steps last_step
        where last_step.company_id = step.company_id
          and last_step.payment_head_id = step.payment_head_id
      );

    -- Discover current fleet workflows from master data. Existing Fleet
    -- Manager candidates are included, and named van/vehicle heads cover
    -- Adhoc Van which had already been moved to CLM + AOM as two stages.
    select coalesce(array_agg(distinct head.id), '{}'::uuid[])
    into v_fleet_heads
    from public.payment_heads head
    where head.company_id = v_company
      and head.is_active = true
      and (
        head.name ilike '%van%'
        or head.name ilike '%vehicle%'
        or exists (
          select 1
          from public.payment_head_approval_steps fleet_step
          cross join lateral jsonb_array_elements(fleet_step.candidates) candidate
          where fleet_step.company_id = head.company_id
            and fleet_step.payment_head_id = head.id
            and v_fleet_manager is not null
            and candidate->>'role_id' = v_fleet_manager::text
        )
      );

    if cardinality(v_fleet_heads) > 0 then
      delete from public.payment_head_approval_steps
      where company_id = v_company
        and payment_head_id = any(v_fleet_heads);

      insert into public.payment_head_approval_steps
        (company_id, payment_head_id, step_order, candidates, is_required, created_at, updated_at)
      select
        v_company,
        fleet_head_id,
        1,
        jsonb_build_array(
          jsonb_build_object('role_id', v_cluster_manager, 'scope', 'station'),
          jsonb_build_object('role_id', v_area_manager, 'scope', 'station')
        ),
        true,
        now(),
        now()
      from unnest(v_fleet_heads) fleet_head_id;

      insert into public.payment_head_approval_steps
        (company_id, payment_head_id, step_order, candidates, is_required, created_at, updated_at)
      select
        v_company,
        fleet_head_id,
        2,
        v_final_candidates,
        true,
        now(),
        now()
      from unnest(v_fleet_heads) fleet_head_id;

      update public.payment_heads
      set initial_approval_role_id = v_cluster_manager,
          initial_approval_role_ids = array[v_cluster_manager, v_area_manager],
          updated_at = now()
      where company_id = v_company
        and id = any(v_fleet_heads);
    end if;

    update public.payment_heads head
    set final_approval_role_id = v_head_operations,
        final_approval_role_ids = array[v_head_operations, v_national_head, v_business_head],
        updated_at = now()
    where head.company_id = v_company
      and exists (
        select 1
        from public.payment_head_approval_steps step
        where step.company_id = head.company_id
          and step.payment_head_id = head.id
      );

    -- Refresh the audit snapshot and progress total used by open regular
    -- requests. The application reconciliation pass then resolves the named
    -- person from current People mappings and clears the old reminder target.
    update public.payment_requests request
    set approval_steps_snapshot = configured.steps,
        total_steps = configured.total_steps,
        current_step_order = least(coalesce(request.current_step_order, 1), configured.total_steps),
        updated_at = now()
    from (
      select
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
      group by step.payment_head_id
    ) configured
    where request.company_id = v_company
      and request.payment_head_id = configured.payment_head_id
      and request.adhoc_approval_steps is null
      and upper(coalesce(request.status, '')) not in ('APPROVED', 'PROCESSED', 'PROCESSING', 'RETURNED', 'REJECTED', 'CANCELLED')
      and upper(coalesce(request.approval_status, '')) not in ('FINAL_APPROVED', 'PROCESSED', 'PROCESSING', 'RETURNED', 'REJECTED', 'CANCELLED');
  end loop;
end
$$;
