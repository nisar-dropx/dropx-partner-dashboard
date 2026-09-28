begin;

-- Existing Field Operations designations keep today's provider-mapping
-- requirement. New designations must opt in explicitly.
do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'designations'
      and column_name = 'provider_mapping_required'
  ) then
    alter table public.designations
      add column provider_mapping_required boolean;

    update public.designations
    set provider_mapping_required = coalesce(is_field_operations, false);
  end if;
end
$$;

-- Complete any interrupted/partial first run conservatively.
update public.designations
set provider_mapping_required = coalesce(is_field_operations, false)
where provider_mapping_required is null;

alter table public.designations
  alter column provider_mapping_required set default false,
  alter column provider_mapping_required set not null;

alter table public.designations
  drop constraint if exists designations_provider_mapping_required_check;

alter table public.designations
  add constraint designations_provider_mapping_required_check
  check (not provider_mapping_required or is_field_operations);

comment on column public.designations.provider_mapping_required is
  'When true, workers assigned to this Field Operations designation must have an active provider ID mapping. When false, provider mapping is optional and unmapped workers use direct workforce payment allocation.';

commit;
