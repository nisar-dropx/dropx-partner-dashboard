begin;

update public.workforce workforce_profile
set is_active = true,
    synced_at = now(),
    updated_at = now()
from public.designations designation
where designation.id = workforce_profile.designation_id
  and designation.company_id = workforce_profile.company_id
  and lower(btrim(designation.name)) = 'picker'
  and lower(btrim(coalesce(workforce_profile.onboarding_status, ''))) = 'active'
  and workforce_profile.deleted_at is null
  and not workforce_profile.is_active;

-- Picker registration is complete only after onboarding reaches the existing
-- terminal "active" state. Keep the custom Picker register authoritative when
-- it contains the profile; otherwise reactivate the completed legacy record.
do $$
begin
  if to_regclass('public.workforce_pickers') is not null then
    update public.workforce_pickers
    set is_active = true,
        updated_at = now()
    where lower(btrim(coalesce(designation, ''))) = 'picker'
      and lower(btrim(coalesce(onboarding_status, ''))) = 'active'
      and not is_active;

    update public.contractors contractor
    set is_active = true,
        updated_at = now()
    where lower(btrim(coalesce(contractor.designation, ''))) = 'picker'
      and lower(btrim(coalesce(contractor.onboarding_status, ''))) = 'active'
      and contractor.deleted_at is null
      and not contractor.is_active;
  else
    update public.contractors
    set is_active = true,
        updated_at = now()
    where lower(btrim(coalesce(designation, ''))) = 'picker'
      and lower(btrim(coalesce(onboarding_status, ''))) = 'active'
      and deleted_at is null
      and not is_active;
  end if;
end;
$$;

notify pgrst, 'reload schema';

commit;
