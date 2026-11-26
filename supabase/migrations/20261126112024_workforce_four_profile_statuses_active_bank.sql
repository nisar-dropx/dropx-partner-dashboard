begin;
set local lock_timeout='5s';
-- Restore Active-only payments while treating a pending exit as still employed.
-- Workflow case stages remain unchanged; completed exits/inactive registrations cannot pay.
do $migration$
declare signature text; definition text; changed text; guard text;
begin
 foreach signature in array array['public.workforce_payout_payment_candidates(uuid,date,date,uuid[])','public.workforce_payout_payment_row_candidates(uuid,date,date,jsonb)'] loop
  definition:=pg_get_functiondef(signature::regprocedure);
  guard:=substring(definition from 'if v_worker.deleted_at is not null[\s\S]*?eligibility_message := ''Deleted Workforce profiles cannot be included in a bank file.'';[\s\S]*?end if;');
  if guard is null then
   if position('Only Active Workforce profiles can be included; pending exit requests remain Active.' in definition)>0 then continue; end if;
   raise exception 'Expected Workforce profile guard not found in %',signature;
  end if;
  changed:=replace(definition,guard,$replacement$if v_worker.deleted_at is not null
      or not coalesce(v_worker.is_active,false)
      or lower(btrim(coalesce(v_worker.lifecycle_status,''))) not in ('','active','onboarding','resignation_pending','termination_pending','settlement_pending')
      or lower(btrim(coalesce(v_worker.onboarding_status,''))) not in ('','active') then
      available_to_pay := 0;
      payment_status := 'Profile Not Active';
      eligibility_code := 'profile_not_active';
      eligibility_message := 'Only Active Workforce profiles can be included; pending exit requests remain Active.';
      return next;
      continue;
    end if;$replacement$);
  execute changed;
 end loop;
end $migration$;
notify pgrst,'reload schema';
commit;
