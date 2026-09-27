-- Stop the earlier worker; invalidated leases cannot overwrite a newer interpretation.
create or replace function public.claim_cod_proof_check_v4() returns setof public.cod_submissions language plpgsql security invoker set search_path=public as $$ begin return;end $$;
update public.cod_submissions set ai_status='Validation pending',ai_summary=null,ai_result='{}',proof_check_token=null,proof_check_started_at=null,proof_checked_at=null,proof_check_attempts=0
 where returned_at is null and (ai_status='Checking' or (ai_status='Not valid' and ai_summary ~* 'does not match|not readable'));
create function public.claim_cod_proof_check_v5() returns setof public.cod_submissions language plpgsql security invoker set search_path=public as $$
begin
 return query with candidate as (
 select id from public.cod_submissions where returned_at is null and (ai_status='Validation pending'
 or (ai_status='Validation unavailable' and proof_check_attempts<3 and proof_check_started_at<now()-interval '15 minutes')
 or (ai_status='Checking' and proof_check_started_at<now()-interval '5 minutes'))
 order by created_at desc for update skip locked limit 1)
 update public.cod_submissions s set ai_status='Checking',proof_check_token=gen_random_uuid(),proof_check_started_at=now(),proof_check_attempts=s.proof_check_attempts+1
 from candidate c where s.id=c.id returning s.*;
end $$;
revoke all on function public.claim_cod_proof_check_v5() from public,anon,authenticated;
grant execute on function public.claim_cod_proof_check_v5() to service_role;
