begin;

-- DropX and biometric identities belong to one person inside a company, even
-- when the person could otherwise be created through a different register.
-- These normalizers are also used by the supporting expression indexes.
create or replace function public.normalize_people_dropx_id(p_value text)
returns text
language sql
immutable
parallel safe
returns null on null input
set search_path = ''
as $$
  select nullif(
    pg_catalog.regexp_replace(pg_catalog.upper(pg_catalog.btrim(p_value)), '[[:space:]]+', '', 'g'),
    ''
  )
$$;

create or replace function public.normalize_people_biometric_id(p_value text)
returns text
language sql
immutable
parallel safe
returns null on null input
set search_path = ''
as $$
  select case
    when nullif(pg_catalog.btrim(p_value), '') is null then null
    when pg_catalog.btrim(p_value) ~ '^[0-9]{1,20}$'
      then coalesce(nullif(pg_catalog.ltrim(pg_catalog.btrim(p_value), '0'), ''), '0')
    else null
  end
$$;

create or replace function public.enforce_people_identity_uniqueness()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_new jsonb := to_jsonb(new);
  v_old jsonb;
  v_code_column text := tg_argv[0];
  v_company uuid;
  v_old_company uuid;
  v_profile_id uuid;
  v_code_raw text;
  v_code text;
  v_old_code text;
  v_bio_raw text;
  v_bio text;
  v_old_bio text;
  v_check_code boolean;
  v_check_bio boolean;
  v_lock_key text;
  v_owner record;
  v_owner_label text;
begin
  if v_code_column not in ('employee_code', 'dropx_id') then
    raise exception using
      errcode = '22023',
      message = 'People identity trigger has an invalid code-column configuration.';
  end if;

  v_company := nullif(v_new ->> 'company_id', '')::uuid;
  v_profile_id := nullif(v_new ->> 'id', '')::uuid;
  v_code_raw := nullif(pg_catalog.btrim(v_new ->> v_code_column), '');
  v_code := public.normalize_people_dropx_id(v_code_raw);
  v_bio_raw := nullif(pg_catalog.btrim(v_new ->> 'biometric_id'), '');
  v_bio := public.normalize_people_biometric_id(v_bio_raw);

  if tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    v_old_company := nullif(v_old ->> 'company_id', '')::uuid;
    v_old_code := public.normalize_people_dropx_id(v_old ->> v_code_column);
    v_old_bio := public.normalize_people_biometric_id(v_old ->> 'biometric_id');
    v_check_code := v_company is distinct from v_old_company
      or v_code is distinct from v_old_code;
    v_check_bio := v_company is distinct from v_old_company
      or v_bio is distinct from v_old_bio;
  else
    v_check_code := true;
    v_check_bio := true;
  end if;

  -- Existing grandfathered collisions remain editable when neither identity
  -- changed. A change checks only the identity being changed, so the record can
  -- be corrected without first touching the other grandfathered value.
  if not v_check_code and not v_check_bio then
    return new;
  end if;

  if v_company is null and (v_code is not null or v_bio_raw is not null) then
    raise exception using
      errcode = '23514',
      message = 'Company is required before assigning a DropX ID or biometric ID.';
  end if;
  if v_profile_id is null then
    raise exception using
      errcode = '23514',
      message = 'Profile ID is required before assigning a DropX ID or biometric ID.';
  end if;
  if v_check_bio and v_bio_raw is not null and v_bio is null then
    raise exception using
      errcode = '23514',
      message = 'Biometric ID must contain 1 to 20 digits only.';
  end if;

  -- Serialize claims for the same normalized values. Sorting the two locks
  -- prevents transactions that change both IDs from taking them in reverse order.
  for v_lock_key in
    select lock_key
    from unnest(array[
      case when v_check_code and v_code is not null then v_company::text || ':dropx:' || v_code end,
      case when v_check_bio and v_bio is not null then v_company::text || ':biometric:' || v_bio end
    ]) as locks(lock_key)
    where lock_key is not null
    order by lock_key
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_lock_key, 0));
  end loop;

  if v_check_code and v_code is not null then
    select owner.* into v_owner
    from (
      select 'employees'::text source_table, id source_id, full_name, employee_code source_code
      from public.employees
      where company_id = v_company
        and public.normalize_people_dropx_id(employee_code) = v_code
      union all
      select 'contractors', id, full_name, dropx_id
      from public.contractors
      where company_id = v_company
        and public.normalize_people_dropx_id(dropx_id) = v_code
      union all
      select 'workforce', id, full_name, dropx_id
      from public.workforce
      where company_id = v_company
        and public.normalize_people_dropx_id(dropx_id) = v_code
      union all
      select 'helpers', id, full_name, dropx_id
      from public.helpers
      where company_id = v_company
        and public.normalize_people_dropx_id(dropx_id) = v_code
      union all
      select 'vendors', id, full_name, dropx_id
      from public.vendors
      where company_id = v_company
        and public.normalize_people_dropx_id(dropx_id) = v_code
      union all
      select 'workforce_helpers', id, full_name, dropx_id
      from public.workforce_helpers
      where company_id = v_company
        and public.normalize_people_dropx_id(dropx_id) = v_code
      union all
      select 'workforce_pickers', id, full_name, dropx_id
      from public.workforce_pickers
      where company_id = v_company
        and public.normalize_people_dropx_id(dropx_id) = v_code
    ) owner
    where owner.source_table <> tg_table_name or owner.source_id <> v_profile_id
    order by owner.source_table, owner.source_id
    limit 1;

    if found then
      v_owner_label := case v_owner.source_table
        when 'employees' then 'Employees'
        when 'contractors' then 'Independent Contractors'
        when 'workforce' then 'Workforce'
        when 'helpers' then 'Helpers'
        when 'vendors' then 'Vendors'
        when 'workforce_helpers' then 'Legacy Helpers'
        when 'workforce_pickers' then 'Legacy Pickers'
        else v_owner.source_table
      end;
      raise exception using
        errcode = '23505',
        constraint = 'people_identity_dropx_unique',
        message = pg_catalog.format(
          'DropX ID %s is already assigned to %s - %s in %s.',
          v_code,
          coalesce(v_owner.source_code, '-'),
          coalesce(v_owner.full_name, 'Existing profile'),
          v_owner_label
        );
    end if;
  end if;

  if v_check_bio and v_bio is not null then
    select owner.* into v_owner
    from (
      select 'employees'::text source_table, id source_id, full_name, employee_code source_code
      from public.employees
      where company_id = v_company
        and public.normalize_people_biometric_id(biometric_id) = v_bio
      union all
      select 'contractors', id, full_name, dropx_id
      from public.contractors
      where company_id = v_company
        and public.normalize_people_biometric_id(biometric_id) = v_bio
      union all
      select 'workforce', id, full_name, dropx_id
      from public.workforce
      where company_id = v_company
        and public.normalize_people_biometric_id(biometric_id) = v_bio
      union all
      select 'helpers', id, full_name, dropx_id
      from public.helpers
      where company_id = v_company
        and public.normalize_people_biometric_id(biometric_id) = v_bio
      union all
      select 'vendors', id, full_name, dropx_id
      from public.vendors
      where company_id = v_company
        and public.normalize_people_biometric_id(biometric_id) = v_bio
      union all
      select 'workforce_helpers', id, full_name, dropx_id
      from public.workforce_helpers
      where company_id = v_company
        and public.normalize_people_biometric_id(biometric_id) = v_bio
      union all
      select 'workforce_pickers', id, full_name, dropx_id
      from public.workforce_pickers
      where company_id = v_company
        and public.normalize_people_biometric_id(biometric_id) = v_bio
    ) owner
    where owner.source_table <> tg_table_name or owner.source_id <> v_profile_id
    order by owner.source_table, owner.source_id
    limit 1;

    if found then
      v_owner_label := case v_owner.source_table
        when 'employees' then 'Employees'
        when 'contractors' then 'Independent Contractors'
        when 'workforce' then 'Workforce'
        when 'helpers' then 'Helpers'
        when 'vendors' then 'Vendors'
        when 'workforce_helpers' then 'Legacy Helpers'
        when 'workforce_pickers' then 'Legacy Pickers'
        else v_owner.source_table
      end;
      raise exception using
        errcode = '23505',
        constraint = 'people_identity_biometric_unique',
        message = pg_catalog.format(
          'Biometric ID %s is already assigned to %s - %s in %s.',
          v_bio,
          coalesce(v_owner.source_code, '-'),
          coalesce(v_owner.full_name, 'Existing profile'),
          v_owner_label
        );
    end if;
  end if;

  return new;
end
$function$;

revoke all on function public.enforce_people_identity_uniqueness() from public, anon, authenticated;

-- Normalized lookup indexes keep trigger checks fast without requiring existing
-- grandfathered duplicates to be resolved in this deployment.
create index if not exists employees_people_dropx_norm_idx
  on public.employees (company_id, public.normalize_people_dropx_id(employee_code))
  where employee_code is not null;
create index if not exists employees_people_biometric_norm_idx
  on public.employees (company_id, public.normalize_people_biometric_id(biometric_id))
  where biometric_id is not null;
create index if not exists contractors_people_dropx_norm_idx
  on public.contractors (company_id, public.normalize_people_dropx_id(dropx_id))
  where dropx_id is not null;
create index if not exists contractors_people_biometric_norm_idx
  on public.contractors (company_id, public.normalize_people_biometric_id(biometric_id))
  where biometric_id is not null;
create index if not exists workforce_people_dropx_norm_idx
  on public.workforce (company_id, public.normalize_people_dropx_id(dropx_id))
  where dropx_id is not null;
create index if not exists workforce_people_biometric_norm_idx
  on public.workforce (company_id, public.normalize_people_biometric_id(biometric_id))
  where biometric_id is not null;
create index if not exists helpers_people_dropx_norm_idx
  on public.helpers (company_id, public.normalize_people_dropx_id(dropx_id))
  where dropx_id is not null;
create index if not exists helpers_people_biometric_norm_idx
  on public.helpers (company_id, public.normalize_people_biometric_id(biometric_id))
  where biometric_id is not null;
create index if not exists vendors_people_dropx_norm_idx
  on public.vendors (company_id, public.normalize_people_dropx_id(dropx_id))
  where dropx_id is not null;
create index if not exists vendors_people_biometric_norm_idx
  on public.vendors (company_id, public.normalize_people_biometric_id(biometric_id))
  where biometric_id is not null;
create index if not exists workforce_helpers_people_dropx_norm_idx
  on public.workforce_helpers (company_id, public.normalize_people_dropx_id(dropx_id))
  where dropx_id is not null;
create index if not exists workforce_helpers_people_biometric_norm_idx
  on public.workforce_helpers (company_id, public.normalize_people_biometric_id(biometric_id))
  where biometric_id is not null;
create index if not exists workforce_pickers_people_dropx_norm_idx
  on public.workforce_pickers (company_id, public.normalize_people_dropx_id(dropx_id))
  where dropx_id is not null;
create index if not exists workforce_pickers_people_biometric_norm_idx
  on public.workforce_pickers (company_id, public.normalize_people_biometric_id(biometric_id))
  where biometric_id is not null;

drop trigger if exists a00_people_identity_unique on public.employees;
create trigger a00_people_identity_unique
before insert or update of company_id, employee_code, biometric_id
on public.employees for each row
execute function public.enforce_people_identity_uniqueness('employee_code');

drop trigger if exists a00_people_identity_unique on public.contractors;
create trigger a00_people_identity_unique
before insert or update of company_id, dropx_id, biometric_id
on public.contractors for each row
execute function public.enforce_people_identity_uniqueness('dropx_id');

drop trigger if exists a00_people_identity_unique on public.workforce;
create trigger a00_people_identity_unique
before insert or update of company_id, dropx_id, biometric_id
on public.workforce for each row
execute function public.enforce_people_identity_uniqueness('dropx_id');

drop trigger if exists a00_people_identity_unique on public.helpers;
create trigger a00_people_identity_unique
before insert or update of company_id, dropx_id, biometric_id
on public.helpers for each row
execute function public.enforce_people_identity_uniqueness('dropx_id');

drop trigger if exists a00_people_identity_unique on public.vendors;
create trigger a00_people_identity_unique
before insert or update of company_id, dropx_id, biometric_id
on public.vendors for each row
execute function public.enforce_people_identity_uniqueness('dropx_id');

drop trigger if exists a00_people_identity_unique on public.workforce_helpers;
create trigger a00_people_identity_unique
before insert or update of company_id, dropx_id, biometric_id
on public.workforce_helpers for each row
execute function public.enforce_people_identity_uniqueness('dropx_id');

drop trigger if exists a00_people_identity_unique on public.workforce_pickers;
create trigger a00_people_identity_unique
before insert or update of company_id, dropx_id, biometric_id
on public.workforce_pickers for each row
execute function public.enforce_people_identity_uniqueness('dropx_id');

comment on function public.enforce_people_identity_uniqueness() is
  'Prevents normalized DropX and biometric IDs from being claimed by different people records in the same company, including archived records.';

commit;
