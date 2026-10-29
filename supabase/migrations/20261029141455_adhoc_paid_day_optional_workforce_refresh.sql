-- Bank-confirmed ad hoc work days are valid before a Workforce mapping exists.
-- Preserve the provider/location/work-date identity for late-import exclusion,
-- but only enqueue a worker-specific refresh when that worker is resolved.
-- The period revision still changes for every paid transition.
begin;
do $patch$
declare
  signature regprocedure := 'public.payment_adhoc_da_guard()'::regprocedure;
  definition text := replace(pg_get_functiondef(signature), chr(13), '');
  old_call text := E'      perform public.enqueue_workforce_payout_dependency_refresh(new.company_id,new.adhoc_workforce_id,new.location_id,new.adhoc_work_date,new.adhoc_work_date,new.updated_by);';
  guarded_call text := E'      -- Unmapped ad hoc associates retain their provider/day identity.\n      -- Never invent a Workforce target or a second cash recovery.\n      if new.adhoc_workforce_id is not null then\n        perform public.enqueue_workforce_payout_dependency_refresh(new.company_id,new.adhoc_workforce_id,new.location_id,new.adhoc_work_date,new.adhoc_work_date,new.updated_by);\n      end if;';
begin
  if position(guarded_call in definition) > 0 then
    return;
  end if;
  if position(old_call in definition) = 0
    or (length(definition) - length(replace(definition, old_call, ''))) / length(old_call) <> 1
  then
    raise exception 'Unexpected ad hoc paid-day refresh implementation; inspect before applying.';
  end if;
  execute replace(definition, old_call, guarded_call);
end
$patch$;
notify pgrst, 'reload schema';
commit;
