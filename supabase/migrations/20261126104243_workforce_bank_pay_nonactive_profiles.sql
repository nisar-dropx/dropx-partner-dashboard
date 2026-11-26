begin;
set local lock_timeout='5s';
-- Employment/registration status does not extinguish a published payable balance.
-- Preserve every monetary, identity, publication, bank, PAN, hold and scope check.
do $migration$
declare signature text; definition text; changed text; guard text;
begin
 foreach signature in array array['public.workforce_payout_payment_candidates(uuid,date,date,uuid[])','public.workforce_payout_payment_row_candidates(uuid,date,date,jsonb)'] loop
  definition:=pg_get_functiondef(signature::regprocedure);
  guard:=substring(definition from 'if v_worker.deleted_at is not null[\s\S]*?eligibility_code := ''profile_not_active'';[\s\S]*?end if;');
  if guard is null then
   if position('Deleted Workforce profiles cannot be included in a bank file.' in definition)>0 then continue; end if;
   raise exception 'Expected Workforce profile guard not found in %',signature;
  end if;
  if position('v_worker.lifecycle_status' in guard)=0 or position('v_worker.onboarding_status' in guard)=0 then raise exception 'Unexpected Workforce profile guard in %',signature; end if;
  changed:=replace(definition,guard,$replacement$if v_worker.deleted_at is not null then
      available_to_pay := 0;
      payment_status := 'Payment profile unavailable';
      eligibility_code := 'profile_unavailable';
      eligibility_message := 'Deleted Workforce profiles cannot be included in a bank file.';
      return next;
      continue;
    end if;$replacement$);
  execute changed;
 end loop;
end $migration$;
notify pgrst,'reload schema';
commit;
