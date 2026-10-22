-- Apply on shared Supabase when SM / Store Incharge need to cover Shift operations
-- (absent SI + same-city cross-store). Prefer the tracked migration:
--   supabase/migrations/20261022240000_si_sm_cover_shift_access.sql
--
-- This script is a company-scoped mirror for the DropX Ops company only.
begin;

do $$
declare
  company uuid := '43866344-b550-4e8a-9a2d-9d23f3d8a997';
  handover_page_id uuid;
  n int;
begin
  select id into handover_page_id
  from public.app_pages
  where company_id = company and code = 'si_handover' and is_active
  limit 1;
  if handover_page_id is null then
    raise exception 'si_handover page missing — run SI handover migrations first';
  end if;

  insert into public.role_page_permissions (company_id, role_id, page_id, can_view, can_add, can_edit)
  select r.company_id, r.id, handover_page_id, true, true, true
  from public.user_roles r
  where r.company_id = company
    and r.is_active
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
  get diagnostics n = row_count;
  raise notice 'SI + SM cover page grants upserted: %', n;

  update public.ops_si_handover_master m
  set
    settings = jsonb_set(
      jsonb_set(
        coalesce(m.settings, '{}'::jsonb),
        '{siRoles}',
        coalesce((
          select jsonb_agg(r.id order by r.name)
          from public.user_roles r
          where r.company_id = company
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
    updated_at = now()
  where m.company_id = company;

end $$;

-- Backfill scopes using the updated sync function (must exist from migration).
do $$
declare
  company uuid := '43866344-b550-4e8a-9a2d-9d23f3d8a997';
  rec record;
  n int := 0;
begin
  for rec in
    select distinct e.person_id
    from public.hr_user_person_links l
    join public.hr_engagements e
      on e.person_id = l.person_id and e.company_id = company and e.status = 'active'
    join public.company_product_memberships m
      on m.company_id = company
     and m.user_id = l.user_id
     and m.product_code = 'operations'
     and m.is_active
    left join public.user_roles ur on ur.id = m.role_id
    where l.company_id = company
      and l.status = 'active'
      and (
        ur.code in (
          'OPERATIONS_SIC', 'SIC', 'SI', 'SHIFT_INCHARGE',
          'OPERATIONS_SM', 'OPERATIONS_SRSM', 'OPERATIONS_STM', 'SM', 'SRSM'
        )
        or upper(regexp_replace(concat_ws(' ', ur.code, ur.name), '[^A-Za-z0-9]+', ' ', 'g'))
          ~ '(^| )(SHIFT INCHARGE|SHIFT IN CHARGE|SIC|STORE MANAGER|SENIOR STORE MANAGER|SRSM|STORE INCHARGE|STORE IN CHARGE)( |$)'
      )
  loop
    perform public.sync_ops_si_sm_scope_for_person(company, rec.person_id);
    n := n + 1;
  end loop;
  raise notice 'Synced OpsPulse scopes for % people', n;
end $$;

notify pgrst, 'reload schema';
commit;
