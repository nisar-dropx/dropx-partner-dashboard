-- Replace the retired Field Executives category with the canonical Workforce
-- category without losing its company-specific configuration.
begin;

insert into public.workforce_categories (
  company_id,
  code,
  name,
  profile_field_rules,
  app_page_access,
  statutory_enabled,
  direct_activate,
  is_system,
  is_active,
  sort_order
)
select
  company.id,
  'workforce',
  'Workforce',
  coalesce(legacy.profile_field_rules, '{}'::jsonb),
  coalesce(legacy.app_page_access, array['dashboard', 'attendance', 'settings']::text[]),
  coalesce(legacy.statutory_enabled, false),
  coalesce(legacy.direct_activate, false),
  true,
  coalesce(legacy.is_active, true),
  coalesce(legacy.sort_order, 20)
from public.companies company
left join public.workforce_categories legacy
  on legacy.company_id = company.id
 and legacy.code = 'field_executives'
on conflict (company_id, code) do update
set
  name = 'Workforce',
  profile_field_rules = case
    when excluded.profile_field_rules = '{}'::jsonb
      then public.workforce_categories.profile_field_rules
    else excluded.profile_field_rules
  end,
  app_page_access = excluded.app_page_access,
  statutory_enabled = excluded.statutory_enabled,
  direct_activate = excluded.direct_activate,
  is_system = true,
  is_active = true,
  sort_order = excluded.sort_order,
  updated_at = now();

update public.designations
set
  onboarding_categories = array(
    select distinct case when category = 'field_executives' then 'workforce' else category end
    from unnest(coalesce(onboarding_categories, '{}'::text[])) category
  ),
  profile_field_rules = case
    when profile_field_rules ? 'field_executives' then
      (profile_field_rules - 'field_executives') || jsonb_build_object(
        'workforce',
        coalesce(profile_field_rules -> 'workforce', profile_field_rules -> 'field_executives')
      )
    else profile_field_rules
  end,
  updated_at = now()
where 'field_executives' = any(coalesce(onboarding_categories, '{}'::text[]))
   or profile_field_rules ? 'field_executives';

do $$
begin
  if to_regclass('public.workforce_deduction_heads') is not null
     and exists (
       select 1
       from information_schema.columns
       where table_schema = 'public'
         and table_name = 'workforce_deduction_heads'
         and column_name = 'workforce_category_codes'
     ) then
    update public.workforce_deduction_heads
    set workforce_category_codes = array(
      select distinct case when category = 'field_executives' then 'workforce' else category end
      from unnest(coalesce(workforce_category_codes, '{}'::text[])) category
    )
    where 'field_executives' = any(coalesce(workforce_category_codes, '{}'::text[]));
  end if;
end
$$;

delete from public.workforce_categories
where code = 'field_executives';

notify pgrst, 'reload schema';

commit;
