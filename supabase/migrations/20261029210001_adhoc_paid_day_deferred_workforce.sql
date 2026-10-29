-- Bank confirmation is independent of whether the provider ID is mapped yet.
-- Keep the paid provider/station/day evidence; resolve and refresh later through
-- the existing reconciliation job, without creating a second cash deduction.
-- Created with the CLI and sequenced after the existing mapping migration.
begin;
do $patch_guard$
declare
  signature regprocedure := 'public.payment_adhoc_da_guard()'::regprocedure;
  definition text := replace(pg_get_functiondef(signature), chr(13), '');
  old_transition text := $old$    if lower(new.status) in ('processed','paid') and (tg_op='INSERT' or lower(old.status) not in ('processed','paid')) then$old$;
  new_transition text := $new$    -- Resolve deferred paid-day identity without changing bank evidence.
    if lower(new.status) in ('processed','paid') and (tg_op='INSERT' or lower(old.status) not in ('processed','paid') or new.adhoc_workforce_id is null) then$new$;
  old_required text := $old$      if new.adhoc_workforce_id is null or new.location_id is null or new.adhoc_work_date is null then
        raise exception 'Paid work-day Adhoc DA % has no Workforce mapping for this station and work date.', coalesce(nullif(btrim(new.request_no), ''), new.id::text);
      end if;$old$;
  old_refresh text := $old$      perform public.workforce_bump_payout_period_dependency_revision(new.company_id,new.adhoc_work_date);
      perform public.enqueue_workforce_payout_dependency_refresh(new.company_id,new.adhoc_workforce_id,new.location_id,new.adhoc_work_date,new.adhoc_work_date,new.updated_by);$old$;
  new_refresh text := $new$      new.adhoc_recovery_checked_at:=now();
      if tg_op='INSERT' or lower(old.status) not in ('processed','paid') or new.adhoc_workforce_id is not null then
        perform public.workforce_bump_payout_period_dependency_revision(new.company_id,new.adhoc_work_date);
      end if;
      if new.adhoc_workforce_id is not null then
        perform public.enqueue_workforce_payout_dependency_refresh(new.company_id,new.adhoc_workforce_id,new.location_id,new.adhoc_work_date,new.adhoc_work_date,new.updated_by);
      end if;$new$;
  expected text;
begin
  if position(new_transition in definition)>0 and position(new_refresh in definition)>0
    and position(old_required in definition)=0 then return; end if;
  foreach expected in array array[old_transition,old_required,old_refresh] loop
    if position(expected in definition)=0
      or (length(definition)-length(replace(definition,expected,'')))/length(expected)<>1 then
      raise exception 'Unexpected ad hoc paid-day guard; inspect before applying deferred mapping.';
    end if;
  end loop;
  definition:=replace(definition,old_transition,new_transition);
  definition:=replace(definition,old_required,'      -- An unresolved Workforce identity must not block bank confirmation.');
  definition:=replace(definition,old_refresh,new_refresh);
  execute definition;
end
$patch_guard$;

do $patch_reconciliation$
declare
  signature regprocedure := 'public.reconcile_adhoc_da_recoveries()'::regprocedure;
  definition text := replace(pg_get_functiondef(signature), chr(13), '');
  old_selection text := $old$    where source_system='OPS_ADHOC_DA' and lower(status) in ('processed','paid') and adhoc_adjustment_id is null and adhoc_payout_policy='cash_recovery'$old$;
  new_selection text := $new$    where source_system='OPS_ADHOC_DA' and lower(status) in ('processed','paid')
      and ((adhoc_payout_policy='cash_recovery' and adhoc_adjustment_id is null)
        or (adhoc_payout_policy='work_day' and adhoc_workforce_id is null))$new$;
  old_result text := 'returning adhoc_adjustment_id into adjustment;';
  new_result text := $new$returning case when adhoc_payout_policy='work_day' then adhoc_workforce_id else adhoc_adjustment_id end into adjustment;$new$;
  expected text;
begin
  if position(new_selection in definition)>0 and position(new_result in definition)>0 then return; end if;
  foreach expected in array array[old_selection,old_result] loop
    if position(expected in definition)=0
      or (length(definition)-length(replace(definition,expected,'')))/length(expected)<>1 then
      raise exception 'Unexpected ad hoc reconciliation job; inspect before extending paid-day mapping.';
    end if;
  end loop;
  execute replace(replace(definition,old_selection,new_selection),old_result,new_result);
end
$patch_reconciliation$;
notify pgrst,'reload schema';
commit;
