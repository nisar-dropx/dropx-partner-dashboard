-- Required station-level payment approval steps are ordered fallbacks. When a
-- Cluster Manager is not actively mapped to the station, Area Operations
-- Manager must be attempted next before wider Regional/other roles. This
-- migration reorders existing master candidates and normalizes operational
-- manager candidates to station scope (two legacy heads were company-scoped).
-- It does not add roles, rewrite approval history, or move requests already
-- assigned to an approver.

begin;

do $$
declare
  v_company_id constant uuid := '43866344-b550-4e8a-9a2d-9d23f3d8a997';
  v_cluster_manager_role_id uuid;
  v_area_operations_manager_role_id uuid;
  v_regional_manager_role_id uuid;
  v_row record;
  v_after jsonb;
  v_changed integer := 0;
begin
  select id into strict v_cluster_manager_role_id
  from public.user_roles
  where company_id = v_company_id and code = 'OPERATIONS_CLM';

  select id into strict v_area_operations_manager_role_id
  from public.user_roles
  where company_id = v_company_id and code = 'OPERATIONS_AOM';

  select id into strict v_regional_manager_role_id
  from public.user_roles
  where company_id = v_company_id and code = 'OPERATIONS_RM';

  for v_row in
    select
      step.id,
      step.payment_head_id,
      step.candidates,
      head.code as payment_head_code
    from public.payment_head_approval_steps step
    join public.payment_heads head
      on head.company_id = step.company_id
     and head.id = step.payment_head_id
     and head.is_active = true
    where step.company_id = v_company_id
      and step.step_order = 1
      and step.is_required = true
      and exists (
        select 1 from jsonb_array_elements(step.candidates) candidate
        where (candidate ->> 'role_id')::uuid = v_cluster_manager_role_id
      )
      and exists (
        select 1 from jsonb_array_elements(step.candidates) candidate
        where (candidate ->> 'role_id')::uuid = v_area_operations_manager_role_id
      )
    for update of step
  loop
    select jsonb_agg(candidate order by priority, original_order)
    into v_after
    from (
      select
        case
          when (candidate ->> 'role_id')::uuid in (
            v_cluster_manager_role_id,
            v_area_operations_manager_role_id,
            v_regional_manager_role_id
          )
            then jsonb_set(candidate, '{scope}', '"station"'::jsonb)
          else candidate
        end as candidate,
        original_order,
        case
          when (candidate ->> 'role_id')::uuid = v_cluster_manager_role_id then 1
          when (candidate ->> 'role_id')::uuid = v_area_operations_manager_role_id then 2
          else 3
        end as priority
      from jsonb_array_elements(v_row.candidates) with ordinality item(candidate, original_order)
    ) ordered_candidates;

    if v_after is distinct from v_row.candidates then
      insert into public.payment_audit_events(event, actor_role, remarks)
      values (
        'approval_master_corrected',
        'SYSTEM_REPAIR',
        jsonb_build_object(
          'reason', 'Prioritize Area Operations Manager immediately after an unmapped Cluster Manager',
          'payment_head_id', v_row.payment_head_id,
          'payment_head_code', v_row.payment_head_code,
          'step_id', v_row.id,
          'before_candidates', v_row.candidates,
          'after_candidates', v_after,
          'effective_for', 'new and newly-routed requests only'
        )::text
      );

      update public.payment_head_approval_steps
      set candidates = v_after,
          updated_at = now()
      where company_id = v_company_id
        and id = v_row.id;

      update public.payment_heads
      set initial_approval_role_id = (v_after -> 0 ->> 'role_id')::uuid,
          initial_approval_role_ids = array(
            select (candidate ->> 'role_id')::uuid
            from jsonb_array_elements(v_after) candidate
          ),
          updated_at = now()
      where company_id = v_company_id
        and id = v_row.payment_head_id;

      v_changed := v_changed + 1;
    end if;
  end loop;

  if v_changed > 20 then
    raise exception 'Unexpected payment approval reorder scope: % heads', v_changed;
  end if;
end;
$$;

commit;
