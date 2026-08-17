update public.workforce_categories
set is_active=false, updated_at=now()
where code='field_executives' and is_active=true;

update public.designations
set onboarding_categories=(
  select array_agg(distinct category order by category)
  from unnest(array_remove(coalesce(onboarding_categories,'{}'::text[]),'field_executives') || array['contractors']) category
)
where onboarding_categories @> array['field_executives']::text[];

with permission_moves as (
  select old_permission.role_id,new_page.id as page_id,
         old_permission.can_view,old_permission.can_add,old_permission.can_edit,
         old_permission.company_id
  from public.role_page_permissions old_permission
  join public.app_pages old_page on old_page.id=old_permission.page_id and old_page.code='delivery_associates'
  join public.app_pages new_page on new_page.code='contractors'
    and new_page.company_id is not distinct from old_page.company_id
)
update public.role_page_permissions current_permission
set can_view=current_permission.can_view or move.can_view,
    can_add=current_permission.can_add or move.can_add,
    can_edit=current_permission.can_edit or move.can_edit,
    updated_at=now()
from permission_moves move
where current_permission.role_id=move.role_id and current_permission.page_id=move.page_id;

with permission_moves as (
  select old_permission.role_id,new_page.id as page_id,
         old_permission.can_view,old_permission.can_add,old_permission.can_edit,
         old_permission.company_id
  from public.role_page_permissions old_permission
  join public.app_pages old_page on old_page.id=old_permission.page_id and old_page.code='delivery_associates'
  join public.app_pages new_page on new_page.code='contractors'
    and new_page.company_id is not distinct from old_page.company_id
)
insert into public.role_page_permissions(role_id,page_id,can_view,can_add,can_edit,company_id,created_at,updated_at)
select move.role_id,move.page_id,move.can_view,move.can_add,move.can_edit,move.company_id,now(),now()
from permission_moves move
where not exists (
  select 1 from public.role_page_permissions existing
  where existing.role_id=move.role_id and existing.page_id=move.page_id
);

update public.app_pages set is_active=false,updated_at=now() where code='delivery_associates';
