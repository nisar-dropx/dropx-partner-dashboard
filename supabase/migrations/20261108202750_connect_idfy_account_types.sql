create or replace view public.connect_idfy_owners with (security_invoker=true) as
with candidates as (
 select w.company_id,w.id owner_id,l.amazon_provider_id provider_id,lower(trim(l.amazon_email)) identity_email,
   w.id account_id,'workforce'::text profile_type
 from public.workforce w join public.workforce_amazon_portal_links l on l.workforce_id=w.id and l.company_id=w.company_id
 where w.deleted_at is null and w.migration_state is distinct from 'reclassified'
 union
 select w.company_id,w.id,l.amazon_provider_id,lower(trim(l.amazon_email)),w.source_profile_id,w.source_profile_type
 from public.workforce w join public.workforce_amazon_portal_links l on l.workforce_id=w.id and l.company_id=w.company_id
 where w.deleted_at is null and w.migration_state is distinct from 'reclassified' and w.source_profile_id is not null and w.source_profile_type in ('employee','field_executive','contractor','vendor','worker')
 union
 select c.company_id,c.id,i.external_reference,lower(trim(c.alias_email)),c.id,'workforce'
 from public.workforce_amazon_email_pilot_candidates c
 join public.workforce_amazon_invitation_requests i on i.id=c.invitation_request_id and i.company_id=c.company_id and i.email_pilot_candidate_id=c.id
 where c.closed_at is null and c.inbox_status<>'suspended' and lower(trim(i.amazon_email))=lower(trim(c.alias_email))
), valid as (
 select * from candidates where provider_id ~ '^amzn1\.flex\.provider\.v1\.[0-9a-f-]{36}$' and identity_email<>''
)
select distinct v.company_id,v.owner_id,v.account_id,v.profile_type,v.provider_id,v.identity_email
from valid v where
 (select count(distinct x.owner_id) from valid x where x.company_id=v.company_id and x.provider_id=v.provider_id)=1
 and (select count(distinct x.provider_id) from valid x where x.company_id=v.company_id and x.account_id=v.account_id and x.profile_type=v.profile_type)=1;
