-- Respect a disabled route-capture master even when an hourly worker was already in flight.
do $migration$
declare definition text;
begin
 select replace(pg_get_functiondef('public.workforce_store_route_distance(uuid,jsonb)'::regprocedure), E'\r\n', E'\n') into definition;
 if position('-- Manual-only capture guard' in definition) > 0 then return; end if;
 if position('  -- Re-check under the lock: payroll may have published while we waited.' in definition) = 0 then
   raise exception 'Unexpected route-distance writer definition; inspect before patching';
 end if;
 definition := replace(definition,
   '  -- Re-check under the lock: payroll may have published while we waited.',
   E'  -- Manual-only capture guard: re-check the master after the shared allocation lock.\n  if not exists (select 1 from public.workforce_route_distance_settings cfg\n    where cfg.company_id=p_company_id and cfg.enabled and day>=cfg.effective_from) then\n    return ''disabled'';\n  end if;\n  -- Re-check under the lock: payroll may have published while we waited.');
 execute definition;
end
$migration$;
