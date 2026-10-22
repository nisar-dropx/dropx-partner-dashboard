-- When People (HRMS) changes a primary work-assignment location, keep OpsPulse
-- operations location_scope for Shift Incharge / Store Manager aligned:
-- replace NOW/Dark Store scopes with the current People-posted NOW store(s).
-- City / RM / NH scopes are left alone (they are not posting-bound).

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
  v_membership record;
  v_role_hay text;
  v_is_si_sm boolean;
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
      -- Classify from OpsPulse role only (not People designation). Designation
      -- tokens like "Store Manager" must not strip City/RM/NH portal scopes.
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
      v_is_si_sm := (
        coalesce(v_membership.role_code, '') in (
          'OPERATIONS_SIC', 'SIC', 'SI', 'SHIFT_INCHARGE',
          'OPERATIONS_SM', 'OPERATIONS_SRSM'
        )
        or v_role_hay ~ '(^| )(SHIFT INCHARGE|SHIFT IN CHARGE|SIC|STORE MANAGER|SENIOR STORE MANAGER|SRSM)( |$)'
      );
      if not v_is_si_sm then
        continue;
      end if;

      select coalesce(array_agg(distinct x), '{}'::uuid[])
      into v_non_now
      from unnest(coalesce(v_membership.location_scope_ids, '{}'::uuid[])) x
      where not (x = any(v_now_station_ids));

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

create or replace function public.trg_sync_ops_scope_from_work_assignment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_person_id uuid;
  v_company_id uuid;
  v_engagement_id uuid;
begin
  if tg_op = 'DELETE' then
    v_company_id := old.company_id;
    v_engagement_id := old.engagement_id;
  else
    v_company_id := new.company_id;
    v_engagement_id := new.engagement_id;
  end if;

  if tg_op = 'UPDATE' then
    if new.location_id is not distinct from old.location_id
      and new.is_primary is not distinct from old.is_primary
      and new.effective_from is not distinct from old.effective_from
      and new.effective_to is not distinct from old.effective_to
      and new.designation_id is not distinct from old.designation_id
    then
      return new;
    end if;
  end if;

  select e.person_id
  into v_person_id
  from public.hr_engagements e
  where e.id = v_engagement_id
    and e.company_id = v_company_id;

  if v_person_id is not null then
    perform public.sync_ops_si_sm_scope_for_person(v_company_id, v_person_id);
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_ops_scope_from_work_assignment on public.hr_work_assignments;
create trigger trg_sync_ops_scope_from_work_assignment
after insert or update of location_id, is_primary, effective_from, effective_to, designation_id
or delete
on public.hr_work_assignments
for each row
execute function public.trg_sync_ops_scope_from_work_assignment();

-- One-shot backfill for existing SI / Store Manager OpsPulse scopes.
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
    perform public.sync_ops_si_sm_scope_for_person(rec.company_id, rec.person_id);
  end loop;
end $$;
