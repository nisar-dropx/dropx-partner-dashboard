begin;

-- A failed or cancelled retry does not erase money already finalized by the
-- bank.  Both payment candidate APIs must therefore describe any positive
-- paid amount with a positive remaining balance as Partially Paid.  Keep this
-- as a post-deployment definition patch because both calculators are already
-- installed and the older profile API remains callable during the rollout.
do $standardize_partial_payment_status$
declare
  v_signature regprocedure;
  v_definition text;
  v_old text := E'    payment_status := case\n      when v_paid > 0 and balance_payable = 0 then ''Paid''\n      when v_latest_attempt_status = ''failed'' then ''Payment Failed''\n      when v_latest_attempt_status = ''cancelled'' then ''Payment Cancelled''\n      when v_paid > 0 then ''Partially paid''\n      else null\n    end;';
  v_new text := E'    payment_status := case\n      when v_paid > 0 and balance_payable = 0 then ''Paid''\n      when v_paid > 0 and balance_payable > 0 then ''Partially Paid''\n      when v_latest_attempt_status = ''failed'' then ''Payment Failed''\n      when v_latest_attempt_status = ''cancelled'' then ''Payment Cancelled''\n      else null\n    end;';
  v_count integer;
  v_signatures regprocedure[] := array[
    'public.workforce_payout_payment_candidates(uuid,date,date,uuid[])'::regprocedure,
    'public.workforce_payout_payment_row_candidates(uuid,date,date,jsonb)'::regprocedure
  ];
begin
  foreach v_signature in array v_signatures
  loop
    -- Function bodies retain the line endings of their source migration.
    -- Normalize them before matching so this deployment patch behaves the
    -- same for CRLF-authored and LF-authored definitions.
    select replace(
      pg_catalog.pg_get_functiondef(v_signature), E'\r\n', E'\n'
    ) into v_definition;
    v_count := (length(v_definition) - length(replace(v_definition, v_old, '')))
      / length(v_old);
    if v_count <> 1 then
      raise exception 'Unexpected partial-payment status block in % (found %).',
        v_signature::text, v_count;
    end if;
    v_definition := replace(v_definition, v_old, v_new);
    execute v_definition;
  end loop;
end
$standardize_partial_payment_status$;

comment on function public.workforce_payout_payment_candidates(uuid, date, date, uuid[]) is
  'Canonical profile payment candidate calculator. Finalized paid value is subtracted from the current target; a positive paid amount with a positive balance is Partially Paid.';

comment on function public.workforce_payout_payment_row_candidates(uuid, date, date, jsonb) is
  'Canonical station-row payment candidate calculator. Finalized paid allocation is subtracted from the current row target; a positive paid amount with a positive balance is Partially Paid.';

notify pgrst, 'reload schema';

commit;
