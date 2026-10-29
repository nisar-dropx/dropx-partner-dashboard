begin;

-- save_nl_recovery is intentionally SECURITY INVOKER and is called as
-- service_role. A table-level SHARE lock added to the function on 29 Oct
-- requires privileges that the server role must not receive, so every save
-- failed before validation with SQLSTATE 42501. Serialize recovery writers
-- with a company-scoped transaction advisory lock instead. This keeps the
-- function least-privileged and retains all payroll / bank state re-checks.
do $$
declare
  f record;
  d text;
  patched boolean := false;
begin
  for f in
    select oid
    from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname = 'save_nl_recovery'
  loop
    d := pg_get_functiondef(f.oid);

    if position('-- Service-role-safe recovery writer serialization' in d) > 0 then
      patched := true;
      continue;
    end if;

    if position('lock table hr_payroll_runs,hr_payroll_bank_lines,workforce_payroll_runs,workforce_payout_payment_items in share mode;' in d) = 0 then
      continue;
    end if;

    d := replace(
      d,
      'lock table hr_payroll_runs,hr_payroll_bank_lines,workforce_payroll_runs,workforce_payout_payment_items in share mode;',
      E'-- Service-role-safe recovery writer serialization\n  perform pg_advisory_xact_lock(hashtextextended(''loss-recovery-save:'' || p_company::text, 0));'
    );

    if position('-- Service-role-safe recovery writer serialization' in d) = 0
       or position('lock table hr_payroll_runs,hr_payroll_bank_lines,workforce_payroll_runs,workforce_payout_payment_items in share mode;' in d) > 0 then
      raise exception 'Recovery writer serialization patch failed for function %', f.oid::regprocedure;
    end if;

    execute d;
    patched := true;
  end loop;

  if not patched then
    raise exception 'Expected recovery writer with the 29 Oct payroll lock was not found';
  end if;
end $$;

notify pgrst, 'reload schema';
commit;
