-- Adhoc Van had only Cluster Manager configured for its required initial
-- station step. Stations such as JUGD are covered by an Area Operations
-- Manager but currently have no Cluster Manager membership, so creation
-- failed closed with "No active initial approver". Keep the master-driven
-- candidate order and add station-scoped RM/AOM/City Manager fallbacks. The
-- City Manager fallback also closes the same live gap at TZC4.

begin;

do $$
declare
  v_company_id constant uuid := '43866344-b550-4e8a-9a2d-9d23f3d8a997';
  v_head_id uuid;
  v_step_id uuid;
  v_cluster_manager_role_id uuid;
  v_regional_manager_role_id uuid;
  v_area_operations_manager_role_id uuid;
  v_city_manager_role_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_step_count integer;
begin
  select id into strict v_head_id
  from public.payment_heads
  where company_id = v_company_id
    and code = 'VAN_ADHOC'
    and is_active = true;

  select id into strict v_cluster_manager_role_id
  from public.user_roles
  where company_id = v_company_id and code = 'OPERATIONS_CLM';

  select id into strict v_regional_manager_role_id
  from public.user_roles
  where company_id = v_company_id and code = 'OPERATIONS_RM';

  select id into strict v_area_operations_manager_role_id
  from public.user_roles
  where company_id = v_company_id and code = 'OPERATIONS_AOM';

  select id into strict v_city_manager_role_id
  from public.user_roles
  where company_id = v_company_id and code = 'OPERATIONS_CM';

  select count(*) into v_step_count
  from public.payment_head_approval_steps
  where company_id = v_company_id
    and payment_head_id = v_head_id
    and step_order = 1;

  if v_step_count <> 1 then
    raise exception 'Expected exactly one Adhoc Van initial approval step, found %', v_step_count;
  end if;

  select id, candidates into v_step_id, v_before
  from public.payment_head_approval_steps
  where company_id = v_company_id
    and payment_head_id = v_head_id
    and step_order = 1
  for update;

  if not exists (
    select 1
    from jsonb_array_elements(v_before) candidate
    where (candidate ->> 'role_id')::uuid = v_cluster_manager_role_id
  ) then
    raise exception 'Adhoc Van initial step no longer contains Cluster Manager; review manually.';
  end if;

  v_after := v_before;

  if not exists (
    select 1 from jsonb_array_elements(v_after) candidate
    where (candidate ->> 'role_id')::uuid = v_regional_manager_role_id
  ) then
    v_after := v_after || jsonb_build_array(jsonb_build_object(
      'role_id', v_regional_manager_role_id,
      'scope', 'station'
    ));
  end if;

  if not exists (
    select 1 from jsonb_array_elements(v_after) candidate
    where (candidate ->> 'role_id')::uuid = v_area_operations_manager_role_id
  ) then
    v_after := v_after || jsonb_build_array(jsonb_build_object(
      'role_id', v_area_operations_manager_role_id,
      'scope', 'station'
    ));
  end if;

  if not exists (
    select 1 from jsonb_array_elements(v_after) candidate
    where (candidate ->> 'role_id')::uuid = v_city_manager_role_id
  ) then
    v_after := v_after || jsonb_build_array(jsonb_build_object(
      'role_id', v_city_manager_role_id,
      'scope', 'station'
    ));
  end if;

  if v_after <> v_before then
    insert into public.payment_audit_events(event, actor_role, remarks)
    values (
      'approval_master_corrected',
      'SYSTEM_REPAIR',
      jsonb_build_object(
        'reason', 'Restore station-scoped RM/AOM/City Manager fallback for Adhoc Van initial approval; JUGD incident and all-station audit 2026-09-26',
        'payment_head_id', v_head_id,
        'step_id', v_step_id,
        'before_candidates', v_before,
        'after_candidates', v_after
      )::text
    );

    update public.payment_head_approval_steps
    set candidates = v_after,
        updated_at = now()
    where id = v_step_id
      and company_id = v_company_id;

    update public.payment_heads
    set initial_approval_role_id = v_cluster_manager_role_id,
        initial_approval_role_ids = array[
          v_cluster_manager_role_id,
          v_regional_manager_role_id,
          v_area_operations_manager_role_id,
          v_city_manager_role_id
        ],
        updated_at = now()
    where id = v_head_id
      and company_id = v_company_id;
  end if;
end;
$$;

commit;
