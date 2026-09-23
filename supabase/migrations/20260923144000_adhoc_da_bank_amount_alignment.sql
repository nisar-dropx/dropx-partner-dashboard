-- Bank export and statement reconciliation use amount, then amount_requested.
-- amount_approved is legacy/informational and must not override the bank debit.
do $$
declare definition text;
begin
  select pg_get_functiondef('public.payment_adhoc_da_guard()'::regprocedure) into definition;
  if position('paid_amount:=coalesce(new.amount_approved,new.amount,new.amount_requested);' in definition)>0 then
    execute replace(definition,'paid_amount:=coalesce(new.amount_approved,new.amount,new.amount_requested);','paid_amount:=coalesce(new.amount,new.amount_requested);');
  elsif position('paid_amount:=coalesce(new.amount,new.amount_requested);' in definition)=0 then
    raise exception 'Unexpected Adhoc DA guard version; inspect before changing financial logic';
  end if;
end $$;
