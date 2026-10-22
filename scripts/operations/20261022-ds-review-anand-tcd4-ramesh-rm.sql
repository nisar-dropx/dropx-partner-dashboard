-- Dark Store review desk: grant Anand Kuruvа OpsPulse scope on TCD4, and ensure
-- Regional Manager Ramesh sits above every City Manager for Amazon Now stores
-- with location scope covering those stores (so RM can review + skip-level).
-- Apply on the shared Supabase project after reviewing the notices.
begin;

do $$
declare
  company uuid := '43866344-b550-4e8a-9a2d-9d23f3d8a997';
  today date := (timezone('Asia/Kolkata', now()))::date;
  tcd4_id uuid;
  anand_person uuid;
  anand_user uuid;
  ramesh_person uuid;
  ramesh_user uuid;
  ramesh_assignment uuid;
  nh_assignment uuid;
  city_rec record;
  n int;
  now_ids uuid[];
begin
  select s.id into tcd4_id
  from public.stations s
  where s.company_id = company
    and upper(regexp_replace(s.station_code, '[^A-Za-z0-9]', '', 'g')) = 'TCD4'
  limit 1;
  if tcd4_id is null then
    raise exception 'TCD4 station not found for company %', company;
  end if;

  select p.id into anand_person
  from public.hr_people p
  where p.company_id = company
    and p.status = 'active'
    and upper(p.display_name) like '%ANAND%KURUV%'
  order by p.display_name
  limit 1;
  if anand_person is null then
    raise exception 'Active People record for Anand Kuruvа not found';
  end if;

  select l.user_id into anand_user
  from public.hr_user_person_links l
  join public.profiles pr on pr.id = l.user_id and pr.company_id = company and pr.is_active
  where l.company_id = company
    and l.person_id = anand_person
    and l.status = 'active'
  order by l.created_at
  limit 1;
  if anand_user is null then
    raise exception 'Anand Kuruvа has no active OpsPulse user link';
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
    and coalesce(s.is_active, true)
    and (
      upper(coalesce(m.code, '')) in ('NOW', 'AMAZON NOW')
      or upper(coalesce(m.name, '')) like '%AMAZON NOW%'
      or (upper(coalesce(pr.name, pr.code, '')) like '%AMAZON%' and upper(coalesce(m.code, '')) = 'NOW')
    );
  if now_ids is null or cardinality(now_ids) = 0 then
    raise exception 'No Amazon Now / Dark Store stations found';
  end if;

  -- 1) Anand gets TCD4 on every active operations membership (selected-scope).
  update public.company_product_memberships m
  set location_scope_ids = (
        select array_agg(distinct x order by x)
        from unnest(coalesce(m.location_scope_ids, '{}'::uuid[]) || array[tcd4_id]) as x
      ),
      updated_at = now()
  where m.company_id = company
    and m.user_id = anand_user
    and m.product_code = 'operations'
    and m.is_active
    and m.has_all_location_access is not true
    and not (tcd4_id = any(coalesce(m.location_scope_ids, '{}'::uuid[])));
  get diagnostics n = row_count;
  raise notice 'Anand Kuruv memberships granted TCD4: %', n;

  -- 2) Ramesh gets every Dark Store station in operations scope.
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
  raise notice 'Ramesh memberships granted all NOW stations: % (station count %)', n, cardinality(now_ids);

  -- 3) Point every active Dark Store City Manager solid-line manager at Ramesh (RM).
  --    Keep existing City→RM edges that already point at Ramesh; retarget others.
  for city_rec in
    select a.id as assignment_id, p.display_name
    from public.hr_work_assignments a
    join public.hr_engagements e on e.id = a.engagement_id and e.company_id = company
    join public.hr_people p on p.id = e.person_id and p.company_id = company
    join public.designations d on d.id = a.designation_id
    where a.company_id = company
      and a.is_primary
      and a.effective_from <= today and (a.effective_to is null or a.effective_to >= today)
      and e.status = 'active'
      and e.start_date <= today and (e.end_date is null or e.end_date >= today)
      and p.status = 'active'
      and upper(regexp_replace(concat_ws(' ', d.code, d.name), '[^A-Za-z0-9]+', ' ', 'g'))
        ~ '(^| )(CITY MANAGER|CITY HEAD|CTM)( |$)'
      and (
        a.location_id = any(now_ids)
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
              or m.location_scope_ids && now_ids
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
    get diagnostics n = row_count;
    if n > 0 then
      raise notice 'Retargeted City Manager % → Ramesh RM', city_rec.display_name;
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
      raise notice 'Created City Manager % → Ramesh RM', city_rec.display_name;
    end if;
  end loop;

  -- 4) Keep Ramesh under National Head when a solid-line manager is missing.
  select a.id into nh_assignment
  from public.hr_work_assignments a
  join public.hr_engagements e on e.id = a.engagement_id and e.company_id = company
  join public.designations d on d.id = a.designation_id
  where a.company_id = company
    and a.is_primary
    and a.effective_from <= today and (a.effective_to is null or a.effective_to >= today)
    and e.status = 'active'
    and e.start_date <= today and (e.end_date is null or e.end_date >= today)
    and upper(regexp_replace(concat_ws(' ', d.code, d.name), '[^A-Za-z0-9]+', ' ', 'g'))
      ~ '(^| )(NH|NATIONAL HEAD)( |$)'
  order by a.effective_from desc
  limit 1;

  if nh_assignment is not null
     and not exists (
       select 1
       from public.hr_reporting_relationships r
       where r.company_id = company
         and r.subject_assignment_id = ramesh_assignment
         and r.is_primary
         and r.relationship_type = 'solid_line'
         and r.effective_from <= today
         and (r.effective_to is null or r.effective_to >= today)
     )
  then
    insert into public.hr_reporting_relationships (
      company_id, subject_assignment_id, manager_assignment_id,
      relationship_type, is_primary, effective_from, created_at, updated_at
    ) values (
      company, ramesh_assignment, nh_assignment,
      'solid_line', true, today, now(), now()
    );
    raise notice 'Created Ramesh RM → National Head reporting line';
  end if;

  raise notice 'Done. Anand person=% user=%; Ramesh person=% user=% assignment=%; TCD4=%; NOW stations=%',
    anand_person, anand_user, ramesh_person, ramesh_user, ramesh_assignment, tcd4_id, cardinality(now_ids);
end $$;

commit;
