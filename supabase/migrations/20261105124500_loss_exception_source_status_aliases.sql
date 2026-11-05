-- Keep exception entitlements when Amazon only changes an equivalent eDSP label.
-- Requires nl_recovery_source_status_key from 20261105052211.
create or replace function public.nl_loss_exception_allowed(p_company uuid,p_month text,p_case text,p_kind text,p_payroll text)
returns boolean language sql stable security invoker set search_path=public as $$
 select exists(select 1 from nl_loss_exception_options g join nl_loss_month_cases c using(company_id,month,case_key)
 where g.company_id=p_company and g.month=p_month and g.case_key=p_case and g.kind=p_kind and g.enabled
 and g.source_amount=c.amount
 and public.nl_recovery_source_status_key(g.source_status) is not distinct from public.nl_recovery_source_status_key(c.source_status)
 and (p_kind='installments' or g.deduction_month=p_payroll))
$$;
revoke all on function public.nl_loss_exception_allowed(uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.nl_loss_exception_allowed(uuid,text,text,text,text) to service_role;

-- Align stored grant labels with the live source when only the alias changed.
update public.nl_loss_exception_options g
set source_status = c.source_status,
    updated_at = now()
from public.nl_loss_month_cases c
where g.company_id = c.company_id
  and g.month = c.month
  and g.case_key = c.case_key
  and g.enabled
  and g.source_amount = c.amount
  and g.source_status is distinct from c.source_status
  and public.nl_recovery_source_status_key(g.source_status)
      is not distinct from public.nl_recovery_source_status_key(c.source_status);
