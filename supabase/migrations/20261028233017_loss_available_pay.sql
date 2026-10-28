begin;
-- Retain legacy cap columns as historical metadata, but no percentage or override
-- can change new recovery eligibility. Available pay is always checked.
create or replace function public.nl_loss_available_pay_policy()
returns trigger language plpgsql set search_path=public as $$
begin
 new.recovery_policy := coalesce(new.recovery_policy,'{}'::jsonb)
   || '{"salary_cap_enabled":true,"salary_cap_percent":100}'::jsonb;
 return new;
end $$;
drop trigger if exists nl_loss_available_pay_policy on public.nl_loss_sources;
create trigger nl_loss_available_pay_policy before insert or update of recovery_policy
on public.nl_loss_sources for each row execute function public.nl_loss_available_pay_policy();
update public.nl_loss_sources
set recovery_policy=recovery_policy||'{"salary_cap_enabled":true,"salary_cap_percent":100}'::jsonb,
 updated_at=now()
where recovery_policy->>'salary_cap_percent' is distinct from '100'
   or recovery_policy->>'salary_cap_enabled' is distinct from 'true';

do $$ declare f record; d text; patched boolean:=false; begin
 for f in select oid from pg_proc where pronamespace='public'::regnamespace and proname='save_nl_recovery' loop
  d:=pg_get_functiondef(f.oid);
  if position('-- Available pay without percentage cap' in d)>0 then patched:=true; continue; end if;
  if position('-- Explicit exception options' in d)=0 then continue; end if;
  d:=replace(d,$p$v_override boolean:=coalesce((p_plan->>'cap_override')::boolean,false);$p$,
    $p$v_override boolean:=false; -- Available pay without percentage cap$p$);
  d:=replace(d,$p$v_override_reason text:=nullif(trim(coalesce(p_plan->>'cap_override_reason','')),'');$p$,
    $p$v_override_reason text:=null;$p$);
  d:=replace(d,$p$if (policy->>'salary_cap_enabled')::boolean then$p$,$p$if true then -- Always verify available pay$p$);
  d:=replace(d,$p$pay.payable*(case when v_override then 100 else (policy->>'salary_cap_percent')::numeric end)/100$p$,'pay.payable');
  d:=replace(d,$p$case when v_override then 'take-home' else (policy->>'salary_cap_percent')||'%' end$p$,$p$'available-pay'$p$);
  d:=replace(d,$p$case when v_override then '' else ', or record a cap override' end$p$,$p$''$p$);
  if position('-- Available pay without percentage cap' in d)=0 or position('-- Always verify available pay' in d)=0
    or position('pay.payable*' in d)>0 then raise exception 'Available-pay writer patch did not match'; end if;
  execute d; patched:=true;
 end loop;
 if not patched then raise exception 'Current recovery writer is required'; end if;
end $$;

-- Keep the due RPC contract compatible with older payroll clients during rollout.
-- New payroll code ignores these legacy fields; old clients receive 100 percent.
do $$ declare f record; d text; patched boolean:=false; begin
 for f in select oid from pg_proc where pronamespace='public'::regnamespace and proname='nl_loss_recovery_due' loop
  d:=pg_get_functiondef(f.oid);
  if position('100::numeric cap_percent' in d)>0 then patched:=true; continue; end if;
  d:=regexp_replace(d,'case when coalesce\(\(s.recovery_policy->>''salary_cap_enabled''\)::boolean,false\)[[:space:]]+then least\(100,greatest\(1,coalesce\(\(s.recovery_policy->>''salary_cap_percent''\)::numeric,100\)\)\)[[:space:]]+else 100 end cap_percent','100::numeric cap_percent');
  if position('100::numeric cap_percent' in d)=0 then raise exception 'Available-pay due patch did not match'; end if;
  execute d; patched:=true;
 end loop;
 if not patched then raise exception 'Recovery due function is required'; end if;
end $$;
commit;
