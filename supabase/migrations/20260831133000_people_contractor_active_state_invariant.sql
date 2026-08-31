begin;

-- People contractor profiles stay visible while onboarding is in progress. Once
-- onboarding reaches Active, a stale routing flag may never keep the profile
-- suspended. Deleted profiles remain inactive. The rule is derived from the
-- Designation Category and onboarding master; no designation code is embedded.
create or replace function public.enforce_people_contractor_active_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  people_module_value text;
  onboarding_categories_value text[];
begin
  select category.people_module, designation.onboarding_categories
  into people_module_value, onboarding_categories_value
  from public.designations designation
  join public.designation_categories category
    on category.id = designation.designation_category_id
   and category.company_id = designation.company_id
  where designation.company_id = new.company_id
    and designation.is_active
    and (
      (new.designation_id is not null and designation.id = new.designation_id)
      or (
        new.designation_id is null
        and nullif(btrim(new.designation), '') is not null
        and (
          upper(designation.code) = upper(btrim(new.designation))
          or lower(btrim(designation.name)) = lower(btrim(new.designation))
        )
      )
    )
  order by case when new.designation_id is not null and designation.id = new.designation_id then 0 else 1 end
  limit 1;

  if lower(coalesce(people_module_value, '')) like 'people%'
     and 'contractors' = any(coalesce(onboarding_categories_value, '{}'::text[])) then
    if new.deleted_at is not null then
      new.is_active := false;
    elsif lower(coalesce(new.onboarding_status, '')) = 'active' then
      new.is_active := true;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists contractors_enforce_people_active_state
  on public.contractors;
create trigger contractors_enforce_people_active_state
before insert or update of designation, designation_id, onboarding_status, is_active, deleted_at
on public.contractors
for each row execute function public.enforce_people_contractor_active_state();

revoke all on function public.enforce_people_contractor_active_state()
  from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
