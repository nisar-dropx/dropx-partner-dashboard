begin;

-- People "Managed locations" is the source of truth for operational ownership.
-- Keep the shared station responsibility and direct operational reporting links
-- aligned so OpsPulse, DropX One, reminders and configured workflows cannot
-- continue routing to a manager after that station leaves their People scope.

-- Every portal reads one of these compatibility surfaces today. Keep all of
-- them aligned from the People person scope until the remaining legacy readers
-- can be removed. Only People-generated memberships are synchronized; manual,
-- location-account and product-owner grants remain owned by their portal master.
create or replace function public.sync_product_membership_scopes_from_person()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_person_id uuid;
  v_location_scope_ids uuid[];
  v_has_all_location_access boolean;
begin
  if tg_op = 'DELETE' then
    v_company_id := old.company_id;
    v_person_id := old.person_id;
    v_location_scope_ids := '{}'::uuid[];
    v_has_all_location_access := false;
  else
    v_company_id := new.company_id;
    v_person_id := new.person_id;
    v_location_scope_ids := case
      when coalesce(new.has_all_location_access, false) then '{}'::uuid[]
      else coalesce(new.location_scope_ids, '{}'::uuid[])
    end;
    v_has_all_location_access := coalesce(new.has_all_location_access, false);
  end if;

  update profiles profile
  set location_scope_ids = v_location_scope_ids,
      updated_at = clock_timestamp()
  from hr_user_person_links link
  where link.company_id = v_company_id
    and link.person_id = v_person_id
    and link.status = 'active'
    and profile.company_id = v_company_id
    and profile.id = link.user_id
    and profile.location_scope_ids is distinct from v_location_scope_ids;

  update company_product_memberships membership
  set location_scope_ids = v_location_scope_ids,
      has_all_location_access = v_has_all_location_access,
      updated_at = clock_timestamp()
  from hr_user_person_links link
  where link.company_id = v_company_id
    and link.person_id = v_person_id
    and link.status = 'active'
    and membership.company_id = v_company_id
    and membership.user_id = link.user_id
    and membership.is_active = true
    and membership.source_system in ('designation_policy', 'google_workspace', 'person_override')
    and (
      membership.location_scope_ids is distinct from v_location_scope_ids
      or membership.has_all_location_access is distinct from v_has_all_location_access
    );

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_membership_scopes_from_person on public.people_person_access_scopes;
create trigger trg_sync_membership_scopes_from_person
after insert or update of location_scope_ids, has_all_location_access
on public.people_person_access_scopes
for each row execute function public.sync_product_membership_scopes_from_person();

drop trigger if exists trg_delete_membership_scopes_from_person on public.people_person_access_scopes;
create trigger trg_delete_membership_scopes_from_person
after delete on public.people_person_access_scopes
for each row execute function public.sync_product_membership_scopes_from_person();

-- Keep profiles.reports_to_user_id as a compatibility mirror of the current
-- People solid-line relationship. Recruit and a few older notification paths
-- still read it while OpsPulse/Finance/One read hr_reporting_relationships.
create or replace function public.reconcile_legacy_profile_reporting_manager(
  p_company_id uuid,
  p_subject_assignment_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_subject_person_id uuid;
  v_manager_user_id uuid;
begin
  select engagement.person_id
    into v_subject_person_id
  from hr_work_assignments assignment
  join hr_engagements engagement
    on engagement.id = assignment.engagement_id
   and engagement.company_id = p_company_id
  where assignment.company_id = p_company_id
    and assignment.id = p_subject_assignment_id
  limit 1;

  if v_subject_person_id is null then return; end if;

  select manager_link.user_id
    into v_manager_user_id
  from hr_reporting_relationships relationship
  join hr_work_assignments manager_assignment
    on manager_assignment.id = relationship.manager_assignment_id
   and manager_assignment.company_id = p_company_id
  join hr_engagements manager_engagement
    on manager_engagement.id = manager_assignment.engagement_id
   and manager_engagement.company_id = p_company_id
   and manager_engagement.status = 'active'
   and manager_engagement.start_date <= current_date
   and (manager_engagement.end_date is null or manager_engagement.end_date >= current_date)
  join hr_user_person_links manager_link
    on manager_link.company_id = p_company_id
   and manager_link.person_id = manager_engagement.person_id
   and manager_link.status = 'active'
  join profiles manager_profile
    on manager_profile.company_id = p_company_id
   and manager_profile.id = manager_link.user_id
   and manager_profile.is_active = true
  where relationship.company_id = p_company_id
    and relationship.subject_assignment_id = p_subject_assignment_id
    and relationship.relationship_type = 'solid_line'
    and relationship.is_primary = true
    and relationship.effective_from <= current_date
    and (relationship.effective_to is null or relationship.effective_to >= current_date)
  order by relationship.effective_from desc, relationship.id, manager_link.id
  limit 1;

  update profiles subject_profile
  set reports_to_user_id = v_manager_user_id,
      updated_at = clock_timestamp()
  from hr_user_person_links subject_link
  where subject_link.company_id = p_company_id
    and subject_link.person_id = v_subject_person_id
    and subject_link.status = 'active'
    and subject_profile.company_id = p_company_id
    and subject_profile.id = subject_link.user_id
    and subject_profile.reports_to_user_id is distinct from v_manager_user_id;
end;
$$;

create or replace function public.sync_legacy_profile_reporting_manager()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.reconcile_legacy_profile_reporting_manager(old.company_id, old.subject_assignment_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.reconcile_legacy_profile_reporting_manager(new.company_id, new.subject_assignment_id);
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_legacy_profile_reporting_manager on public.hr_reporting_relationships;
create trigger trg_sync_legacy_profile_reporting_manager
after insert or update or delete on public.hr_reporting_relationships
for each row execute function public.sync_legacy_profile_reporting_manager();

create or replace function public.reconcile_people_operational_routing(
  p_company_id uuid,
  p_station_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_station_id uuid;
  v_role_id uuid;
  v_manager_role_ids uuid[];
  v_manager_assignment_id uuid;
  v_manager_person_id uuid;
  v_manager_user_id uuid;
  v_manager_email text;
  v_manager_count integer;
  v_subject_assignment_ids uuid[];
begin
  if p_company_id is null or coalesce(cardinality(p_station_ids), 0) = 0 then
    return;
  end if;

  select id
    into v_role_id
  from station_responsibility_roles
  where company_id = p_company_id
    and code = 'station_manager'
    and owning_product_code = 'operations'
    and is_active = true
  order by escalation_order desc, id
  limit 1;

  if v_role_id is null then
    return;
  end if;

  select coalesce(array_agg(id), array[v_role_id])
    into v_manager_role_ids
  from station_responsibility_roles
  where company_id = p_company_id
    and code in ('station_manager', 'cluster_manager')
    and owning_product_code = 'operations'
    and is_active = true;

  for v_station_id in
    select distinct station_id
    from unnest(p_station_ids) station_id
    join stations st on st.id = station_id and st.company_id = p_company_id
    where station_id is not null
  loop
    v_manager_assignment_id := null;
    v_manager_person_id := null;
    v_manager_user_id := null;
    v_manager_email := null;
    v_manager_count := 0;

    -- Prefer the one active scoped CLM. When no CLM is mapped, use the one
    -- scoped AOM. Ambiguous tiers are deliberately not guessed.
    with manager_candidates as (
      select distinct on (wa.id)
        wa.id as assignment_id,
        person.id as person_id,
        link.user_id,
        profile.email,
        case
          when upper(coalesce(designation.code, '')) in ('CLM', 'CM')
            or upper(coalesce(designation.name, '')) like '%CLUSTER MANAGER%'
            or upper(coalesce(designation.name, '')) like '%CLUSTER HEAD%'
          then 1
          when upper(coalesce(designation.code, '')) = 'AOM'
            or upper(coalesce(designation.name, '')) like '%AREA OPERATIONS MANAGER%'
            or upper(coalesce(designation.name, '')) like '%AREA OPERATION MANAGER%'
          then 2
          else 99
        end as manager_tier
      from people_person_access_scopes scope
      join hr_people person
        on person.id = scope.person_id
       and person.company_id = scope.company_id
       and person.status = 'active'
      join hr_engagements engagement
        on engagement.person_id = person.id
       and engagement.company_id = p_company_id
       and engagement.status = 'active'
       and engagement.start_date <= current_date
       and (engagement.end_date is null or engagement.end_date >= current_date)
      join hr_work_assignments wa
        on wa.engagement_id = engagement.id
       and wa.company_id = p_company_id
       and wa.is_primary = true
       and wa.effective_from <= current_date
       and (wa.effective_to is null or wa.effective_to >= current_date)
      left join designations designation on designation.id = wa.designation_id
      join lateral (
        select user_id
        from hr_user_person_links
        where company_id = p_company_id
          and person_id = person.id
          and status = 'active'
        order by id
        limit 1
      ) link on true
      join profiles profile
        on profile.id = link.user_id
       and profile.company_id = p_company_id
       and profile.is_active = true
      where scope.company_id = p_company_id
        and (
          coalesce(scope.has_all_location_access, false)
          or v_station_id = any(coalesce(scope.location_scope_ids, '{}'::uuid[]))
        )
    ), preferred as (
      select *, count(*) over (partition by manager_tier) as tier_count
      from manager_candidates
      where manager_tier in (1, 2)
    )
    select assignment_id, person_id, user_id, email, tier_count
      into v_manager_assignment_id, v_manager_person_id, v_manager_user_id,
           v_manager_email, v_manager_count
    from preferred
    where manager_tier = (select min(manager_tier) from preferred)
    order by assignment_id
    limit 1;

    if coalesce(v_manager_count, 0) = 1 then
      update station_responsibility_assignments
      set effective_to = clock_timestamp(), is_primary = false, updated_at = clock_timestamp()
      where company_id = p_company_id
        and station_id = v_station_id
        and responsibility_role_id = any(v_manager_role_ids)
        and is_primary = true
        and effective_from <= clock_timestamp()
        and (effective_to is null or effective_to >= clock_timestamp())
        and assignment_id is distinct from v_manager_assignment_id;

      if not exists (
        select 1
        from station_responsibility_assignments
        where company_id = p_company_id
          and station_id = v_station_id
          and responsibility_role_id = any(v_manager_role_ids)
          and assignment_id = v_manager_assignment_id
          and is_primary = true
          and effective_from <= clock_timestamp()
          and (effective_to is null or effective_to >= clock_timestamp())
      ) then
        insert into station_responsibility_assignments (
          company_id, station_id, responsibility_role_id, responsibility_code,
          assignee_user_id, assignee_email, assignment_id, business_line,
          is_primary, effective_from
        ) values (
          p_company_id, v_station_id, v_role_id, 'station_manager',
          v_manager_user_id, v_manager_email, v_manager_assignment_id, 'other',
          true, clock_timestamp()
        );
      end if;

      -- Only replace direct operational-authority links. SSA -> TL and other
      -- local team relationships remain untouched.
      -- Recover the station's direct operational subjects from their current
      -- relationship, or from the most recent relationship when a preceding
      -- People edit temporarily cleared an ambiguous route. A newer live
      -- non-operational relationship (for example SSA -> TL) is never replaced.
      select array_agg(subject_assignment.id)
        into v_subject_assignment_ids
      from hr_work_assignments subject_assignment
      join lateral (
        select relationship.manager_assignment_id
        from hr_reporting_relationships relationship
        where relationship.company_id = p_company_id
          and relationship.subject_assignment_id = subject_assignment.id
          and relationship.relationship_type = 'solid_line'
        order by relationship.is_primary desc,
                 coalesce(relationship.effective_to, 'infinity'::date) desc,
                 relationship.effective_from desc,
                 relationship.created_at desc,
                 relationship.id desc
        limit 1
      ) latest_relationship on true
      join hr_work_assignments manager_assignment
        on manager_assignment.id = latest_relationship.manager_assignment_id
       and manager_assignment.company_id = p_company_id
      left join designations manager_designation
        on manager_designation.id = manager_assignment.designation_id
      where subject_assignment.company_id = p_company_id
        and subject_assignment.location_id = v_station_id
        and subject_assignment.is_primary = true
        and subject_assignment.effective_from <= current_date
        and (subject_assignment.effective_to is null or subject_assignment.effective_to >= current_date)
        and latest_relationship.manager_assignment_id is distinct from v_manager_assignment_id
        and (
          upper(coalesce(manager_designation.code, '')) in ('CLM', 'CM', 'AOM', 'RM', 'RH', 'ZH', 'BH', 'NH')
          or upper(coalesce(manager_designation.name, '')) like '%CLUSTER MANAGER%'
          or upper(coalesce(manager_designation.name, '')) like '%AREA OPERATION%MANAGER%'
          or upper(coalesce(manager_designation.name, '')) like '%BUSINESS HEAD%'
          or upper(coalesce(manager_designation.name, '')) like '%REGIONAL%HEAD%'
          or upper(coalesce(manager_designation.name, '')) like '%NATIONAL HEAD%'
        );

      if coalesce(cardinality(v_subject_assignment_ids), 0) > 0 then
        update hr_reporting_relationships
        set effective_to = greatest(effective_from, current_date - 1),
            is_primary = false,
            updated_at = clock_timestamp()
        where company_id = p_company_id
          and subject_assignment_id = any(v_subject_assignment_ids)
          and relationship_type = 'solid_line'
          and is_primary = true
          and effective_from <= current_date
          and (effective_to is null or effective_to >= current_date);

        insert into hr_reporting_relationships (
          company_id, subject_assignment_id, manager_assignment_id,
          relationship_type, is_primary, effective_from
        )
        select p_company_id, subject_assignment_id, v_manager_assignment_id,
               'solid_line', true, current_date
        from unnest(v_subject_assignment_ids) subject_assignment_id
        where subject_assignment_id <> v_manager_assignment_id;
      end if;
    else
      -- A removed or ambiguous mapping must never leave a former manager
      -- active. Do not guess between duplicate People owners; clear the stale
      -- route so the workflow exposes the configuration conflict/fallback.
      update station_responsibility_assignments
      set effective_to = clock_timestamp(), is_primary = false, updated_at = clock_timestamp()
      where company_id = p_company_id
        and station_id = v_station_id
        and responsibility_role_id = any(v_manager_role_ids)
        and is_primary = true
        and effective_from <= clock_timestamp()
        and (effective_to is null or effective_to >= clock_timestamp());

      select array_agg(relationship.subject_assignment_id)
        into v_subject_assignment_ids
      from hr_reporting_relationships relationship
      join hr_work_assignments subject_assignment
        on subject_assignment.id = relationship.subject_assignment_id
       and subject_assignment.company_id = p_company_id
       and subject_assignment.location_id = v_station_id
       and subject_assignment.is_primary = true
       and subject_assignment.effective_from <= current_date
       and (subject_assignment.effective_to is null or subject_assignment.effective_to >= current_date)
      join hr_work_assignments manager_assignment
        on manager_assignment.id = relationship.manager_assignment_id
       and manager_assignment.company_id = p_company_id
      left join designations manager_designation on manager_designation.id = manager_assignment.designation_id
      where relationship.company_id = p_company_id
        and relationship.relationship_type = 'solid_line'
        and relationship.is_primary = true
        and relationship.effective_from <= current_date
        and (relationship.effective_to is null or relationship.effective_to >= current_date)
        and (
          upper(coalesce(manager_designation.code, '')) in ('CLM', 'CM', 'AOM', 'RM', 'RH', 'ZH', 'BH', 'NH')
          or upper(coalesce(manager_designation.name, '')) like '%CLUSTER MANAGER%'
          or upper(coalesce(manager_designation.name, '')) like '%AREA OPERATION%MANAGER%'
          or upper(coalesce(manager_designation.name, '')) like '%BUSINESS HEAD%'
          or upper(coalesce(manager_designation.name, '')) like '%REGIONAL%HEAD%'
          or upper(coalesce(manager_designation.name, '')) like '%NATIONAL HEAD%'
        );

      if coalesce(cardinality(v_subject_assignment_ids), 0) > 0 then
        update hr_reporting_relationships
        set effective_to = greatest(effective_from, current_date - 1),
            is_primary = false,
            updated_at = clock_timestamp()
        where company_id = p_company_id
          and subject_assignment_id = any(v_subject_assignment_ids)
          and relationship_type = 'solid_line'
          and is_primary = true
          and effective_from <= current_date
          and (effective_to is null or effective_to >= current_date);
      end if;
    end if;
  end loop;
end;
$$;

create or replace function public.reconcile_people_operational_routing_for_person(
  p_company_id uuid,
  p_person_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_station_ids uuid[];
  v_has_all boolean;
begin
  if p_company_id is null or p_person_id is null then return; end if;

  select scope.location_scope_ids, scope.has_all_location_access
    into v_station_ids, v_has_all
  from people_person_access_scopes scope
  where scope.company_id = p_company_id
    and scope.person_id = p_person_id;

  if coalesce(v_has_all, false) then
    select coalesce(array_agg(id order by id), '{}'::uuid[])
      into v_station_ids
    from stations
    where company_id = p_company_id
      and is_active = true;
  end if;

  perform public.reconcile_people_operational_routing(
    p_company_id,
    coalesce(v_station_ids, '{}'::uuid[])
  );
end;
$$;

create or replace function public.sync_people_operational_routing_from_engagement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.reconcile_people_operational_routing_for_person(old.company_id, old.person_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.reconcile_people_operational_routing_for_person(new.company_id, new.person_id);
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_people_operational_routing_from_engagement on public.hr_engagements;
create trigger trg_sync_people_operational_routing_from_engagement
after insert or update of person_id, status, start_date, end_date or delete
on public.hr_engagements
for each row execute function public.sync_people_operational_routing_from_engagement();

create or replace function public.sync_people_operational_routing_from_assignment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_record record;
begin
  for v_record in
    select distinct engagement.company_id, engagement.person_id
    from hr_engagements engagement
    where engagement.id = any(array_remove(array[
      case when tg_op in ('UPDATE', 'DELETE') then old.engagement_id end,
      case when tg_op in ('INSERT', 'UPDATE') then new.engagement_id end
    ], null))
  loop
    perform public.reconcile_people_operational_routing_for_person(v_record.company_id, v_record.person_id);
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_people_operational_routing_from_assignment on public.hr_work_assignments;
create trigger trg_sync_people_operational_routing_from_assignment
after insert or update of engagement_id, designation_id, is_primary, effective_from, effective_to or delete
on public.hr_work_assignments
for each row execute function public.sync_people_operational_routing_from_assignment();

create or replace function public.sync_people_operational_routing_from_identity_link()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.reconcile_people_operational_routing_for_person(old.company_id, old.person_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.reconcile_people_operational_routing_for_person(new.company_id, new.person_id);
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_people_operational_routing_from_identity_link on public.hr_user_person_links;
create trigger trg_sync_people_operational_routing_from_identity_link
after insert or update of person_id, user_id, status or delete
on public.hr_user_person_links
for each row execute function public.sync_people_operational_routing_from_identity_link();

create or replace function public.sync_people_operational_routing_from_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_record record;
begin
  for v_record in
    select distinct link.company_id, link.person_id
    from hr_user_person_links link
    where link.user_id = any(array_remove(array[
      case when tg_op in ('UPDATE', 'DELETE') then old.id end,
      case when tg_op in ('INSERT', 'UPDATE') then new.id end
    ], null))
  loop
    perform public.reconcile_people_operational_routing_for_person(v_record.company_id, v_record.person_id);
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_people_operational_routing_from_profile on public.profiles;
create trigger trg_sync_people_operational_routing_from_profile
after insert or update of email, is_active or delete
on public.profiles
for each row execute function public.sync_people_operational_routing_from_profile();

create or replace function public.sync_people_operational_routing_from_designation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_station_ids uuid[];
begin
  v_company_id := case when tg_op = 'DELETE' then old.company_id else new.company_id end;
  select coalesce(array_agg(id order by id), '{}'::uuid[])
    into v_station_ids
  from stations
  where company_id = v_company_id
    and is_active = true;
  perform public.reconcile_people_operational_routing(v_company_id, v_station_ids);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_people_operational_routing_from_designation on public.designations;
create trigger trg_sync_people_operational_routing_from_designation
after insert or update of code, name, is_active or delete
on public.designations
for each row execute function public.sync_people_operational_routing_from_designation();

create or replace function public.sync_people_operational_routing_from_scope()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_station_ids uuid[];
begin
  if tg_op = 'DELETE' then
    v_company_id := old.company_id;
  else
    v_company_id := new.company_id;
  end if;

  if (tg_op in ('UPDATE', 'DELETE') and coalesce(old.has_all_location_access, false))
    or (tg_op in ('INSERT', 'UPDATE') and coalesce(new.has_all_location_access, false)) then
    select coalesce(array_agg(id order by id), '{}'::uuid[])
      into v_station_ids
    from stations
    where company_id = v_company_id
      and is_active = true;
  else
    select coalesce(array_agg(distinct station_id), '{}'::uuid[])
      into v_station_ids
    from unnest(case
      when tg_op = 'INSERT' then coalesce(new.location_scope_ids, '{}'::uuid[])
      when tg_op = 'DELETE' then coalesce(old.location_scope_ids, '{}'::uuid[])
      else coalesce(old.location_scope_ids, '{}'::uuid[]) || coalesce(new.location_scope_ids, '{}'::uuid[])
    end) station_id;
  end if;

  perform public.reconcile_people_operational_routing(v_company_id, v_station_ids);
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_people_operational_routing_from_scope on public.people_person_access_scopes;
create trigger trg_sync_people_operational_routing_from_scope
after insert or update of location_scope_ids, has_all_location_access
on public.people_person_access_scopes
for each row execute function public.sync_people_operational_routing_from_scope();

drop trigger if exists trg_delete_people_operational_routing_from_scope on public.people_person_access_scopes;
create trigger trg_delete_people_operational_routing_from_scope
after delete on public.people_person_access_scopes
for each row execute function public.sync_people_operational_routing_from_scope();

-- Repair cross-portal scope drift once. Subsequent People updates are handled
-- by the triggers above.
update profiles profile
set location_scope_ids = case
      when scope.has_all_location_access then '{}'::uuid[]
      else coalesce(scope.location_scope_ids, '{}'::uuid[])
    end,
    updated_at = clock_timestamp()
from hr_user_person_links link
join people_person_access_scopes scope
  on scope.company_id = link.company_id
 and scope.person_id = link.person_id
where link.status = 'active'
  and profile.company_id = link.company_id
  and profile.id = link.user_id
  and profile.location_scope_ids is distinct from case
    when scope.has_all_location_access then '{}'::uuid[]
    else coalesce(scope.location_scope_ids, '{}'::uuid[])
  end;

update company_product_memberships membership
set location_scope_ids = case
      when scope.has_all_location_access then '{}'::uuid[]
      else coalesce(scope.location_scope_ids, '{}'::uuid[])
    end,
    has_all_location_access = scope.has_all_location_access,
    updated_at = clock_timestamp()
from hr_user_person_links link
join people_person_access_scopes scope
  on scope.company_id = link.company_id
 and scope.person_id = link.person_id
where link.status = 'active'
  and membership.company_id = link.company_id
  and membership.user_id = link.user_id
  and membership.is_active = true
  and membership.source_system in ('designation_policy', 'google_workspace', 'person_override')
  and (
    membership.location_scope_ids is distinct from case
      when scope.has_all_location_access then '{}'::uuid[]
      else coalesce(scope.location_scope_ids, '{}'::uuid[])
    end
    or membership.has_all_location_access is distinct from scope.has_all_location_access
  );

-- Repair current operational owners and reporting routes once.
do $$
declare
  company record;
begin
  for company in
    select company_id, array_agg(id order by id) station_ids
    from stations
    where is_active = true
    group by company_id
  loop
    perform public.reconcile_people_operational_routing(company.company_id, company.station_ids);
  end loop;
end;
$$;

-- Finally mirror every current People reporting relationship into the legacy
-- profile field still consumed by Recruit and older notification paths.
do $$
declare
  relationship record;
begin
  for relationship in
    select distinct company_id, subject_assignment_id
    from hr_reporting_relationships
    where relationship_type = 'solid_line'
  loop
    perform public.reconcile_legacy_profile_reporting_manager(
      relationship.company_id,
      relationship.subject_assignment_id
    );
  end loop;
end;
$$;

commit;
