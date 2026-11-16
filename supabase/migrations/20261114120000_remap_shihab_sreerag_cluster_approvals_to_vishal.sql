-- Transfer the remaining Shihab cluster ownership to Vishal and move any
-- open payment approvals that are still directly assigned to the old owners.
-- Historical responsibility and approval rows are intentionally preserved.
begin;

do $$
declare
  v_company_id uuid := '43866344-b550-4e8a-9a2d-9d23f3d8a997'::uuid;
  v_shihab_person_id uuid := 'b7d8137d-6973-4e92-ad95-b233d4dfd48e'::uuid;
  v_vishal_person_id uuid := '9c6bafbd-2382-4916-b554-eda5cd6d20c2'::uuid;
  v_transfer_ids uuid[];
begin
  select coalesce(scope.location_scope_ids, '{}'::uuid[])
    into v_transfer_ids
  from public.people_person_access_scopes scope
  where scope.company_id = v_company_id
    and scope.person_id = v_shihab_person_id
  for update;

  -- Move the source-of-truth location scope. The People routing trigger
  -- reconciles station responsibilities and reporting links for both portals.
  update public.people_person_access_scopes target
  set location_scope_ids = (
        select coalesce(array_agg(distinct station_id order by station_id), '{}'::uuid[])
        from unnest(coalesce(target.location_scope_ids, '{}'::uuid[]) || coalesce(v_transfer_ids, '{}'::uuid[])) station_id
      ),
      updated_at = clock_timestamp()
  where target.company_id = v_company_id
    and target.person_id = v_vishal_person_id;

  update public.people_person_access_scopes source
  set location_scope_ids = '{}'::uuid[],
      updated_at = clock_timestamp()
  where source.company_id = v_company_id
    and source.person_id = v_shihab_person_id;
end;
$$;

-- Reassign only requests still awaiting a decision. Completed, rejected and
-- historical approvals must retain their original actor.
update public.payment_requests
set current_approver_user_id = '99ae3944-81ae-418c-8be5-9802d34ea408'::uuid,
    updated_at = clock_timestamp()
where current_approver_user_id in (
  'd4485a4a-9072-4fea-8763-1ea9527f3e89'::uuid,
  '53216c47-1e77-4314-8e8c-e6b177df6751'::uuid
)
and lower(coalesce(status, '')) in ('pending', 'submitted', 'resubmitted', 'in_review')
and upper(coalesce(approval_status, '')) in ('PENDING', 'RE_PENDING', 'RESUBMITTED');

commit;
