-- Stop paid model checks and make proof review an explicit authorised human action.
create or replace function public.cod_proof_guard() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
 if TG_OP='INSERT' then
  new.ai_status:='Review pending';new.ai_summary:=null;new.ai_result:='{}';new.proof_version:=1;
  new.proof_check_attempts:=0;new.proof_check_token:=null;new.proof_checked_at:=null;new.proof_check_started_at:=null;
 elsif public.cod_proof_snapshot(old) is distinct from public.cod_proof_snapshot(new) then
  new.ai_status:='Review pending';new.ai_summary:=null;new.ai_result:='{}';new.ai_confidence:=null;
  new.proof_version:=old.proof_version+1;new.proof_check_attempts:=0;new.proof_check_token:=null;new.proof_checked_at:=null;new.proof_check_started_at:=null;
 end if;
 return new;
end $$;

create or replace function public.cod_proof_audit() returns trigger
language plpgsql security invoker set search_path=public as $$
declare event_name text; before_values jsonb; actor uuid; actor_label text;
begin
 if TG_OP='INSERT' then event_name:='Uploaded';actor:=new.created_by;actor_label:=new.last_updater_name;
 elsif public.cod_proof_snapshot(old) is distinct from public.cod_proof_snapshot(new) then event_name:='Submission updated';actor:=new.last_updated_by;actor_label:=new.last_updater_name;
 elsif row(new.ai_status,new.ai_summary) is distinct from row(old.ai_status,old.ai_summary) then
  event_name:=case when new.ai_status='Review pending' then 'Review pending' else 'Manual review completed' end;
  actor:=new.last_updated_by;actor_label:=coalesce(new.last_updater_name,'COD reviewer');
 else return new;end if;
 if TG_OP='UPDATE' then before_values:=public.cod_proof_snapshot(old)||jsonb_build_object('validation',old.ai_status,'reason',old.ai_summary);end if;
 insert into public.cod_proof_history(company_id,submission_id,event,actor_id,actor_name,old_values,new_values)
 values(new.company_id,new.id,event_name,actor,actor_label,before_values,public.cod_proof_snapshot(new)||jsonb_build_object('validation',new.ai_status,'reason',new.ai_summary));
 return new;
end $$;

-- Remove automatic decisions and queue every non-returned proof for an authorised reviewer.
update public.cod_submissions
set ai_status='Review pending',ai_summary=null,ai_result='{}',proof_checked_at=null,
    proof_check_token=null,proof_check_started_at=null,proof_check_attempts=0
where returned_at is null
  and coalesce(ai_status,'') in ('Validation pending','Validation unavailable','Checking','Details unclear','Valid','Not valid');

-- All deployed worker versions become harmless immediately, including an older live deployment.
create or replace function public.claim_cod_proof_check_v5()
returns setof public.cod_submissions language sql security definer set search_path=public as $$
 select * from public.cod_submissions where false;
$$;
create or replace function public.claim_cod_proof_check_v6()
returns setof public.cod_submissions language sql security definer set search_path=public as $$
 select * from public.cod_submissions where false;
$$;
revoke all on function public.claim_cod_proof_check_v5() from public,anon,authenticated;
revoke all on function public.claim_cod_proof_check_v6() from public,anon,authenticated;
grant execute on function public.claim_cod_proof_check_v5() to service_role;
grant execute on function public.claim_cod_proof_check_v6() to service_role;
notify pgrst,'reload schema';
