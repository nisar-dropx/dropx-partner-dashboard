-- Activities & Handover: grant Shift Incharges write access, and managers above them oversight access.
-- Also seed master siRoles / managerRoles so start/accept stay SI-only while managers can read.
begin;

insert into public.app_pages (company_id, code, name, sort_order, is_active)
select c.id, p.code, p.name, p.sort_order, true
from public.companies c
cross join (values
  ('si_handover', 'Activities and Handover', 93),
  ('si_handover_master', 'Activities and Handover Master', 94)
) as p(code, name, sort_order)
on conflict (company_id, code) do update
set name = excluded.name, sort_order = excluded.sort_order, is_active = true, updated_at = now();

-- Shift Incharge (and SI-named roles): full view/add/edit so they can start, fill, submit, accept.
insert into public.role_page_permissions (company_id, role_id, page_id, can_view, can_add, can_edit)
select r.company_id, r.id, p.id, true, true, true
from public.user_roles r
join public.app_pages p
  on p.company_id = r.company_id
 and p.code = 'si_handover'
 and p.is_active
where r.is_active
  and (
    r.code in ('OPERATIONS_SIC', 'SIC', 'SI', 'SHIFT_INCHARGE')
    or upper(regexp_replace(concat_ws(' ', r.code, r.name), '[^A-Za-z0-9]+', ' ', 'g'))
      ~ '(^| )(SHIFT INCHARGE|SHIFT IN CHARGE|SIC)( |$)'
  )
on conflict (company_id, role_id, page_id) do update
set
  can_view = true,
  can_add = true,
  can_edit = true,
  updated_at = now();

-- Managers above SI on the Dark Store ladder (+ shared Ops oversight): view + edit.
-- Start/accept stay gated by master siRoles (Shift Incharge only).
insert into public.role_page_permissions (company_id, role_id, page_id, can_view, can_add, can_edit)
select r.company_id, r.id, p.id, true, false, true
from public.user_roles r
join public.app_pages p
  on p.company_id = r.company_id
 and p.code = 'si_handover'
 and p.is_active
where r.is_active
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
  -- Do not downgrade a Shift Incharge grant that also matched a manager name pattern.
  and not (
    r.code in ('OPERATIONS_SIC', 'SIC', 'SI', 'SHIFT_INCHARGE')
    or upper(regexp_replace(concat_ws(' ', r.code, r.name), '[^A-Za-z0-9]+', ' ', 'g'))
      ~ '(^| )(SHIFT INCHARGE|SHIFT IN CHARGE|SIC)( |$)'
  )
on conflict (company_id, role_id, page_id) do update
set
  can_view = true,
  can_edit = true,
  -- Keep add if already granted (e.g. copied from store_audits); do not force-add for managers.
  can_add = public.role_page_permissions.can_add,
  updated_at = now();

-- Seed master allowlists: SI roles start/accept; manager roles get oversight (isManager).
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
            r.code in ('OPERATIONS_SIC', 'SIC', 'SI', 'SHIFT_INCHARGE')
            or upper(regexp_replace(concat_ws(' ', r.code, r.name), '[^A-Za-z0-9]+', ' ', 'g'))
              ~ '(^| )(SHIFT INCHARGE|SHIFT IN CHARGE|SIC)( |$)'
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
    ), '[]'::jsonb)
  ),
  updated_at = now();

notify pgrst, 'reload schema';
commit;
