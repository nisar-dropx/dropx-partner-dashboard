begin;
-- APPROVAL REQUIRED BEFORE APPLYING.
-- Drops the one-step legacy dispute RPC after:
--   1) Dashboard/Ops/DropX One all call workforce_dispute_transition_v2 only
--   2) 20261020100000 + 20261020110000 are applied (execute already revoked)
--   3) Production verification confirms no runtime callers remain
-- Do not apply via blanket db push. Apply only after explicit approval.
do $$
begin
  if to_regprocedure('public.workforce_decide_payout_dispute(uuid,uuid,uuid,text,text,uuid[])') is not null then
    if has_function_privilege('service_role', 'public.workforce_decide_payout_dispute(uuid,uuid,uuid,text,text,uuid[])', 'EXECUTE') then
      raise exception
        'Refusing to drop workforce_decide_payout_dispute while service_role still has EXECUTE. Apply 20261020100000 / 20261020110000 first.';
    end if;
    execute 'drop function public.workforce_decide_payout_dispute(uuid, uuid, uuid, text, text, uuid[])';
  end if;
end $$;
notify pgrst, 'reload schema';
commit;
