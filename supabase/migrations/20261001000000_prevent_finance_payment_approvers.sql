-- Finance and Accounts process approved payments. Enforce that they cannot
-- be inserted into any payment approval step, including through an older UI
-- or a direct data update.

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
  ) then
    raise exception 'Finance and Accounts roles process payments and cannot be approval candidates.';
  end if;
  return new;
end;
$$;

drop trigger if exists payment_head_approval_steps_prevent_finance_approvers
  on public.payment_head_approval_steps;

create trigger payment_head_approval_steps_prevent_finance_approvers
before insert or update of candidates, company_id
on public.payment_head_approval_steps
for each row
execute function public.prevent_finance_payment_approvers();
