-- Workforce IDs are canonical login identities; source_profile_type is legacy provenance.
update public.ops_da_distance_pilots p
set profile_id=w.id,profile_type='workforce',updated_at=now()
from public.workforce w
where w.id=p.workforce_id and w.company_id=p.company_id
  and (p.profile_id<>w.id or p.profile_type<>'workforce');
