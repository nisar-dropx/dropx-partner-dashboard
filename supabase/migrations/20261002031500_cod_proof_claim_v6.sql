-- New RPC name forces PostgREST to refresh the proof-worker claim path after
-- the security context correction. Only the service role may execute it.
create function public.claim_cod_proof_check_v6()
returns setof public.cod_submissions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with candidate as (
    select id
    from public.cod_submissions
    where returned_at is null
      and (
        ai_status = 'Validation pending'
        or (
          ai_status = 'Validation unavailable'
          and proof_check_attempts < 3
          and proof_check_started_at < now() - interval '15 minutes'
        )
        or (
          ai_status = 'Checking'
          and proof_check_started_at < now() - interval '5 minutes'
        )
      )
    order by deposit_date desc, created_at desc
    for update skip locked
    limit 1
  )
  update public.cod_submissions s
  set ai_status = 'Checking',
      proof_check_token = gen_random_uuid(),
      proof_check_started_at = now(),
      proof_check_attempts = s.proof_check_attempts + 1
  from candidate c
  where s.id = c.id
  returning s.*;
end
$$;

revoke all on function public.claim_cod_proof_check_v6() from public, anon, authenticated;
grant execute on function public.claim_cod_proof_check_v6() to service_role;

notify pgrst, 'reload schema';
