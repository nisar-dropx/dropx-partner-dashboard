-- Dark Store review: map TZC4 under Regional Manager Ramesh (store had no RM),
-- and keep Ramesh scoped to all Amazon Now stations. DS review UI/route stops at
-- City → RM (National Head / Abdul is not a review stage).
-- Apply on the shared Supabase project after reviewing the notices.
begin;

do $$
declare
  company uuid := '43866344-b550-4e8a-9a2d-9d23f3d8a997';
  today date := (timezone('Asia/Kolkata', now()))::date;
  tzc4_id uuid;
  ramesh_person uuid;
  ramesh_user uuid;
  ramesh_assignment uuid;
  city_rec record;
  n int;
  now_ids uuid[];
begin
  select s.id into tzc4_id
  from public.stations s
  where s.company_id = company
    and upper(regexp_replace(s.station_code, '[^A-Za-z0-9]', '', 'g')) = 'TZC4'
  limit 1;
  if tzc4_id is null then
    raise exception 'TZC4 station not found for company %', company;
  end if;

  select p.id into ramesh_person
  from public.hr_people p
  join public.hr_engagements e
    on e.person_id = p.id and e.company_id = company and e.status = 'active'
   and e.start_date <= today and (e.end_date is null or e.end_date >= today)
  join public.hr_work_assignments a
    on a.engagement_id = e.id and a.company_id = company and a.is_primary
   and a.effective_from <= today and (a.effective_to is null or a.effective_to >= today)
  join public.designations d on d.id = a.designation_id and d.company_id = company
  where p.company_id = company
    and p.status = 'active'
    and upper(p.display_name) like 'RAMESH%'
    and upper(regexp_replace(concat_ws(' ', d.code, d.name), '[^A-Za-z0-9]+', ' ', 'g'))
      ~ '(^| )(RM|REGIONAL MANAGER|REGIONAL HEAD)( |$)'
  order by p.display_name
  limit 1;
  if ramesh_person is null then
    raise exception 'Active Regional Manager People record for Ramesh not found';
  end if;

  select l.user_id into ramesh_user
  from public.hr_user_person_links l
  join public.profiles pr on pr.id = l.user_id and pr.company_id = company and pr.is_active
  where l.company_id = company
    and l.person_id = ramesh_person
    and l.status = 'active'
  order by l.created_at
  limit 1;
  if ramesh_user is null then
    raise exception 'Ramesh has no active OpsPulse user link';
  end if;

  select a.id into ramesh_assignment
  from public.hr_engagements e
  join public.hr_work_assignments a
    on a.engagement_id = e.id and a.company_id = company and a.is_primary
   and a.effective_from <= today and (a.effective_to is null or a.effective_to >= today)
  join public.designations d on d.id = a.designation_id
  where e.company_id = company
    and e.person_id = ramesh_person
    and e.status = 'active'
    and e.start_date <= today and (e.end_date is null or e.end_date >= today)
    and upper(regexp_replace(concat_ws(' ', d.code, d.name), '[^A-Za-z0-9]+', ' ', 'g'))
      ~ '(^| )(RM|REGIONAL MANAGER|REGIONAL HEAD)( |$)'
  order by a.effective_from desc
  limit 1;
  if ramesh_assignment is null then
    raise exception 'Ramesh has no active Regional Manager work assignment';
  end if;

  select array_agg(s.id order by s.station_code)
  into now_ids
  from public.stations s
  left join public.location_models m on m.id = s.location_model_id
  left join public.providers pr on pr.id = s.provider_id
  where s.company_id = company
    and s.is_active
    and coalesce(s.hide_from_location_list, false) is not true
    and coalesce(s.is_ho, false) is not true
    and (
      upper(coalesce(m.code, '')) in ('NOW', 'AMAZON NOW')
      or upper(coalesce(m.name, '')) like '%AMAZON NOW%'
      or (upper(coalesce(pr.name, pr.code, '')) like '%AMAZON%' and upper(coalesce(m.code, '')) = 'NOW')
      or upper(regexp_replace(s.station_code, '[^A-Za-z0-9]', '', 'g')) = 'TZC4'
    );

  if now_ids is null or cardinality(now_ids) = 0 then
    raise exception 'No Amazon Now / TZC4 stations found to scope for Ramesh';
  end if;

  -- 1) Ramesh OpsPulse scope covers every NOW store including TZC4.
  update public.company_product_memberships m
  set location_scope_ids = (
        select array_agg(distinct x order by x)
        from unnest(coalesce(m.location_scope_ids, '{}'::uuid[]) || now_ids) as x
      ),
      updated_at = now()
  where m.company_id = company
    and m.user_id = ramesh_user
    and m.product_code = 'operations'
    and m.is_active
    and m.has_all_location_access is not true;
  get diagnostics n = row_count;
  raise notice 'Ramesh memberships granted NOW+TZC4 stations: % (station count %)', n, cardinality(now_ids);

  -- 2) Point City Managers who cover TZC4 (or any NOW store still missing RM) at Ramesh.
  for city_rec in
    select distinct
      p.display_name,
      a.id as assignment_id
    from public.hr_work_assignments a
    join public.hr_engagements e
      on e.id = a.engagement_id and e.company_id = company and e.status = 'active'
     and e.start_date <= today and (e.end_date is null or e.end_date >= today)
    join public.hr_people p on p.id = e.person_id and p.company_id = company and p.status = 'active'
    join public.designations d on d.id = a.designation_id and d.company_id = company
    where a.company_id = company
      and a.is_primary
      and a.effective_from <= today and (a.effective_to is null or a.effective_to >= today)
      and upper(regexp_replace(concat_ws(' ', d.code, d.name), '[^A-Za-z0-9]+', ' ', 'g'))
        ~ '(^| )(CITY MANAGER|CITY HEAD|CTM)( |$)'
      and (
        a.location_id = tzc4_id
        or exists (
          select 1
          from public.hr_user_person_links l
          join public.company_product_memberships m
            on m.user_id = l.user_id
           and m.company_id = company
           and m.product_code = 'operations'
           and m.is_active
          where l.company_id = company
            and l.person_id = p.id
            and l.status = 'active'
            and (
              m.has_all_location_access
              or tzc4_id = any(coalesce(m.location_scope_ids, '{}'::uuid[]))
            )
        )
      )
  loop
    update public.hr_reporting_relationships r
    set manager_assignment_id = ramesh_assignment,
        updated_at = now()
    where r.company_id = company
      and r.subject_assignment_id = city_rec.assignment_id
      and r.is_primary
      and r.relationship_type = 'solid_line'
      and r.effective_from <= today
      and (r.effective_to is null or r.effective_to >= today)
      and r.manager_assignment_id is distinct from ramesh_assignment;
    if found then
      raise notice 'Retargeted City Manager % → Ramesh RM (TZC4/NOW)', city_rec.display_name;
    elsif not exists (
      select 1
      from public.hr_reporting_relationships r
      where r.company_id = company
        and r.subject_assignment_id = city_rec.assignment_id
        and r.is_primary
        and r.relationship_type = 'solid_line'
        and r.effective_from <= today
        and (r.effective_to is null or r.effective_to >= today)
    ) then
      insert into public.hr_reporting_relationships (
        company_id, subject_assignment_id, manager_assignment_id,
        relationship_type, is_primary, effective_from, created_at, updated_at
      ) values (
        company, city_rec.assignment_id, ramesh_assignment,
        'solid_line', true, today, now(), now()
      );
      raise notice 'Created City Manager % → Ramesh RM (TZC4/NOW)', city_rec.display_name;
    end if;
  end loop;

  raise notice 'Done. TZC4=%; Ramesh person=% user=% assignment=%; NOW stations=%',
    tzc4_id, ramesh_person, ramesh_user, ramesh_assignment, cardinality(now_ids);
end $$;

commit;
