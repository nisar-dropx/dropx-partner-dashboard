-- Find every register row tied to a Connect manager login reference (e.g. D0905).
-- Replace the reference below before running.

with target_reference as (
  select lower(btrim('D0905')) as reference
)
select 'profiles' as register, profile.id, profile.full_name, profile.employee_id as reference, profile.role, profile.mobile
from public.profiles profile
cross join target_reference target
where profile.is_active
  and lower(btrim(profile.employee_id)) = target.reference

union all

select 'employees', employee.id, employee.full_name, employee.employee_code, 'employee', employee.mobile
from public.employees employee
cross join target_reference target
where employee.is_active
  and (
    lower(btrim(employee.employee_code)) = target.reference
    or lower(btrim(employee.biometric_id::text)) = target.reference
  )

union all

select 'contractors', contractor.id, contractor.full_name, contractor.dropx_id, 'contractor', contractor.mobile
from public.contractors contractor
cross join target_reference target
where contractor.is_active
  and (
    lower(btrim(contractor.dropx_id)) = target.reference
    or lower(btrim(contractor.biometric_id::text)) = target.reference
  )

union all

select 'field_executives', executive.id, executive.full_name, executive.dropx_id, 'field_executive', executive.mobile
from public.field_executives executive
cross join target_reference target
where coalesce(executive.onboarding_status, 'pending') not in ('rejected', 'cancelled')
  and (
    lower(btrim(executive.dropx_id)) = target.reference
    or lower(btrim(executive.biometric_id::text)) = target.reference
  )

union all

select 'workforce', workforce.id, workforce.full_name, workforce.dropx_id, workforce.source_profile_type, null
from public.workforce workforce
cross join target_reference target
where (
    lower(btrim(workforce.dropx_id)) = target.reference
    or lower(btrim(workforce.biometric_id::text)) = target.reference
  );
