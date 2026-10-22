-- Align Activities & Handover store scope with People posting for SI / Store Manager.
-- Stale NOW scopes are replaced by the posted store (no keep-stale union).
-- Explicit moves:
--   DF1094 Goshika Vamshi Vardhan → TTA5
--   H1041  J Shashank             → TTB3 (HR already moved; Ops still had TTG9)
-- Ongoing sync: apply migration 20261022220000_sync_ops_scope_from_people_posting.sql
-- so future People location changes update OpsPulse automatically.
-- Apply on the shared Supabase project after reviewing the notices.
begin;

do $$
declare
  company uuid := '43866344-b550-4e8a-9a2d-9d23f3d8a997';
  today date := (timezone('Asia/Kolkata', now()))::date;
  now_model_ids uuid[];
  now_station_ids uuid[];
  n int;
  rec record;
  fix record;
  target_station_id uuid;
  target_person_id uuid;
  target_user_id uuid;
  target_assignment_id uuid;
  posted uuid[];
  non_now uuid[];
  next_scope uuid[];
begin
  select coalesce(array_agg(m.id), '{}'::uuid[])
  into now_model_ids
  from public.location_models m
  where m.company_id = company
    and (
      upper(coalesce(m.code, '')) in ('NOW', 'AMAZON NOW')
      or upper(coalesce(m.name, '')) like '%AMAZON NOW%'
    );
  if cardinality(now_model_ids) = 0 then
    raise exception 'No NOW location models found';
  end if;

  select coalesce(array_agg(s.id order by s.station_code), '{}'::uuid[])
  into now_station_ids
  from public.stations s
  where s.company_id = company
    and coalesce(s.is_active, true)
    and s.location_model_id = any(now_model_ids);

  -- 1) Explicit People + OpsPulse NOW store moves.
  for fix in
    select * from (values
      ('DF1094', 'TTA5', '%GOSHIKA%VAMSHI%', '%VAMSHI%VARDHAN%'),
      ('H1041',  'TTB3', '%JSHASHANK%',      '%J%SHASHANK%')
    ) as t(emp_code, station_code, name_pat_a, name_pat_b)
  loop
    select s.id into target_station_id
    from public.stations s
    where s.company_id = company
      and upper(regexp_replace(s.station_code, '[^A-Za-z0-9]', '', 'g'))
        = upper(regexp_replace(fix.station_code, '[^A-Za-z0-9]', '', 'g'))
    limit 1;
    if target_station_id is null then
      raise exception 'Station % not found', fix.station_code;
    end if;

    target_person_id := null;
    target_user_id := null;
    select p.id, l.user_id
    into target_person_id, target_user_id
    from public.hr_people p
    join public.hr_user_person_links l
      on l.person_id = p.id and l.company_id = company and l.status = 'active'
    join public.profiles pr
      on pr.id = l.user_id and pr.company_id = company and pr.is_active
    where p.company_id = company
      and p.status = 'active'
      and (
        upper(regexp_replace(coalesce(pr.employee_id, ''), '[^A-Za-z0-9]', '', 'g'))
          = upper(regexp_replace(fix.emp_code, '[^A-Za-z0-9]', '', 'g'))
        or upper(regexp_replace(coalesce(p.display_name, ''), '[^A-Za-z0-9]', '', 'g'))
          like upper(regexp_replace(fix.name_pat_a, '[^A-Za-z0-9%]', '', 'g'))
        or upper(regexp_replace(coalesce(p.display_name, ''), '[^A-Za-z0-9]', '', 'g'))
          like upper(regexp_replace(fix.name_pat_b, '[^A-Za-z0-9%]', '', 'g'))
      )
    order by
      case
        when upper(regexp_replace(coalesce(pr.employee_id, ''), '[^A-Za-z0-9]', '', 'g'))
          = upper(regexp_replace(fix.emp_code, '[^A-Za-z0-9]', '', 'g'))
        then 0 else 1
      end,
      p.display_name
    limit 1;

    if target_person_id is null then
      raise exception '% / name match not found in People + OpsPulse link', fix.emp_code;
    end if;

    select a.id into target_assignment_id
    from public.hr_engagements e
    join public.hr_work_assignments a
      on a.engagement_id = e.id and a.company_id = company and a.is_primary
     and a.effective_from <= today and (a.effective_to is null or a.effective_to >= today)
    where e.company_id = company
      and e.person_id = target_person_id
      and e.status = 'active'
      and e.start_date <= today and (e.end_date is null or e.end_date >= today)
    order by a.effective_from desc
    limit 1;

    if target_assignment_id is null then
      raise exception 'No active primary work assignment for % (person %)', fix.emp_code, target_person_id;
    end if;

    update public.hr_work_assignments a
    set location_id = target_station_id
    where a.id = target_assignment_id
      and a.location_id is distinct from target_station_id;
    get diagnostics n = row_count;
    raise notice '% People posting → % (rows=%); person=% user=%',
      fix.emp_code, fix.station_code, n, target_person_id, target_user_id;

    update public.company_product_memberships m
    set
      location_scope_ids = (
        select array_agg(distinct x order by x)
        from (
          select x from unnest(coalesce(m.location_scope_ids, '{}'::uuid[])) x
          where not (x = any(now_station_ids))
          union
          select target_station_id
        ) q
      ),
      updated_at = now()
    where m.company_id = company
      and m.user_id = target_user_id
      and m.product_code = 'operations'
      and m.is_active
      and m.has_all_location_access is not true;
    get diagnostics n = row_count;
    raise notice '% OpsPulse memberships → % only: %', fix.emp_code, fix.station_code, n;
  end loop;

  -- 2) All SI / Store Manager: NOW OpsPulse scope = People posted NOW store(s) only.
  -- Prefer the shared function when the sync migration is already applied.
  if to_regprocedure('public.sync_ops_si_sm_scope_for_person(uuid, uuid)') is not null then
    for rec in
      select distinct e.person_id as pid
      from public.hr_user_person_links l
      join public.hr_engagements e
        on e.person_id = l.person_id and e.company_id = company and e.status = 'active'
      join public.company_product_memberships m
        on m.company_id = company and m.user_id = l.user_id
       and m.product_code = 'operations' and m.is_active
       and m.has_all_location_access is not true
      left join public.user_roles ur on ur.id = m.role_id
      where l.company_id = company and l.status = 'active'
        and (
          ur.code in ('OPERATIONS_SIC', 'SIC', 'SI', 'SHIFT_INCHARGE', 'OPERATIONS_SM', 'OPERATIONS_SRSM')
          or upper(regexp_replace(concat_ws(' ', ur.code, ur.name), '[^A-Za-z0-9]+', ' ', 'g'))
            ~ '(^| )(SHIFT INCHARGE|SHIFT IN CHARGE|SIC|STORE MANAGER|SENIOR STORE MANAGER|SRSM)( |$)'
        )
        and not (
          ur.code in (
            'OPERATIONS_CTM', 'OPERATIONS_CM', 'OPERATIONS_RM', 'OPERATIONS_REGIONAL_HEAD',
            'OPERATIONS_NH', 'OPERATIONS_NATIONAL_HEAD', 'OPERATIONS_PGM', 'OPERATIONS_PROGRAM_HEAD',
            'REGIONAL_HEAD', 'NATIONAL_HEAD', 'PROGRAM_HEAD'
          )
          or upper(regexp_replace(concat_ws(' ', ur.code, ur.name), '[^A-Za-z0-9]+', ' ', 'g'))
            ~ '(^| )(CITY MANAGER|CITY HEAD|CTM|RM|REGIONAL MANAGER|REGIONAL HEAD|NH|NATIONAL HEAD|PROGRAM MANAGER|PROGRAM HEAD)( |$)'
        )
    loop
      perform public.sync_ops_si_sm_scope_for_person(company, rec.pid);
    end loop;
    raise notice 'Bulk SI/SM align via sync_ops_si_sm_scope_for_person complete.';
  else
    for rec in
      select
        m.id as membership_id,
        m.user_id as membership_user_id,
        m.location_scope_ids,
        coalesce(pr.full_name, pr.email, m.user_id::text) as user_label,
        coalesce(pr.employee_id, '') as emp
      from public.company_product_memberships m
      join public.profiles pr
        on pr.id = m.user_id and pr.company_id = company and pr.is_active
      left join public.user_roles ur
        on ur.id = m.role_id and ur.company_id = company
      where m.company_id = company
        and m.product_code = 'operations'
        and m.is_active
        and m.has_all_location_access is not true
        and (
          ur.code in ('OPERATIONS_SIC', 'SIC', 'SI', 'SHIFT_INCHARGE', 'OPERATIONS_SM', 'OPERATIONS_SRSM')
          or upper(regexp_replace(concat_ws(' ', ur.code, ur.name), '[^A-Za-z0-9]+', ' ', 'g'))
            ~ '(^| )(SHIFT INCHARGE|SHIFT IN CHARGE|SIC|STORE MANAGER|SENIOR STORE MANAGER|SRSM)( |$)'
        )
        and not (
          ur.code in (
            'OPERATIONS_CTM', 'OPERATIONS_CM', 'OPERATIONS_RM', 'OPERATIONS_REGIONAL_HEAD',
            'OPERATIONS_NH', 'OPERATIONS_NATIONAL_HEAD', 'OPERATIONS_PGM', 'OPERATIONS_PROGRAM_HEAD',
            'REGIONAL_HEAD', 'NATIONAL_HEAD', 'PROGRAM_HEAD'
          )
          or upper(regexp_replace(concat_ws(' ', ur.code, ur.name), '[^A-Za-z0-9]+', ' ', 'g'))
            ~ '(^| )(CITY MANAGER|CITY HEAD|CTM|RM|REGIONAL MANAGER|REGIONAL HEAD|NH|NATIONAL HEAD|PROGRAM MANAGER|PROGRAM HEAD)( |$)'
        )
    loop
      select coalesce(array_agg(distinct a.location_id), '{}'::uuid[])
      into posted
      from public.hr_user_person_links l
      join public.hr_engagements e
        on e.person_id = l.person_id and e.company_id = company and e.status = 'active'
       and e.start_date <= today and (e.end_date is null or e.end_date >= today)
      join public.hr_work_assignments a
        on a.engagement_id = e.id and a.company_id = company and a.is_primary
       and a.effective_from <= today and (a.effective_to is null or a.effective_to >= today)
       and a.location_id = any(now_station_ids)
      where l.company_id = company
        and l.user_id = rec.membership_user_id
        and l.status = 'active';

      if posted is null or cardinality(posted) = 0 then
        continue;
      end if;

      select coalesce(array_agg(distinct x), '{}'::uuid[])
      into non_now
      from unnest(coalesce(rec.location_scope_ids, '{}'::uuid[])) x
      where not (x = any(now_station_ids));

      next_scope := (
        select array_agg(distinct x order by x)
        from unnest(coalesce(non_now, '{}'::uuid[]) || posted) as x
      );

      update public.company_product_memberships m
      set location_scope_ids = next_scope,
          updated_at = now()
      where m.id = rec.membership_id
        and m.location_scope_ids is distinct from next_scope;
      get diagnostics n = row_count;
      if n > 0 then
        raise notice 'Aligned SI/SM % (%) NOW scope → posted store(s)', rec.user_label, nullif(rec.emp, '');
      end if;
    end loop;
  end if;

  -- 3) Diagnostic: list SI/SM whose OpsPulse NOW scope still differs from People posting.
  for rec in
    select
      coalesce(pr.full_name, pr.email) as user_label,
      coalesce(pr.employee_id, '') as emp,
      (
        select string_agg(s.station_code, ',' order by s.station_code)
        from unnest(m.location_scope_ids) sid
        join public.stations s on s.id = sid
        where s.location_model_id = any(now_model_ids)
      ) as ops_now,
      (
        select string_agg(s.station_code, ',' order by s.station_code)
        from public.hr_user_person_links l
        join public.hr_engagements e
          on e.person_id = l.person_id and e.company_id = company and e.status = 'active'
         and e.start_date <= today and (e.end_date is null or e.end_date >= today)
        join public.hr_work_assignments a
          on a.engagement_id = e.id and a.company_id = company and a.is_primary
         and a.effective_from <= today and (a.effective_to is null or a.effective_to >= today)
        join public.stations s on s.id = a.location_id and s.location_model_id = any(now_model_ids)
        where l.company_id = company and l.user_id = m.user_id and l.status = 'active'
      ) as people_now
    from public.company_product_memberships m
    join public.profiles pr on pr.id = m.user_id and pr.company_id = company and pr.is_active
    left join public.user_roles ur on ur.id = m.role_id
    where m.company_id = company
      and m.product_code = 'operations'
      and m.is_active
      and m.has_all_location_access is not true
      and (
        ur.code in ('OPERATIONS_SIC', 'SIC', 'SI', 'SHIFT_INCHARGE', 'OPERATIONS_SM', 'OPERATIONS_SRSM')
        or upper(regexp_replace(concat_ws(' ', ur.code, ur.name), '[^A-Za-z0-9]+', ' ', 'g'))
          ~ '(^| )(SHIFT INCHARGE|SHIFT IN CHARGE|SIC|STORE MANAGER|SENIOR STORE MANAGER|SRSM)( |$)'
      )
  loop
    if coalesce(rec.ops_now, '') is distinct from coalesce(rec.people_now, '') then
      raise notice 'Still mismatched after align: % (%) Ops=% People=%',
        rec.user_label, rec.emp, coalesce(rec.ops_now, '—'), coalesce(rec.people_now, '—');
    end if;
  end loop;

  raise notice 'SI/SM posted-store alignment complete.';
end $$;

commit;
