-- Backfill contractor / field executive mobile numbers from active manager profiles.
-- Many IC logins only match public.profiles, while the self-service register row kept an empty mobile.
-- Run once in Supabase SQL editor, review the preview counts, then uncomment the update blocks.

with profile_links as (
  select
    profile.company_id,
    profile.mobile_country_code,
    profile.mobile,
    lower(btrim(profile.employee_id)) as profile_reference
  from public.profiles profile
  where profile.is_active
    and profile.employee_id is not null
    and btrim(profile.employee_id) <> ''
    and profile.mobile is not null
    and btrim(profile.mobile) <> ''
)
select
  'contractors_missing_mobile' as bucket,
  count(*) as row_count
from public.contractors contractor
join profile_links profile
  on profile.company_id = contractor.company_id
 and lower(btrim(contractor.dropx_id)) = profile.profile_reference
where contractor.is_active
  and (contractor.mobile is null or btrim(contractor.mobile) = '')

union all

select
  'field_executives_missing_mobile' as bucket,
  count(*) as row_count
from public.field_executives executive
join profile_links profile
  on profile.company_id = executive.company_id
 and lower(btrim(executive.dropx_id)) = profile.profile_reference
where coalesce(executive.onboarding_status, 'pending') not in ('rejected', 'cancelled')
  and (executive.mobile is null or btrim(executive.mobile) = '');

/*
update public.contractors contractor
set mobile_country_code = profile.mobile_country_code,
    mobile = profile.mobile,
    updated_at = now()
from profile_links profile
where contractor.company_id = profile.company_id
  and contractor.is_active
  and lower(btrim(contractor.dropx_id)) = profile.profile_reference
  and (contractor.mobile is null or btrim(contractor.mobile) = '');

update public.field_executives executive
set mobile_country_code = profile.mobile_country_code,
    mobile = profile.mobile,
    updated_at = now()
from profile_links profile
where executive.company_id = profile.company_id
  and coalesce(executive.onboarding_status, 'pending') not in ('rejected', 'cancelled')
  and lower(btrim(executive.dropx_id)) = profile.profile_reference
  and (executive.mobile is null or btrim(executive.mobile) = '');
*/
