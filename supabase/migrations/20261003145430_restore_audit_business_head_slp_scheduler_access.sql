-- Correct the Audit Master rollout: Business Head and SLP Manager already
-- have station_audits view/add/edit permissions, but were omitted from the
-- configurable scheduler list. Resolve role IDs within the company; do not
-- introduce user-specific exceptions or broaden anyone's location scope.
-- This is a one-time configuration update. Later Audit Master edits win.
do $$
declare
  target_company uuid;
  missing_roles uuid[];
begin
  select id into strict target_company
  from public.companies
  where name = 'DROPX LOGISTICS';

  if (select count(*) from public.user_roles
      where company_id = target_company and product_code = 'operations'
        and is_active and code in ('OPERATIONS_BH', 'OPERATIONS_SLPM')) <> 2 then
    raise exception 'Expected both active Business Head and SLP Manager roles';
  end if;

  perform 1 from public.ops_audit_programme_settings
  where company_id = target_company for update;
  if not found then
    raise exception 'Configure Audit Master before restoring scheduler access';
  end if;

  select coalesce(array_agg(r.id order by r.name), '{}'::uuid[])
  into missing_roles
  from public.user_roles r
  join public.ops_audit_programme_settings s on s.company_id = r.company_id
  where r.company_id = target_company and r.product_code = 'operations'
    and r.is_active and r.code in ('OPERATIONS_BH', 'OPERATIONS_SLPM')
    and not (r.id = any(s.scheduler_role_ids));

  if cardinality(missing_roles) > 0 then
    update public.ops_audit_programme_settings
    set scheduler_role_ids = scheduler_role_ids || missing_roles,
        updated_by = null
    where company_id = target_company;
  end if;
end $$;
