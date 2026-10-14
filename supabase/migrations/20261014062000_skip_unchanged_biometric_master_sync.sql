-- PostgreSQL UPDATE OF triggers run even when the assigned value is unchanged.
-- Saving provider rates assigns location_id back to the same station and used
-- to enter the biometric reconciliation lease wait unnecessarily. Only actual
-- assignment changes need that synchronization; inserts and real changes still
-- use the same atomic replacement, collision checks and reconciliation guard.
create or replace function public.sync_biometric_enrolment_from_master()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_row jsonb := to_jsonb(new);
  v_old jsonb;
begin
  if tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    if v_row -> 'company_id' is not distinct from v_old -> 'company_id'
      and v_row -> 'id' is not distinct from v_old -> 'id'
      and v_row -> 'biometric_id' is not distinct from v_old -> 'biometric_id'
      and v_row -> 'location_id' is not distinct from v_old -> 'location_id'
      and v_row -> 'is_active' is not distinct from v_old -> 'is_active'
      and v_row -> 'date_of_join' is not distinct from v_old -> 'date_of_join'
    then
      return new;
    end if;
  end if;

  perform *
  from public.replace_biometric_enrolment_assignment(
    (v_row ->> 'company_id')::uuid,
    auth.uid(),
    tg_argv[0],
    (v_row ->> 'id')::uuid,
    nullif(v_row ->> 'location_id', '')::uuid
  );
  return new;
end;
$function$;

revoke all on function public.sync_biometric_enrolment_from_master()
  from public, anon, authenticated;

notify pgrst, 'reload schema';
