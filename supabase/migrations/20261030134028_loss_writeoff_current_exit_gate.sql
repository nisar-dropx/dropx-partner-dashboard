begin;
-- An exception permits a decision; it does not override the current source/redispute state.
do $migration$ declare d text; begin
 select pg_get_functiondef('public.waive_nl_recovery_balance(uuid,text,text,text,text,uuid,text)'::regprocedure) into d;
 if position('-- Current exit balance gate' in d)=0 then
  d:=replace(d,'if l.exit_date is null then',$patch$
 -- Current exit balance gate
 if l.status<>'exit_balance' then
  raise exception 'Write-off requires a current exit balance with no active redispute or source change.'; end if;
 if l.exit_date is null then$patch$);
  if position('-- Current exit balance gate' in d)=0 then raise exception 'Write-off guard patch did not match'; end if;
  execute d;
 end if;
end $migration$;
notify pgrst,'reload schema';
commit;
