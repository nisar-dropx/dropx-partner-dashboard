begin;
-- The authenticated server supplies the actor; audit/marker foreign keys
-- validate that actor without granting service_role SELECT on auth.users.
do $migration$
declare definition text;
begin
  definition:=pg_get_functiondef('public.provider_set_member_nil_map(uuid,uuid,uuid,uuid,text,boolean,uuid[])'::regprocedure);
  definition:=replace(definition,
    'if not exists(select 1 from auth.users where id=p_actor) then raise exception ''Mapping actor was not found.''; end if;',
    '-- Actor integrity is enforced by the marker and audit foreign keys.');
  execute definition;
end $migration$;
notify pgrst,'reload schema';
commit;
