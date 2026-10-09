-- Mobile numbers are contact details and may be shared by independent People IDs.
-- Keep format validation, email uniqueness, DropX ID uniqueness, biometric ID
-- uniqueness, designation routing, and lifecycle rules outside this phone guard.
create or replace function public.enforce_onboarding_mobile_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- Preserve every existing field. This trigger only stops treating a shared
  -- phone number as an identity or lifecycle conflict.
  return new;
end
$function$;

comment on function public.enforce_onboarding_mobile_identity() is
  'Allows mobile numbers to be shared across independent People IDs without changing non-phone identity or lifecycle rules.';
