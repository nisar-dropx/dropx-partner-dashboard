begin;

create or replace view public.workforce_payout_linked_pan_aadhaar
with (security_invoker = true) as
select verification.company_id, verification.account_id
from public.connect_profile_verifications verification
where verification.profile_type = 'workforce'
  and verification.kind = 'pan_aadhaar'
  and verification.verified = true
union
select override.company_id, override.profile_id as account_id
from public.people_pan_aadhaar_overrides override
join public.workforce worker
  on worker.company_id = override.company_id and worker.id = override.profile_id
where override.category_code = 'workforce'
  and override.linked
  and override.pair_hash = encode(sha256(convert_to(
    upper(regexp_replace(worker.pan_number, '^[[:space:]]+|[[:space:]]+$', '', 'g'))
      || '|' || regexp_replace(worker.aadhaar_number, '[[:space:]]', '', 'g'),
    'UTF8'
  )), 'hex');

revoke all on public.workforce_payout_linked_pan_aadhaar from public, anon, authenticated;
grant select on public.workforce_payout_linked_pan_aadhaar to service_role;

-- Preserve later bank-file changes and replace only the identity eligibility gate.
do $migration$
declare
  candidate regprocedure;
  definition text;
  old_gate constant text := $old$      from public.connect_profile_verifications verification
      where verification.company_id = p_company_id
        and verification.profile_type = 'workforce'
        and verification.account_id = v_workforce_id
        and verification.kind = 'pan_aadhaar'
        and verification.verified = true$old$;
  new_gate constant text := $new$      from public.workforce_payout_linked_pan_aadhaar verification
      where verification.company_id = p_company_id
        and verification.account_id = v_workforce_id$new$;
begin
  foreach candidate in array array[
    'public.workforce_payout_payment_candidates(uuid,date,date,uuid[])'::regprocedure,
    'public.workforce_payout_payment_row_candidates(uuid,date,date,jsonb)'::regprocedure
  ] loop
    definition := replace(pg_get_functiondef(candidate), chr(13), '');
    if strpos(definition, new_gate) > 0 then
      continue;
    end if;
    if strpos(definition, old_gate) = 0 then
      raise exception 'Unexpected PAN-Aadhaar check in %', candidate;
    end if;
    execute replace(definition, old_gate, new_gate);
  end loop;
end
$migration$;

notify pgrst, 'reload schema';
commit;
