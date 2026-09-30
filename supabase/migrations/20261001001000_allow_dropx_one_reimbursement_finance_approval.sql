-- Finance approves only DropX One employee reimbursements. Station-originated
-- payment requests end at Business Head (with National Head fallback) and go
-- straight to payment processing.

create or replace function public.prevent_finance_payment_approvers()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (
    select 1
    from jsonb_array_elements(coalesce(new.candidates, '[]'::jsonb)) candidate
    join public.user_roles role
      on role.id = (candidate->>'role_id')::uuid
     and role.company_id = new.company_id
    where upper(coalesce(role.code, '')) ~ '(^|_)(FIN|FINMGR|FINANCE|ACCOUNT|ACCOUNTS)(_|$)'
  ) and not exists (
    select 1
    from public.payment_heads head
    where head.id = new.payment_head_id
      and head.company_id = new.company_id
      and head.code = 'EMPLOYEE_REIMBURSEMENT'
  ) then
    raise exception 'Finance and Accounts roles can approve only DropX One employee reimbursements.';
  end if;
  return new;
end;
$$;

-- Restore only reimbursement requests that the preceding correction finalized
-- by mistake. The Finance Manager step remains pending for these DropX One
-- reimbursements; no station request is affected.
do $$
declare
  v_company uuid := '43866344-b550-4e8a-9a2d-9d23f3d8a997';
  v_finance_role uuid;
  v_finance_user uuid;
begin
  select id into v_finance_role
  from public.user_roles
  where company_id = v_company
    and is_active
    and code = 'FINANCE_FINMGR'
  limit 1;
  if v_finance_role is null then
    raise exception 'An active Finance Manager role is required for DropX One reimbursement approval.';
  end if;

  select coalesce(
    (
      select membership.user_id
      from public.company_product_memberships membership
      where membership.company_id = v_company
        and membership.role_id = v_finance_role
        and membership.is_active
      order by membership.user_id
      limit 1
    ),
    (
      select profile.id
      from public.profiles profile
      where profile.company_id = v_company
        and profile.role_id = v_finance_role
        and profile.is_active
      order by profile.full_name, profile.id
      limit 1
    )
  ) into v_finance_user;
  if v_finance_user is null then
    raise exception 'An active Finance Manager user is required for DropX One reimbursement approval.';
  end if;

  with restored as (
    update public.payment_requests request
    set status = 'pending',
        approval_status = 'APPROVED',
        current_step_order = 2,
        total_steps = 2,
        current_approver_user_id = v_finance_user,
        current_approver_role_id = v_finance_role,
        current_approver_role_ids = array[v_finance_role],
        final_approval_role_id = v_finance_role,
        final_approval_role_ids = array[v_finance_role],
        updated_at = now()
    from public.payment_heads head
    where request.company_id = v_company
      and request.payment_head_id = head.id
      and head.company_id = v_company
      and head.code = 'EMPLOYEE_REIMBURSEMENT'
      and request.status = 'approved'
      and request.approval_status = 'FINAL_APPROVED'
      and exists (
        select 1
        from public.payment_audit_events audit
        where audit.request_id = request.id
          and audit.event = 'legacy_finance_approval_removed_request_finalized'
      )
    returning request.id, request.request_no
  )
  insert into public.payment_audit_events (request_id, event, actor_role, remarks)
  select
    restored.id,
    'dropx_one_reimbursement_finance_approval_restored',
    'SYSTEM_MIGRATION',
    jsonb_build_object(
      'request_no', restored.request_no,
      'reason', 'DropX One employee reimbursement retains the Finance Manager approval exception'
    )::text
  from restored;
end;
$$;
