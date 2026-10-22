-- Activities & Handover: grant page + Dark Store (NOW) location scope so SI / SM /
-- City / RM / NH see stores instead of "No stores in scope".
-- Also seeds master modelIds = NOW and re-applies role page permissions.
-- Apply on the shared Supabase project after reviewing the notices.
begin;

do $$
declare
  company uuid := '43866344-b550-4e8a-9a2d-9d23f3d8a997';
  today date := (timezone('Asia/Kolkata', now()))::date;
  now_model_ids uuid[];
  now_station_ids uuid[];
  n int;
  handover_page_id uuid;
  rec record;
  store_ids uuid[];
  role_text text;
begin
  select coalesce(array_agg(m.id order by m.code), '{}'::uuid[])
  into now_model_ids
  from public.location_models m
  where m.company_id = company
    and (
      upper(coalesce(m.code, '')) in ('NOW', 'AMAZON NOW')
      or upper(coalesce(m.name, '')) like '%AMAZON NOW%'
    );
  if cardinality(now_model_ids) = 0 then
    raise exception 'No NOW location models found for company %', company;
  end if;

  select coalesce(array_agg(s.id order by s.station_code), '{}'::uuid[])
  into now_station_ids
  from public.stations s
  where s.company_id = company
    and coalesce(s.is_active, true)
    and coalesce(s.hide_from_location_list, false) = false
    and coalesce(s.is_ho, false) = false
    and s.location_model_id = any(now_model_ids);
  if cardinality(now_station_ids) = 0 then
    raise exception 'No active NOW / Dark Store stations found';
  end if;
  raise notice 'NOW models=% stations=%', cardinality(now_model_ids), cardinality(now_station_ids);

  -- 1) Master catalogue: ensure NOW models are in scope.
  update public.ops_si_handover_master m
  set
    settings = jsonb_set(
      coalesce(m.settings, '{}'::jsonb),
      '{modelIds}',
      coalesce(
        (
          select jsonb_agg(x order by x)
          from (
            select distinct unnest(
              coalesce(
                (
                  select array_agg(t::uuid)
                  from jsonb_array_elements_text(coalesce(m.settings->'modelIds', '[]'::jsonb)) t
                ),
                '{}'::uuid[]
              ) || now_model_ids
            ) as x
          ) q
        ),
        to_jsonb(now_model_ids)
      )
    ),
    updated_at = now()
  where m.company_id = company;
  get diagnostics n = row_count;
  raise notice 'Master rows with NOW modelIds seeded/merged: %', n;

  -- 2) Page permissions for SI (write) and managers above (view+edit).
  insert into public.app_pages (company_id, code, name, sort_order, is_active)
  select company, p.code, p.name, p.sort_order, true
  from (values
    ('si_handover', 'Activities and Handover', 93),
    ('si_handover_master', 'Activities and Handover Master', 94)
  ) as p(code, name, sort_order)
  on conflict (company_id, code) do update
  set name = excluded.name, sort_order = excluded.sort_order, is_active = true, updated_at = now();

  select id into handover_page_id
  from public.app_pages
  where company_id = company and code = 'si_handover' and is_active
  limit 1;
  if handover_page_id is null then
    raise exception 'si_handover app_pages row missing for company %', company;
  end if;

  insert into public.role_page_permissions (company_id, role_id, page_id, can_view, can_add, can_edit)
  select r.company_id, r.id, handover_page_id, true, true, true
  from public.user_roles r
  where r.company_id = company
    and r.is_active
    and (
      r.code in ('OPERATIONS_SIC', 'SIC', 'SI', 'SHIFT_INCHARGE')
      or upper(regexp_replace(concat_ws(' ', r.code, r.name), '[^A-Za-z0-9]+', ' ', 'g'))
        ~ '(^| )(SHIFT INCHARGE|SHIFT IN CHARGE|SIC)( |$)'
    )
  on conflict (company_id, role_id, page_id) do update
  set can_view = true, can_add = true, can_edit = true, updated_at = now();

  insert into public.role_page_permissions (company_id, role_id, page_id, can_view, can_add, can_edit)
  select r.company_id, r.id, handover_page_id, true, false, true
  from public.user_roles r
  where r.company_id = company
    and r.is_active
    and (
      r.code in (
        'OPERATIONS_SM', 'OPERATIONS_SRSM', 'OPERATIONS_STM',
        'OPERATIONS_CTM', 'OPERATIONS_CM', 'OPERATIONS_CLM', 'OPERATIONS_CLUSTER_HEAD',
        'OPERATIONS_AOM',
        'OPERATIONS_RM', 'OPERATIONS_REGIONAL_HEAD',
        'OPERATIONS_NH', 'OPERATIONS_NATIONAL_HEAD',
        'OPERATIONS_PGM', 'OPERATIONS_PROGRAM_HEAD',
        'OPERATIONS_BH', 'OPERATIONS_HLM', 'OPERATIONS_MANAGING_PARTNER',
        'PROGRAM_HEAD', 'CLUSTER_HEAD', 'REGIONAL_HEAD', 'NATIONAL_HEAD'
      )
      or upper(regexp_replace(concat_ws(' ', r.code, r.name), '[^A-Za-z0-9]+', ' ', 'g'))
        ~ '(^| )(STORE MANAGER|SENIOR STORE MANAGER|SRSM|CITY MANAGER|CTM|CLUSTER MANAGER|CLUSTER HEAD|AREA OPERATIONS MANAGER|AREA MANAGER|AOM|REGIONAL MANAGER|REGIONAL HEAD|NATIONAL HEAD|PROGRAM MANAGER|PROGRAM HEAD)( |$)'
    )
    and not (
      r.code in ('OPERATIONS_SIC', 'SIC', 'SI', 'SHIFT_INCHARGE')
      or upper(regexp_replace(concat_ws(' ', r.code, r.name), '[^A-Za-z0-9]+', ' ', 'g'))
        ~ '(^| )(SHIFT INCHARGE|SHIFT IN CHARGE|SIC)( |$)'
    )
  on conflict (company_id, role_id, page_id) do update
  set
    can_view = true,
    can_edit = true,
    can_add = public.role_page_permissions.can_add,
    updated_at = now();

  -- 3) Location scope: SI/SM get posted NOW store; City get NOW stores they touch;
  --    RM / NH / Program get all NOW stores.
  for rec in
    select
      m.id as membership_id,
      m.user_id,
      m.location_scope_ids,
      m.has_all_location_access,
      coalesce(pr.full_name, pr.email, m.user_id::text) as user_label,
      upper(regexp_replace(concat_ws(' ', ur.code, ur.name, d.code, d.name), '[^A-Za-z0-9]+', ' ', 'g')) as role_hay
    from public.company_product_memberships m
    join public.profiles pr
      on pr.id = m.user_id and pr.company_id = company and pr.is_active
    left join public.user_roles ur
      on ur.id = m.role_id and ur.company_id = company
    left join public.hr_user_person_links l
      on l.company_id = company and l.user_id = m.user_id and l.status = 'active'
    left join lateral (
      select a.designation_id
      from public.hr_engagements e
      join public.hr_work_assignments a
        on a.engagement_id = e.id and a.company_id = company and a.is_primary
       and a.effective_from <= today and (a.effective_to is null or a.effective_to >= today)
      where e.company_id = company
        and e.person_id = l.person_id
        and e.status = 'active'
        and e.start_date <= today and (e.end_date is null or e.end_date >= today)
      order by a.effective_from desc
      limit 1
    ) wa on true
    left join public.designations d on d.id = wa.designation_id
    where m.company_id = company
      and m.product_code = 'operations'
      and m.is_active
      and m.has_all_location_access is not true
      and (
        ur.code in (
          'OPERATIONS_SIC', 'SIC', 'SI', 'SHIFT_INCHARGE',
          'OPERATIONS_SM', 'OPERATIONS_SRSM',
          'OPERATIONS_CTM', 'OPERATIONS_RM', 'OPERATIONS_REGIONAL_HEAD',
          'OPERATIONS_NH', 'OPERATIONS_NATIONAL_HEAD',
          'OPERATIONS_PGM', 'OPERATIONS_PROGRAM_HEAD',
          'REGIONAL_HEAD', 'NATIONAL_HEAD', 'PROGRAM_HEAD'
        )
        or upper(regexp_replace(concat_ws(' ', ur.code, ur.name, d.code, d.name), '[^A-Za-z0-9]+', ' ', 'g'))
          ~ '(^| )(SHIFT INCHARGE|SHIFT IN CHARGE|SIC|STORE MANAGER|SENIOR STORE MANAGER|SRSM|CITY MANAGER|CTM|REGIONAL MANAGER|REGIONAL HEAD|NATIONAL HEAD|PROGRAM MANAGER|PROGRAM HEAD)( |$)'
        or exists (
          select 1
          from public.role_page_permissions rpp
          where rpp.company_id = company
            and rpp.role_id = m.role_id
            and rpp.page_id = handover_page_id
            and rpp.can_view
        )
      )
  loop
    role_text := coalesce(rec.role_hay, '');
    store_ids := '{}'::uuid[];

    if role_text ~ '(^| )(RM|REGIONAL MANAGER|REGIONAL HEAD|NH|NATIONAL HEAD|PGM|PROGRAM MANAGER|PROGRAM HEAD)( |$)' then
      store_ids := now_station_ids;
    elsif role_text ~ '(^| )(CITY MANAGER|CITY HEAD|CTM)( |$)' then
      -- Keep existing NOW scopes + any NOW store where they (or a reportee SI/SM) are posted.
      select coalesce(array_agg(distinct sid), '{}'::uuid[])
      into store_ids
      from (
        select x as sid
        from unnest(coalesce(rec.location_scope_ids, '{}'::uuid[])) x
        where x = any(now_station_ids)
        union
        select a.location_id
        from public.hr_user_person_links l
        join public.hr_engagements e
          on e.person_id = l.person_id and e.company_id = company and e.status = 'active'
         and e.start_date <= today and (e.end_date is null or e.end_date >= today)
        join public.hr_work_assignments a
          on a.engagement_id = e.id and a.company_id = company and a.is_primary
         and a.effective_from <= today and (a.effective_to is null or a.effective_to >= today)
         and a.location_id = any(now_station_ids)
        where l.company_id = company and l.user_id = rec.user_id and l.status = 'active'
        union
        -- Reportees under this City Manager posted at NOW stores.
        select a.location_id
        from public.hr_user_person_links l
        join public.hr_engagements e
          on e.person_id = l.person_id and e.company_id = company and e.status = 'active'
         and e.start_date <= today and (e.end_date is null or e.end_date >= today)
        join public.hr_work_assignments mgr_a
          on mgr_a.engagement_id = e.id and mgr_a.company_id = company and mgr_a.is_primary
         and mgr_a.effective_from <= today and (mgr_a.effective_to is null or mgr_a.effective_to >= today)
        join public.hr_reporting_relationships rr
          on rr.company_id = company
         and rr.manager_assignment_id = mgr_a.id
         and rr.is_primary
         and rr.relationship_type = 'solid_line'
         and rr.effective_from <= today
         and (rr.effective_to is null or rr.effective_to >= today)
        join public.hr_work_assignments a
          on a.id = rr.subject_assignment_id
         and a.company_id = company
         and a.location_id = any(now_station_ids)
        where l.company_id = company and l.user_id = rec.user_id and l.status = 'active'
      ) q
      where sid is not null;
      -- If still empty, fall back to all NOW (City Managers must see stores to oversee).
      if store_ids is null or cardinality(store_ids) = 0 then
        store_ids := now_station_ids;
      end if;
    else
      -- SI / Store Manager: People posting location(s) that are NOW stores + existing NOW scopes.
      select coalesce(array_agg(distinct sid), '{}'::uuid[])
      into store_ids
      from (
        select a.location_id as sid
        from public.hr_user_person_links l
        join public.hr_engagements e
          on e.person_id = l.person_id and e.company_id = company and e.status = 'active'
         and e.start_date <= today and (e.end_date is null or e.end_date >= today)
        join public.hr_work_assignments a
          on a.engagement_id = e.id and a.company_id = company and a.is_primary
         and a.effective_from <= today and (a.effective_to is null or a.effective_to >= today)
         and a.location_id = any(now_station_ids)
        where l.company_id = company
          and l.user_id = rec.user_id
          and l.status = 'active'
        union
        select x
        from unnest(coalesce(rec.location_scope_ids, '{}'::uuid[])) x
        where x = any(now_station_ids)
      ) q;
    end if;

    if cardinality(store_ids) = 0 then
      continue;
    end if;

    update public.company_product_memberships m
    set
      location_scope_ids = (
        select array_agg(distinct x order by x)
        from unnest(coalesce(m.location_scope_ids, '{}'::uuid[]) || store_ids) as x
      ),
      updated_at = now()
    where m.id = rec.membership_id
      and (
        select count(*) from unnest(store_ids) s(id)
        where not (s.id = any(coalesce(m.location_scope_ids, '{}'::uuid[])))
      ) > 0;
    get diagnostics n = row_count;
    if n > 0 then
      raise notice 'Granted % NOW store(s) to %', cardinality(store_ids), rec.user_label;
    end if;
  end loop;

  -- 4) Explicit fixes from review-desk feedback: Anand → TCD4 (+ other NOW in his scope),
  --    Ramesh RM → all NOW.
  update public.company_product_memberships m
  set
    location_scope_ids = (
      select array_agg(distinct x order by x)
      from unnest(
        coalesce(m.location_scope_ids, '{}'::uuid[])
        || coalesce((
          select array_agg(s.id)
          from public.stations s
          where s.company_id = company
            and upper(regexp_replace(s.station_code, '[^A-Za-z0-9]', '', 'g')) in ('TCD4', 'TCC3')
            and s.location_model_id = any(now_model_ids)
        ), '{}'::uuid[])
      ) as x
    ),
    updated_at = now()
  where m.company_id = company
    and m.product_code = 'operations'
    and m.is_active
    and m.has_all_location_access is not true
    and m.user_id in (
      select l.user_id
      from public.hr_user_person_links l
      join public.hr_people p on p.id = l.person_id and p.company_id = company
      where l.company_id = company
        and l.status = 'active'
        and upper(p.display_name) like '%ANAND%KURUV%'
    );
  get diagnostics n = row_count;
  raise notice 'Anand Kuruv memberships updated for TCC3/TCD4: %', n;

  update public.company_product_memberships m
  set
    location_scope_ids = (
      select array_agg(distinct x order by x)
      from unnest(coalesce(m.location_scope_ids, '{}'::uuid[]) || now_station_ids) as x
    ),
    updated_at = now()
  where m.company_id = company
    and m.product_code = 'operations'
    and m.is_active
    and m.has_all_location_access is not true
    and m.user_id in (
      select l.user_id
      from public.hr_user_person_links l
      join public.hr_people p on p.id = l.person_id and p.company_id = company
      join public.hr_engagements e
        on e.person_id = p.id and e.company_id = company and e.status = 'active'
       and e.start_date <= today and (e.end_date is null or e.end_date >= today)
      join public.hr_work_assignments a
        on a.engagement_id = e.id and a.company_id = company and a.is_primary
       and a.effective_from <= today and (a.effective_to is null or a.effective_to >= today)
      join public.designations d on d.id = a.designation_id
      where l.company_id = company
        and l.status = 'active'
        and upper(p.display_name) like 'RAMESH%'
        and upper(regexp_replace(concat_ws(' ', d.code, d.name), '[^A-Za-z0-9]+', ' ', 'g'))
          ~ '(^| )(RM|REGIONAL MANAGER|REGIONAL HEAD)( |$)'
    );
  get diagnostics n = row_count;
  raise notice 'Ramesh RM memberships granted all NOW stores: %', n;

  raise notice 'Activities & Handover store access repair complete.';
end $$;

commit;
