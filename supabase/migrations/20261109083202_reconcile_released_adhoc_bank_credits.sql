begin;
set local lock_timeout = '5s';

do $migration$
declare
  definition text := pg_get_functiondef('public.payment_delivery_identity_guard()'::regprocedure);
  original_call text := 'perform public.payment_delivery_settlement_guard(new);';
begin
  if position('-- Reconcile verified bank credit' in definition) > 0 then
    return;
  end if;
  if (length(definition) - length(replace(definition, original_call, ''))) / length(original_call) <> 2 then
    raise exception 'Unexpected delivery identity guard definition';
  end if;

  execute replace(definition, original_call, $replacement$
    -- Reconcile verified bank credit without rechecking payout eligibility.
    -- The separate bank balance guard checks the increase against the credit ledger.
    if not (
      tg_op = 'UPDATE'
      and coalesce(new.bank_paid_amount, 0) > coalesce(old.bank_paid_amount, 0)
      and coalesce(current_setting('app.payment_request_bank_settlement', true), '') = 'allowed'
    ) then
      perform public.payment_delivery_settlement_guard(new);
    end if;$replacement$);
end;
$migration$;

commit;
