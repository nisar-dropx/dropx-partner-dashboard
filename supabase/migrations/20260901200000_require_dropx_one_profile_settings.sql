-- My Profile and Settings are mandatory DropX One pages for every category
-- and designation. Preserve existing selections and append the locked pages.
begin;

update public.workforce_categories
set
  app_page_access = array(
    select distinct page
    from unnest(coalesce(app_page_access, '{}'::text[]) || array['profile', 'settings']::text[]) page
  ),
  updated_at = now()
where not (coalesce(app_page_access, '{}'::text[]) @> array['profile', 'settings']::text[]);

update public.designations
set
  app_page_access = array(
    select distinct page
    from unnest(coalesce(app_page_access, '{}'::text[]) || array['profile', 'settings']::text[]) page
  ),
  updated_at = now()
where not (coalesce(app_page_access, '{}'::text[]) @> array['profile', 'settings']::text[]);

notify pgrst, 'reload schema';

commit;
