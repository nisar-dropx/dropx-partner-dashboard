begin;

-- A reversed transfer contributes no paid credit. A payable payout reopened
-- by that reversal uses the same worksheet status as a partial settlement.
do $migration$
declare
  candidate regprocedure;
  definition text;
  old_attempt text;
  new_attempt text;
  old_status constant text := 'when v_paid > 0 and balance_payable > 0 then ''Partially Paid''';
  new_status constant text := 'when balance_payable > 0 and (v_paid > 0 or v_latest_attempt_status = ''reversed'') then ''Partially Paid''';
begin
  foreach candidate in array array[
    'public.workforce_payout_payment_candidates(uuid,date,date,uuid[])'::regprocedure,
    'public.workforce_payout_payment_row_candidates(uuid,date,date,jsonb)'::regprocedure
  ] loop
    definition := replace(pg_get_functiondef(candidate), chr(13), '');
    if strpos(definition, new_status) > 0 then continue; end if;

    if candidate = 'public.workforce_payout_payment_candidates(uuid,date,date,uuid[])'::regprocedure then
      old_attempt := E'select item.status\n    into v_latest_attempt_status';
      new_attempt := E'select case when item.reversed_at is not null then ''reversed'' else item.status end\n    into v_latest_attempt_status';
    else
      old_attempt := 'select item.status, item.created_at, item.payment_version, item.id';
      new_attempt := 'select case when item.reversed_at is not null then ''reversed'' else item.status end, '
        || 'coalesce(item.reversed_at, item.created_at), item.payment_version, item.id';
    end if;

    if strpos(definition, old_attempt) = 0 or strpos(definition, old_status) = 0 then
      raise exception 'Unexpected Workforce payout status definition in %.', candidate;
    end if;
    execute replace(replace(definition, old_attempt, new_attempt), old_status, new_status);
  end loop;
end;
$migration$;

notify pgrst, 'reload schema';
commit;
