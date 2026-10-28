-- Control Tower already has station_audits view/add/edit, but was omitted from
-- Audit Master scheduler and cross-audit lists, so Start audit stayed hidden.
-- Resolve role IDs within the company; do not introduce user-specific exceptions.
-- This is a one-time configuration update. Later Audit Master edits win.
do $$
declare
  target_company uuid;
  scheduler_missing uuid[];
  cross_missing uuid[];
begin
  select id into strict target_company
  from public.companies
  where name = 'DROPX LOGISTICS';

  if not exists (
    select 1 from public.user_roles
    where company_id = target_company and product_code = 'operations'
      and is_active and code = 'OPERATIONS_CT'
  ) then
    raise exception 'Expected active CONTROL TOWER role (OPERATIONS_CT)';
  end if;

  perform 1 from public.ops_audit_programme_settings
  where company_id = target_company for update;
  if not found then
    raise exception 'Configure Audit Master before restoring Control Tower scheduler access';
  end if;

  select coalesce(array_agg(r.id order by r.name), '{}'::uuid[])
  into scheduler_missing
  from public.user_roles r
  join public.ops_audit_programme_settings s on s.company_id = r.company_id
  where r.company_id = target_company and r.product_code = 'operations'
    and r.is_active and r.code in ('OPERATIONS_CT', 'OPERATIONS_CONTROL_TOWER')
    and not (r.id = any(s.scheduler_role_ids));

  select coalesce(array_agg(r.id order by r.name), '{}'::uuid[])
  into cross_missing
  from public.user_roles r
  join public.ops_audit_programme_settings s on s.company_id = r.company_id
  where r.company_id = target_company and r.product_code = 'operations'
    and r.is_active and r.code in ('OPERATIONS_CT', 'OPERATIONS_CONTROL_TOWER')
    and not (r.id = any(s.cross_audit_role_ids));

  if cardinality(scheduler_missing) > 0 or cardinality(cross_missing) > 0 then
    update public.ops_audit_programme_settings
    set scheduler_role_ids = case
          when cardinality(scheduler_missing) > 0
            then scheduler_role_ids || scheduler_missing
          else scheduler_role_ids
        end,
        cross_audit_role_ids = case
          when cardinality(cross_missing) > 0
            then cross_audit_role_ids || cross_missing
          else cross_audit_role_ids
        end,
        updated_by = null
    where company_id = target_company;
  end if;
end $$;
