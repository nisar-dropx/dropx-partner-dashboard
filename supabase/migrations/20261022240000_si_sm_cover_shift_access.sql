-- Store Managers / Store Incharges cover Shift Incharge work when SI is absent
-- (including cross-store within the same city). Grant SI fill/start/accept rights
-- and expand OpsPulse NOW scope to same-city Dark Stores for cover roles.
begin;

-- 1) Page rights: SM / SRSM / Store Incharge get full add/edit on Shift operations.
insert into public.role_page_permissions (company_id, role_id, page_id, can_view, can_add, can_edit)
select r.company_id, r.id, p.id, true, true, true
from public.user_roles r
join public.app_pages p
  on p.company_id = r.company_id and p.code = 'si_handover' and p.is_active
where r.is_active
  and (
    r.code in (
      'OPERATIONS_SIC', 'SIC', 'SI', 'SHIFT_INCHARGE',
      'OPERATIONS_SM', 'OPERATIONS_SRSM', 'OPERATIONS_STM', 'SM', 'SRSM'
    )
    or upper(regexp_replace(concat_ws(' ', r.code, r.name), '[^A-Za-z0-9]+', ' ', 'g'))
      ~ '(^| )(SHIFT INCHARGE|SHIFT IN CHARGE|SIC|STORE MANAGER|SENIOR STORE MANAGER|SRSM|STORE INCHARGE|STORE IN CHARGE)( |$)'
  )
on conflict (company_id, role_id, page_id) do update
set can_view = true, can_add = true, can_edit = true, updated_at = now();

-- City+ stay oversight (view + edit, no add) — do not strip add if they also match SI/SM above.
insert into public.role_page_permissions (company_id, role_id, page_id, can_view, can_add, can_edit)
select r.company_id, r.id, p.id, true, false, true
from public.user_roles r
join public.app_pages p
  on p.company_id = r.company_id and p.code = 'si_handover' and p.is_active
where r.is_active
  and (
    r.code in (
      'OPERATIONS_CTM', 'OPERATIONS_CM', 'OPERATIONS_CLM', 'OPERATIONS_CLUSTER_HEAD',
      'OPERATIONS_AOM', 'OPERATIONS_RM', 'OPERATIONS_REGIONAL_HEAD',
      'OPERATIONS_NH', 'OPERATIONS_NATIONAL_HEAD',
      'OPERATIONS_PGM', 'OPERATIONS_PROGRAM_HEAD',
      'PROGRAM_HEAD', 'CLUSTER_HEAD', 'REGIONAL_HEAD', 'NATIONAL_HEAD'
    )
    or upper(regexp_replace(concat_ws(' ', r.code, r.name), '[^A-Za-z0-9]+', ' ', 'g'))
      ~ '(^| )(CITY MANAGER|CITY HEAD|CTM|CLUSTER MANAGER|CLUSTER HEAD|AREA OPERATIONS MANAGER|AREA MANAGER|AOM|REGIONAL MANAGER|REGIONAL HEAD|NATIONAL HEAD|PROGRAM MANAGER|PROGRAM HEAD)( |$)'
  )
  and not (
    r.code in (
      'OPERATIONS_SIC', 'SIC', 'SI', 'SHIFT_INCHARGE',
      'OPERATIONS_SM', 'OPERATIONS_SRSM', 'OPERATIONS_STM', 'SM', 'SRSM'
    )
    or upper(regexp_replace(concat_ws(' ', r.code, r.name), '[^A-Za-z0-9]+', ' ', 'g'))
      ~ '(^| )(SHIFT INCHARGE|SHIFT IN CHARGE|SIC|STORE MANAGER|SENIOR STORE MANAGER|SRSM|STORE INCHARGE|STORE IN CHARGE)( |$)'
  )
on conflict (company_id, role_id, page_id) do update
set
  can_view = true,
  can_edit = true,
  can_add = public.role_page_permissions.can_add,
  updated_at = now();

-- 2) Master allowlist: SI + SM cover roles can start / fill / accept.
update public.ops_si_handover_master m
set
  settings = jsonb_set(
    jsonb_set(
      coalesce(m.settings, '{}'::jsonb),
      '{siRoles}',
      coalesce((
        select jsonb_agg(r.id order by r.name)
        from public.user_roles r
        where r.company_id = m.company_id
          and r.is_active
          and (
            r.code in (
              'OPERATIONS_SIC', 'SIC', 'SI', 'SHIFT_INCHARGE',
              'OPERATIONS_SM', 'OPERATIONS_SRSM', 'OPERATIONS_STM', 'SM', 'SRSM'
            )
            or upper(regexp_replace(concat_ws(' ', r.code, r.name), '[^A-Za-z0-9]+', ' ', 'g'))
              ~ '(^| )(SHIFT INCHARGE|SHIFT IN CHARGE|SIC|STORE MANAGER|SENIOR STORE MANAGER|SRSM|STORE INCHARGE|STORE IN CHARGE)( |$)'
          )
      ), '[]'::jsonb)
    ),
    '{managerRoles}',
    coalesce((
      select jsonb_agg(r.id order by r.name)
      from public.user_roles r
      where r.company_id = m.company_id
        and r.is_active
        and (
          r.code in (
            'OPERATIONS_SM', 'OPERATIONS_SRSM', 'OPERATIONS_STM',
            'OPERATIONS_CTM', 'OPERATIONS_CM', 'OPERATIONS_CLM', 'OPERATIONS_CLUSTER_HEAD',
            'OPERATIONS_AOM',
            'OPERATIONS_RM', 'OPERATIONS_REGIONAL_HEAD',
            'OPERATIONS_NH', 'OPERATIONS_NATIONAL_HEAD',
            'OPERATIONS_PGM', 'OPERATIONS_PROGRAM_HEAD',
            'PROGRAM_HEAD', 'CLUSTER_HEAD', 'REGIONAL_HEAD', 'NATIONAL_HEAD'
          )
          or upper(regexp_replace(concat_ws(' ', r.code, r.name), '[^A-Za-z0-9]+', ' ', 'g'))
            ~ '(^| )(STORE MANAGER|SENIOR STORE MANAGER|SRSM|STORE INCHARGE|STORE IN CHARGE|CITY MANAGER|CTM|CLUSTER MANAGER|CLUSTER HEAD|AREA OPERATIONS MANAGER|AREA MANAGER|AOM|REGIONAL MANAGER|REGIONAL HEAD|NATIONAL HEAD|PROGRAM MANAGER|PROGRAM HEAD)( |$)'
        )
        and not (
          r.code in ('OPERATIONS_SIC', 'SIC', 'SI', 'SHIFT_INCHARGE')
          or upper(regexp_replace(concat_ws(' ', r.code, r.name), '[^A-Za-z0-9]+', ' ', 'g'))
            ~ '(^| )(SHIFT INCHARGE|SHIFT IN CHARGE|SIC)( |$)'
        )
    ), '[]'::jsonb)
  ),
  updated_at = now();

-- 3) Scope sync: SI stays posted-store only; SM / Store Incharge get same-city NOW stores for cover.
create or replace function public.sync_ops_si_sm_scope_for_person(
  p_company_id uuid,
  p_person_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (timezone('Asia/Kolkata', now()))::date;
  v_now_station_ids uuid[];
  v_posted uuid[];
  v_cover uuid[];
  v_membership record;
  v_role_hay text;
  v_is_si boolean;
  v_is_sm_cover boolean;
  v_non_now uuid[];
  v_next_scope uuid[];
  v_user_id uuid;
begin
  if p_company_id is null or p_person_id is null then
    return;
  end if;

  select coalesce(array_agg(s.id), '{}'::uuid[])
  into v_now_station_ids
  from public.stations s
  join public.location_models lm on lm.id = s.location_model_id
  where s.company_id = p_company_id
    and coalesce(s.is_active, true)
    and coalesce(s.hide_from_location_list, false) = false
    and coalesce(s.is_ho, false) = false
    and (
      upper(coalesce(lm.code, '')) in ('NOW', 'AMAZON NOW')
      or upper(coalesce(lm.name, '')) like '%AMAZON NOW%'
    );

  if cardinality(v_now_station_ids) = 0 then
    return;
  end if;

  select coalesce(array_agg(distinct a.location_id), '{}'::uuid[])
  into v_posted
  from public.hr_engagements e
  join public.hr_work_assignments a
    on a.engagement_id = e.id
   and a.company_id = p_company_id
   and a.is_primary
   and a.effective_from <= v_today
   and (a.effective_to is null or a.effective_to >= v_today)
   and a.location_id = any(v_now_station_ids)
  where e.company_id = p_company_id
    and e.person_id = p_person_id
    and e.status = 'active'
    and e.start_date <= v_today
    and (e.end_date is null or e.end_date >= v_today);

  -- Same-city NOW peers of posted stores (for SM / Store Incharge cover).
  select coalesce(array_agg(distinct peer.id), '{}'::uuid[])
  into v_cover
  from public.stations posted
  join public.stations peer
    on peer.company_id = posted.company_id
   and peer.id = any(v_now_station_ids)
   and nullif(btrim(lower(coalesce(peer.city, ''))), '') is not null
   and lower(btrim(peer.city)) = lower(btrim(posted.city))
  where posted.company_id = p_company_id
    and posted.id = any(coalesce(v_posted, '{}'::uuid[]));

  if cardinality(coalesce(v_cover, '{}'::uuid[])) = 0 then
    v_cover := coalesce(v_posted, '{}'::uuid[]);
  end if;

  for v_user_id in
    select l.user_id
    from public.hr_user_person_links l
    where l.company_id = p_company_id
      and l.person_id = p_person_id
      and l.status = 'active'
  loop
    for v_membership in
      select
        m.id as membership_id,
        m.location_scope_ids,
        ur.code as role_code,
        ur.name as role_name
      from public.company_product_memberships m
      left join public.user_roles ur
        on ur.id = m.role_id and ur.company_id = p_company_id
      where m.company_id = p_company_id
        and m.user_id = v_user_id
        and m.product_code = 'operations'
        and m.is_active
        and m.has_all_location_access is not true
    loop
      v_role_hay := upper(regexp_replace(
        concat_ws(' ', v_membership.role_code, v_membership.role_name),
        '[^A-Za-z0-9]+', ' ', 'g'
      ));
      if v_role_hay ~ '(^| )(CITY MANAGER|CITY HEAD|CTM|CLUSTER MANAGER|CLUSTER HEAD|AREA OPERATIONS MANAGER|AREA MANAGER|AOM|RM|REGIONAL MANAGER|REGIONAL HEAD|NH|NATIONAL HEAD|PGM|PROGRAM MANAGER|PROGRAM HEAD)( |$)'
         or coalesce(v_membership.role_code, '') in (
           'OPERATIONS_CTM', 'OPERATIONS_CM', 'OPERATIONS_CLM', 'OPERATIONS_CLUSTER_HEAD',
           'OPERATIONS_AOM', 'OPERATIONS_RM', 'OPERATIONS_REGIONAL_HEAD',
           'OPERATIONS_NH', 'OPERATIONS_NATIONAL_HEAD',
           'OPERATIONS_PGM', 'OPERATIONS_PROGRAM_HEAD',
           'PROGRAM_HEAD', 'CLUSTER_HEAD', 'REGIONAL_HEAD', 'NATIONAL_HEAD'
         )
      then
        continue;
      end if;

      v_is_si := (
        coalesce(v_membership.role_code, '') in (
          'OPERATIONS_SIC', 'SIC', 'SI', 'SHIFT_INCHARGE'
        )
        or v_role_hay ~ '(^| )(SHIFT INCHARGE|SHIFT IN CHARGE|SIC)( |$)'
      );
      v_is_sm_cover := (
        coalesce(v_membership.role_code, '') in (
          'OPERATIONS_SM', 'OPERATIONS_SRSM', 'OPERATIONS_STM', 'SM', 'SRSM'
        )
        or v_role_hay ~ '(^| )(STORE MANAGER|SENIOR STORE MANAGER|SRSM|STORE INCHARGE|STORE IN CHARGE)( |$)'
      );
      if not v_is_si and not v_is_sm_cover then
        continue;
      end if;

      select coalesce(array_agg(distinct x), '{}'::uuid[])
      into v_non_now
      from unnest(coalesce(v_membership.location_scope_ids, '{}'::uuid[])) x
      where not (x = any(v_now_station_ids));

      if v_is_sm_cover then
        if cardinality(v_cover) = 0 then
          v_next_scope := (
            select array_agg(distinct x order by x)
            from unnest(coalesce(v_non_now, '{}'::uuid[])) as x
          );
        else
          v_next_scope := (
            select array_agg(distinct x order by x)
            from unnest(coalesce(v_non_now, '{}'::uuid[]) || v_cover) as x
          );
        end if;
      else
        -- Pure Shift Incharge: posted NOW store(s) only.
        if cardinality(v_posted) = 0 then
          v_next_scope := (
            select array_agg(distinct x order by x)
            from unnest(coalesce(v_non_now, '{}'::uuid[])) as x
          );
        else
          v_next_scope := (
            select array_agg(distinct x order by x)
            from unnest(coalesce(v_non_now, '{}'::uuid[]) || v_posted) as x
          );
        end if;
      end if;

      update public.company_product_memberships m
      set location_scope_ids = coalesce(v_next_scope, '{}'::uuid[]),
          updated_at = now()
      where m.id = v_membership.membership_id
        and m.location_scope_ids is distinct from coalesce(v_next_scope, '{}'::uuid[]);
    end loop;
  end loop;
end;
$$;

revoke all on function public.sync_ops_si_sm_scope_for_person(uuid, uuid) from public;
grant execute on function public.sync_ops_si_sm_scope_for_person(uuid, uuid) to service_role;

-- Backfill cover scopes for existing SI / SM / Store Incharge memberships.
do $$
declare
  rec record;
begin
  for rec in
    select distinct e.company_id, e.person_id
    from public.hr_user_person_links l
    join public.hr_engagements e
      on e.person_id = l.person_id
     and e.company_id = l.company_id
     and e.status = 'active'
    join public.company_product_memberships m
      on m.company_id = l.company_id
     and m.user_id = l.user_id
     and m.product_code = 'operations'
     and m.is_active
     and m.has_all_location_access is not true
    left join public.user_roles ur on ur.id = m.role_id
    where l.status = 'active'
      and (
        ur.code in (
          'OPERATIONS_SIC', 'SIC', 'SI', 'SHIFT_INCHARGE',
          'OPERATIONS_SM', 'OPERATIONS_SRSM', 'OPERATIONS_STM', 'SM', 'SRSM'
        )
        or upper(regexp_replace(concat_ws(' ', ur.code, ur.name), '[^A-Za-z0-9]+', ' ', 'g'))
          ~ '(^| )(SHIFT INCHARGE|SHIFT IN CHARGE|SIC|STORE MANAGER|SENIOR STORE MANAGER|SRSM|STORE INCHARGE|STORE IN CHARGE)( |$)'
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
    perform public.sync_ops_si_sm_scope_for_person(rec.company_id, rec.person_id);
  end loop;
end $$;

notify pgrst, 'reload schema';
commit;
