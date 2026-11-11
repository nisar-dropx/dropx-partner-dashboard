-- A negative location contributes zero to the location-based bank payment.
-- Keep signed publication amounts and all checks on paid and processing allocations.
do $migration$
declare
  definition text := pg_get_functiondef(
    'public.workforce_payout_payment_row_candidates(uuid,date,date,jsonb)'::regprocedure
  );
  old_target constant text := $old$then round((latest.snapshot -> 'item' ->> 'net_amount')::numeric, 2)$old$;
  new_target constant text := $new$then greatest(round((latest.snapshot -> 'item' ->> 'net_amount')::numeric, 2), 0::numeric)$new$;
begin
  if strpos(definition, new_target) > 0 then
    return;
  end if;
  if (length(definition) - length(replace(definition, old_target, ''))) <> length(old_target) then
    raise exception 'Unexpected Workforce location payout candidate definition';
  end if;

  execute replace(
    replace(definition, old_target, new_target),
    'publication whose signed amount is part of the profile''s true balance.',
    'publication used to reconcile the profile''s location bank balances.'
  );
end
$migration$;
