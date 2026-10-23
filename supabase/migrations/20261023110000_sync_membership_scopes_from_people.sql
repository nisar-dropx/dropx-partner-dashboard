begin;

-- Keep portal membership scopes aligned with People "Managed locations".
-- designation_policy / google_workspace / person_override rows follow the person scope;
-- manual / product_owner / product_admin memberships are left alone.

create or replace function public.sync_product_membership_scopes_from_person()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update company_product_memberships m
  set
    location_scope_ids = case
      when coalesce(new.has_all_location_access, false) then '{}'::uuid[]
      else coalesce(new.location_scope_ids, '{}'::uuid[])
    end,
    has_all_location_access = coalesce(new.has_all_location_access, false),
    updated_at = now()
  from hr_user_person_links l
  where l.person_id = new.person_id
    and l.company_id = new.company_id
    and l.status = 'active'
    and m.user_id = l.user_id
    and m.company_id = new.company_id
    and m.is_active = true
    and m.source_system in ('designation_policy', 'google_workspace', 'person_override');
  return new;
end;
$$;

drop trigger if exists trg_sync_membership_scopes_from_person on public.people_person_access_scopes;
create trigger trg_sync_membership_scopes_from_person
after insert or update of location_scope_ids, has_all_location_access
on public.people_person_access_scopes
for each row execute function public.sync_product_membership_scopes_from_person();

commit;
