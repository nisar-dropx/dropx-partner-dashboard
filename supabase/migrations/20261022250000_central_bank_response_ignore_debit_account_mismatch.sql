begin;

-- The debit account in a bank enquiry response identifies the account that
-- actually funded the transfer. It is valid for that account to differ from
-- the account selected when the instruction file was generated. Keep the
-- supplied value in the normalized payload and payout settlement evidence,
-- but do not use it to decide whether a response row may be finalized.
--
-- Patch both central functions because /payments/process calls the partial
-- wrapper, which prevalidates rows and then delegates to the locked finalizer.
do $patch_central_bank_debit_policy$
declare
  v_signature regprocedure;
  v_definition text;
  v_marker constant text :=
    '-- Response debit account is audit evidence only; it may differ from the generated instruction.';

  v_payout_debit_check constant text := replace($old$
    if v_ledger in ('workforce', 'helpers')
      and v_debit_account <> ''
      and v_debit_account <> public.workforce_payout_bank_account_canonical(v_expected_debit_account)
    then
      raise exception 'Debit account does not match the generated instruction for reference %.', v_reference;
    end if;
$old$, E'\r\n', E'\n');
  v_payroll_debit_check constant text := replace($old$
      or (v_debit_account <> '' and v_debit_account <>
        public.workforce_payout_bank_account_canonical(v_payroll_line.debit_account_number))
$old$, E'\r\n', E'\n');

  v_partial_workforce_check constant text := replace($old$
        when evidence.ledger = 'workforce'
          and evidence.debit_account <> ''
          and evidence.debit_account <> public.workforce_payout_bank_account_canonical(
            evidence.expected_workforce_debit
          )
          then 'Debit account does not match the generated bank instruction.'
$old$, E'\r\n', E'\n');
  v_partial_helper_check constant text := replace($old$
        when evidence.ledger = 'helpers'
          and evidence.debit_account <> ''
          and evidence.debit_account <> public.workforce_payout_bank_account_canonical(
            evidence.expected_helper_debit
          )
          then 'Debit account does not match the generated bank instruction.'
$old$, E'\r\n', E'\n');
  v_partial_exception_mapping constant text := replace($old$
        if v_error_message like 'Debit account does not match the generated instruction for reference %.' then
          v_safe_error_message := 'Debit account does not match the generated bank instruction.';
        elsif v_error_message like 'Value date does not match the generated instruction for reference %.' then
$old$, E'\r\n', E'\n');
  v_partial_exception_replacement constant text := replace($new$
        if v_error_message like 'Value date does not match the generated instruction for reference %.' then
$new$, E'\r\n', E'\n');
begin
  v_signature :=
    'public.finalize_central_bank_response(uuid,uuid,uuid,text,text,jsonb,jsonb,jsonb,jsonb)'::regprocedure;
  select pg_get_functiondef(v_signature) into v_definition;
  v_definition := replace(v_definition, E'\r\n', E'\n');

  if position(v_marker in v_definition) = 0 then
    if (length(v_definition) - length(replace(v_definition, v_payout_debit_check, '')))
        / length(v_payout_debit_check) <> 1
      or (length(v_definition) - length(replace(v_definition, v_payroll_debit_check, '')))
        / length(v_payroll_debit_check) <> 1
    then
      raise exception
        'Unexpected central bank finalizer debit-account validation structure; migration stopped without changing it.';
    end if;

    v_definition := replace(
      v_definition,
      v_payout_debit_check,
      E'\n    ' || v_marker || E'\n'
    );
    v_definition := replace(v_definition, v_payroll_debit_check, '');
    execute v_definition;
  end if;

  v_signature :=
    'public.finalize_central_bank_response_partially(uuid,uuid,uuid,text,text,jsonb,jsonb,jsonb,jsonb)'::regprocedure;
  select pg_get_functiondef(v_signature) into v_definition;
  v_definition := replace(v_definition, E'\r\n', E'\n');

  if position(v_marker in v_definition) = 0 then
    if (length(v_definition) - length(replace(v_definition, v_partial_workforce_check, '')))
        / length(v_partial_workforce_check) <> 1
      or (length(v_definition) - length(replace(v_definition, v_partial_helper_check, '')))
        / length(v_partial_helper_check) <> 1
      or (length(v_definition) - length(replace(v_definition, v_partial_exception_mapping, '')))
        / length(v_partial_exception_mapping) <> 1
    then
      raise exception
        'Unexpected partial central bank finalizer debit-account validation structure; migration stopped without changing it.';
    end if;

    v_definition := replace(
      v_definition,
      v_partial_workforce_check,
      E'\n        ' || v_marker || E'\n'
    );
    v_definition := replace(v_definition, v_partial_helper_check, E'\n');
    v_definition := replace(
      v_definition,
      v_partial_exception_mapping,
      v_partial_exception_replacement
    );
    execute v_definition;
  end if;
end
$patch_central_bank_debit_policy$;

comment on function public.finalize_central_bank_response(
  uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb
) is
  'Atomically finalizes one company-scoped bank response across Workforce, Helpers, Payment Requests and People Payroll. The response debit account is retained as settlement evidence but is not required to match the generated instruction account.';

comment on function public.finalize_central_bank_response_partially(
  uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb
) is
  'Finalizes valid company-owned rows from one central bank response while returning safe row-level errors for invalid rows. The response debit account is retained as settlement evidence but is not required to match the generated instruction account.';

revoke all on function public.finalize_central_bank_response(
  uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.finalize_central_bank_response(
  uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb
) to service_role;

revoke all on function public.finalize_central_bank_response_partially(
  uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.finalize_central_bank_response_partially(
  uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb
) to service_role;

notify pgrst, 'reload schema';

commit;
