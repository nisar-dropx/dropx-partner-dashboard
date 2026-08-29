-- Find every register row tied to a Connect manager login reference (e.g. D0905).
-- Replace the reference and/or mobile below before running.

with target_reference as (
  select lower(btrim('D0905')) as reference
),
target_mobile as (
  select regexp_replace('9645881397', '\D', '', 'g') as digits
)
select
  'profiles'::text as register,
  profile.id::text as id,
  profile.full_name::text as full_name,
  profile.employee_id::text as reference,
  profile.role::text as role_or_type,
  profile.mobile::text as mobile
from public.profiles profile
cross join target_reference target
where profile.is_active
  and lower(btrim(profile.employee_id)) = target.reference

union all

select
  'employees'::text,
  employee.id::text,
  employee.full_name::text,
  employee.employee_code::text,
  'employee'::text,
  employee.mobile::text
from public.employees employee
cross join target_reference target
where employee.is_active
  and (
    lower(btrim(employee.employee_code)) = target.reference
    or lower(btrim(employee.biometric_id::text)) = target.reference
    or lower(btrim(employee.id::text)) = target.reference
  )

union all

select
  'contractors'::text,
  contractor.id::text,
  contractor.full_name::text,
  contractor.dropx_id::text,
  'contractor'::text,
  contractor.mobile::text
from public.contractors contractor
cross join target_reference target
where (
    lower(btrim(contractor.dropx_id)) = target.reference
    or lower(btrim(contractor.biometric_id::text)) = target.reference
    or lower(btrim(contractor.id::text)) = target.reference
  )

union all

select
  'field_executives'::text,
  executive.id::text,
  executive.full_name::text,
  executive.dropx_id::text,
  'field_executive'::text,
  executive.mobile::text
from public.field_executives executive
cross join target_reference target
where coalesce(executive.onboarding_status, 'pending') not in ('rejected', 'cancelled')
  and (
    lower(btrim(executive.dropx_id)) = target.reference
    or lower(btrim(executive.biometric_id::text)) = target.reference
    or lower(btrim(executive.id::text)) = target.reference
  )

union all

select
  'workforce'::text,
  workforce.id::text,
  workforce.full_name::text,
  workforce.dropx_id::text,
  coalesce(workforce.source_profile_type, 'workforce')::text,
  null::text
from public.workforce workforce
cross join target_reference target
where (
    lower(btrim(workforce.dropx_id)) = target.reference
    or lower(btrim(workforce.biometric_id::text)) = target.reference
    or lower(btrim(workforce.id::text)) = target.reference
  );

-- Same person by mobile (helps when profile.employee_id does not match any register).
select
  'profiles_by_mobile'::text as register,
  profile.id::text,
  profile.full_name::text,
  profile.employee_id::text as reference,
  profile.role::text as role_or_type,
  profile.mobile::text
from public.profiles profile
cross join target_mobile target
where profile.is_active
  and regexp_replace(coalesce(profile.mobile, ''), '\D', '', 'g') like '%' || target.digits

union all

select
  'employees_by_mobile'::text,
  employee.id::text,
  employee.full_name::text,
  employee.employee_code::text,
  'employee'::text,
  employee.mobile::text
from public.employees employee
cross join target_mobile target
where employee.is_active
  and regexp_replace(coalesce(employee.mobile, ''), '\D', '', 'g') like '%' || target.digits

union all

select
  'contractors_by_mobile'::text,
  contractor.id::text,
  contractor.full_name::text,
  contractor.dropx_id::text,
  'contractor'::text,
  contractor.mobile::text
from public.contractors contractor
cross join target_mobile target
where regexp_replace(coalesce(contractor.mobile, ''), '\D', '', 'g') like '%' || target.digits;
