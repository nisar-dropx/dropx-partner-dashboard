-- Advances is available to every DropX One role. Preserve the existing
-- designation/category selections and append the mandatory page.
begin;

update public.workforce_categories
set
  app_page_access = array(
    select distinct page
    from unnest(coalesce(app_page_access, '{}'::text[]) || array['advances']::text[]) page
  ),
  updated_at = now()
where not (coalesce(app_page_access, '{}'::text[]) @> array['advances']::text[]);

update public.designations
set
  app_page_access = array(
    select distinct page
    from unnest(coalesce(app_page_access, '{}'::text[]) || array['advances']::text[]) page
  ),
  updated_at = now()
where not (coalesce(app_page_access, '{}'::text[]) @> array['advances']::text[]);

notify pgrst, 'reload schema';

commit;
