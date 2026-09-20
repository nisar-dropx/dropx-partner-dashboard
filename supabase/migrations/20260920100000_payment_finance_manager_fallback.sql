-- A payment head can nominate Finance · National Head as its final approver,
-- but a vacant role must not strand requests in NO_APPROVER_CONFIGURED. When
-- that role has no active holder, the active Finance Manager is the explicit
-- company-wide fallback. This preserves the configured National Head as the
-- preferred approver when it is staffed.

begin;

do $$
declare
  company_row record;
  national_head_role_id uuid;
  finance_manager_role_id uuid;
  finance_manager_user_id uuid;
  approvals_page_id uuid;
begin
  for company_row in select id from public.companies loop
    select id into national_head_role_id
    from public.user_roles
    where company_id = company_row.id
      and code = 'FINANCE_NATIONAL_HEAD'
      and is_active
    limit 1;

    select id into finance_manager_role_id
    from public.user_roles
    where company_id = company_row.id
      and code = 'FINANCE_FINMGR'
      and is_active
    limit 1;

    if national_head_role_id is null or finance_manager_role_id is null then
      continue;
    end if;

    -- A staffed National Head remains the primary configured target.
    if exists (
      select 1
      from public.company_product_memberships membership
      join public.profiles profile
        on profile.id = membership.user_id
       and profile.company_id = membership.company_id
      where membership.company_id = company_row.id
        and membership.role_id = national_head_role_id
        and membership.is_active
        and profile.is_active
    ) then
      continue;
    end if;

    select membership.user_id into finance_manager_user_id
    from public.company_product_memberships membership
    join public.profiles profile
      on profile.id = membership.user_id
     and profile.company_id = membership.company_id
    where membership.company_id = company_row.id
      and membership.role_id = finance_manager_role_id
      and membership.is_active
      and profile.is_active
    order by profile.full_name, membership.user_id
    limit 1;

    if finance_manager_user_id is null then
      continue;
    end if;

    select id into approvals_page_id
    from public.app_pages
    where code = 'payment_approvals'
      and (company_id = company_row.id or company_id is null)
    order by company_id nulls last
    limit 1;

    if approvals_page_id is not null then
      insert into public.role_page_permissions (
        company_id, role_id, page_id, can_view, can_add, can_edit, created_at, updated_at
      ) values (
        company_row.id, finance_manager_role_id, approvals_page_id, true, false, true, now(), now()
      )
      on conflict (company_id, role_id, page_id) do update
        set can_view = true,
            can_edit = true,
            updated_at = now();
    end if;

    -- Add the fallback only to a step already configured for the unstaffed
    -- National Head. The candidate array is ordered, so the primary is still
    -- chosen first as soon as that role has an active member.
    update public.payment_head_approval_steps step
    set candidates = step.candidates || jsonb_build_array(
          jsonb_build_object('role_id', finance_manager_role_id, 'scope', 'company')
        ),
        updated_at = now()
    where step.company_id = company_row.id
      and step.candidates @> jsonb_build_array(jsonb_build_object('role_id', national_head_role_id))
      and not step.candidates @> jsonb_build_array(jsonb_build_object('role_id', finance_manager_role_id));

    -- Re-open requests that were stranded at any missing approval step on
    -- these heads. This is the same fallback the resolver now finds for new
    -- requests, and puts the request back in the existing Approvals queue.
    update public.payment_requests request
    set status = 'pending',
        approval_status = 'PENDING',
        current_step_order = fallback_step.step_order,
        current_approver_user_id = finance_manager_user_id,
        current_approver_role_id = finance_manager_role_id,
        current_approver_role_ids = array[finance_manager_role_id],
        updated_at = now()
    from (
      select distinct on (step.payment_head_id)
        step.payment_head_id,
        step.step_order
      from public.payment_head_approval_steps step
      where step.company_id = company_row.id
        and step.candidates @> jsonb_build_array(jsonb_build_object('role_id', finance_manager_role_id))
      order by step.payment_head_id, step.step_order
    ) fallback_step
    where request.company_id = company_row.id
      and request.payment_head_id = fallback_step.payment_head_id
      and request.approval_status = 'NO_APPROVER_CONFIGURED'
      and lower(coalesce(request.status, '')) not in ('approved', 'rejected', 'cancelled', 'processed');
  end loop;
end $$;

commit;
