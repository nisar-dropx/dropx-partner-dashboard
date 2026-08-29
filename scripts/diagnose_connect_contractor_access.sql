-- DropX One: diagnose independent contractor login/access issues.
-- Run in Supabase SQL editor. Replace the mobile filter as needed.

with target_mobile as (
  select '9645881397'::text as mobile
),
contractors as (
  select
    contractor.id,
    contractor.company_id,
    contractor.full_name,
    contractor.dropx_id,
    contractor.biometric_id,
    contractor.designation,
    contractor.mobile,
    contractor.is_active,
    contractor.onboarding_status
  from public.contractors contractor
  cross join target_mobile target
  where regexp_replace(coalesce(contractor.mobile, ''), '\D', '', 'g') like '%' || target.mobile
),
workforce_mirrors as (
  select
    workforce.id,
    workforce.company_id,
    workforce.full_name,
    workforce.dropx_id,
    workforce.source_profile_type,
    workforce.source_profile_id,
    workforce.is_active,
    workforce.onboarding_status,
    workforce.lifecycle_status,
    workforce.deleted_at
  from public.workforce workforce
  where workforce.source_profile_type = 'contractor'
)
select
  'contractor' as register,
  contractor.id,
  contractor.company_id,
  contractor.full_name,
  contractor.dropx_id,
  contractor.designation,
  contractor.is_active,
  contractor.onboarding_status,
  mirror.id as workforce_mirror_id,
  mirror.is_active as workforce_mirror_active
from contractors contractor
left join workforce_mirrors mirror
  on mirror.company_id = contractor.company_id
 and mirror.source_profile_id = contractor.id
order by contractor.full_name;

-- Manager login on DropX One (profiles) and linked workforce registers for the same person.
select
  profile.id as profile_id,
  profile.full_name as profile_name,
  profile.employee_id as profile_reference,
  profile.role as profile_role,
  profile.mobile as profile_mobile,
  employee.id as employee_id,
  employee.employee_code,
  employee.mobile as employee_mobile,
  contractor.id as contractor_id,
  contractor.dropx_id as contractor_dropx_id,
  contractor.mobile as contractor_mobile
from public.profiles profile
left join public.employees employee
  on employee.company_id = profile.company_id
 and employee.is_active
 and (
   lower(btrim(employee.employee_code)) = lower(btrim(profile.employee_id))
   or lower(btrim(employee.biometric_id::text)) = lower(btrim(profile.employee_id))
 )
left join public.contractors contractor
  on contractor.company_id = profile.company_id
 and contractor.is_active
 and (
   lower(btrim(contractor.dropx_id)) = lower(btrim(profile.employee_id))
   or lower(btrim(contractor.biometric_id::text)) = lower(btrim(profile.employee_id))
 )
cross join target_mobile target
where profile.is_active
  and regexp_replace(coalesce(profile.mobile, ''), '\D', '', 'g') like '%' || target.mobile
order by profile.full_name;

select
  designation.code,
  designation.name,
  designation.onboarding_categories,
  register.code as register_code,
  register.table_name,
  route.registration_enabled,
  route.reconciliation_status
from public.designations designation
join public.designation_register_routes route
  on route.designation_id = designation.id
 and route.company_id = designation.company_id
join public.workforce_register_master register
  on register.id = route.register_id
 and register.company_id = route.company_id
where designation.is_active
  and 'contractors' = any (designation.onboarding_categories)
order by designation.code;
