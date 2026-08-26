begin;

do $$
begin
  if exists (
    select 1
    from public.payment_fields old_field
    join public.payment_fields new_field
      on new_field.company_id = old_field.company_id
     and new_field.code = 'FIXED_AMT_PER_MONTH'
    where old_field.code = 'FIXED_AMT'
      and old_field.id <> new_field.id
  ) then
    raise exception 'FIXED_AMT_PER_MONTH already exists for a company that still has FIXED_AMT';
  end if;

  update public.payment_method_components component
  set component_code = 'FIXED_AMT_PER_MONTH',
      updated_at = now()
  from public.payment_fields field
  where component.payment_field_id = field.id
    and field.code = 'FIXED_AMT';

  update public.payment_fields
  set code = 'FIXED_AMT_PER_MONTH',
      updated_at = now()
  where code = 'FIXED_AMT';

  if not found then
    raise exception 'Reusable payment field FIXED_AMT was not found';
  end if;
end
$$;

commit;
