-- Post-deployment cleanup for the payout dispute processing workflow.
-- Apply only after Dashboard and OpsPulse production instances are confirmed on
-- the v2 transition RPC. Keeping this separate makes the rolling deployment
-- safe while ensuring the legacy adapter is permanently closed afterwards.

begin;

do $block$
begin
  if to_regprocedure(
    'public.workforce_dispute_step(uuid,uuid,uuid,text,text,text,text,uuid[])'
  ) is not null then
    execute 'revoke all on function public.workforce_dispute_step(uuid,uuid,uuid,text,text,text,text,uuid[]) from public, anon, authenticated, service_role';
  end if;

  if to_regprocedure(
    'public.workforce_decide_payout_dispute(uuid,uuid,uuid,text,text,uuid[])'
  ) is not null then
    execute 'revoke all on function public.workforce_decide_payout_dispute(uuid,uuid,uuid,text,text,uuid[]) from public, anon, authenticated, service_role';
  end if;
end
$block$;

notify pgrst, 'reload schema';
commit;
