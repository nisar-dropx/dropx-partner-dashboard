-- Some databases retain the compatibility registration_category column on
-- designations. Keep it aligned when the retired category code is migrated.
begin;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'designations'
      and column_name = 'registration_category'
      and data_type = 'text'
  ) then
    execute $update$
      update public.designations
      set
        registration_category = 'workforce',
        updated_at = now()
      where registration_category = 'field_executives'
    $update$;
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
