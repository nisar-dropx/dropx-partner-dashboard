-- Index expressions execute with the writer's privileges. The payment and
-- payroll APIs write as service_role, while this helper previously allowed
-- only postgres. It is an immutable, data-free string normalizer.
-- Do not grant bank finalizers, table access or browser-role permissions.
grant execute on function public.workforce_payout_bank_reference_canonical(text)
  to service_role;
