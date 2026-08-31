begin;

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
      and not contractor.is_active
      and not exists (
        select 1
        from public.workforce_pickers picker
        where picker.company_id = contractor.company_id
          and upper(btrim(coalesce(picker.dropx_id, ''))) = upper(btrim(coalesce(contractor.dropx_id, '')))
          and lower(btrim(coalesce(picker.onboarding_status, ''))) = 'active'
      );
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
