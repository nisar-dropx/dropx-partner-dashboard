-- When no unique CLM/AOM owns a station's managed locations:
-- - still clear a stale synced CLM/AOM Ops POC (former manager lost scope)
-- - preserve a manual non-CLM/AOM POC (e.g. HLM on HO_KL), which was getting
--   wiped on every People scope save because preferred count is 0
--
-- Ambiguous CLM/AOM (tier_count > 1) still clears the route so workflows expose
-- the conflict. Unique CLM/AOM still replaces the POC as before.

begin;

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
          when upper(coalesce(designation.code, '')) in ('CLM')
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

      -- Station-floor operational routes only (CLM / City Manager / AOM).
      -- Never remap people who already report into the company org chart
      -- (RM / BH / NH / ZH / RH, Store Manager chains owned by People Tree).
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
          upper(coalesce(manager_designation.code, '')) in ('CLM', 'CM', 'CTM', 'AOM')
          or upper(coalesce(manager_designation.name, '')) like '%CLUSTER MANAGER%'
          or upper(coalesce(manager_designation.name, '')) like '%CLUSTER HEAD%'
          or upper(coalesce(manager_designation.name, '')) like '%CITY MANAGER%'
          or upper(coalesce(manager_designation.name, '')) like '%AREA OPERATION%MANAGER%'
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
    elsif coalesce(v_manager_count, 0) > 1 then
      -- Ambiguous CLM/AOM: clear Ops station POC so workflows expose the
      -- conflict. Do not touch People reporting relationships.
      update station_responsibility_assignments
      set effective_to = clock_timestamp(), is_primary = false, updated_at = clock_timestamp()
      where company_id = p_company_id
        and station_id = v_station_id
        and responsibility_role_id = any(v_manager_role_ids)
        and is_primary = true
        and effective_from <= clock_timestamp()
        and (effective_to is null or effective_to >= clock_timestamp());
    else
      -- No preferred CLM/AOM: clear only stale synced CLM/AOM owners. Leave
      -- manual Head Ops / HO (and other non-CLM/AOM) POCs alone.
      update station_responsibility_assignments sra
      set effective_to = clock_timestamp(), is_primary = false, updated_at = clock_timestamp()
      from hr_work_assignments wa
      left join designations designation on designation.id = wa.designation_id
      where sra.company_id = p_company_id
        and sra.station_id = v_station_id
        and sra.responsibility_role_id = any(v_manager_role_ids)
        and sra.is_primary = true
        and sra.effective_from <= clock_timestamp()
        and (sra.effective_to is null or sra.effective_to >= clock_timestamp())
        and wa.id = sra.assignment_id
        and wa.company_id = p_company_id
        and (
          upper(coalesce(designation.code, '')) in ('CLM', 'AOM')
          or upper(coalesce(designation.name, '')) like '%CLUSTER MANAGER%'
          or upper(coalesce(designation.name, '')) like '%CLUSTER HEAD%'
          or upper(coalesce(designation.name, '')) like '%AREA OPERATIONS MANAGER%'
          or upper(coalesce(designation.name, '')) like '%AREA OPERATION MANAGER%'
        );
    end if;
  end loop;
end;
$$;

notify pgrst, 'reload schema';
commit;
