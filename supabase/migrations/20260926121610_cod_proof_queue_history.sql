-- A queued check is not a completed validation.
create or replace function public.cod_proof_audit() returns trigger language plpgsql security invoker set search_path=public as $$
declare event_name text; before_values jsonb; actor uuid; actor_label text;
begin
 if TG_OP='INSERT' then event_name:='Uploaded';actor:=new.created_by;actor_label:=new.last_updater_name;
 elsif public.cod_proof_snapshot(old) is distinct from public.cod_proof_snapshot(new) then event_name:='Submission updated';actor:=new.last_updated_by;actor_label:=new.last_updater_name;
 elsif row(new.ai_status,new.ai_summary) is distinct from row(old.ai_status,old.ai_summary) and new.ai_status<>'Checking' then
  event_name:=case when new.ai_status='Validation pending' then 'Validation queued' else 'Validation completed' end;actor_label:='Automatic validation';
 else return new;end if;
 if TG_OP='UPDATE' then before_values:=public.cod_proof_snapshot(old)||jsonb_build_object('validation',old.ai_status,'reason',old.ai_summary);end if;
 insert into public.cod_proof_history(company_id,submission_id,event,actor_id,actor_name,old_values,new_values)
 values(new.company_id,new.id,event_name,actor,actor_label,before_values,public.cod_proof_snapshot(new)||jsonb_build_object('validation',new.ai_status,'reason',new.ai_summary));
 return new;
end $$;
update public.cod_proof_history set event='Validation queued'
 where event='Validation completed' and new_values->>'validation'='Validation pending';
