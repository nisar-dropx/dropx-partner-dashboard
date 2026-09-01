begin;

create or replace function public.provision_workforce_category_table(
  p_company_id uuid,
  p_category_code text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_code text := lower(trim(coalesce(p_category_code, '')));
  table_name text;
begin
  if normalized_code !~ '^[a-z0-9_]+$' then
    raise exception 'Invalid workforce category code.';
  end if;
  if normalized_code in ('employees', 'workforce', 'contractors', 'vendors', 'workers') then
    raise exception 'System workforce categories use their existing tables.';
  end if;
  if not exists (
    select 1
    from public.workforce_categories category
    where category.company_id = p_company_id
      and category.code = normalized_code
      and category.is_active = true
  ) then
    raise exception 'Active workforce category was not found.';
  end if;

  table_name := 'workforce_' || normalized_code;
  execute format(
    'create table if not exists public.%I (like public.workforce including all)',
    table_name
  );
  execute format('alter table public.%I enable row level security', table_name);

  if not exists (
    select 1 from pg_constraint
    where conname = table_name || '_company_id_fkey'
      and conrelid = ('public.' || table_name)::regclass
  ) then
    execute format(
      'alter table public.%I add constraint %I foreign key (company_id) references public.companies(id) on delete cascade',
      table_name,
      table_name || '_company_id_fkey'
    );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = table_name || '_location_id_fkey'
      and conrelid = ('public.' || table_name)::regclass
  ) then
    execute format(
      'alter table public.%I add constraint %I foreign key (location_id) references public.stations(id)',
      table_name,
      table_name || '_location_id_fkey'
    );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = table_name || '_created_by_fkey'
      and conrelid = ('public.' || table_name)::regclass
  ) then
    execute format(
      'alter table public.%I add constraint %I foreign key (created_by) references auth.users(id)',
      table_name,
      table_name || '_created_by_fkey'
    );
  end if;

  execute format(
    'create unique index if not exists %I on public.%I(company_id, dropx_id) where dropx_id is not null',
    table_name || '_company_dropx_id_uidx',
    table_name
  );
  execute format(
    'create unique index if not exists %I on public.%I(company_id, biometric_id) where biometric_id is not null',
    table_name || '_company_biometric_id_uidx',
    table_name
  );
  execute format(
    'create index if not exists %I on public.%I(company_id, created_at desc)',
    table_name || '_company_created_idx',
    table_name
  );

  return table_name;
end;
$$;

revoke all on function public.provision_workforce_category_table(uuid, text) from public;
grant execute on function public.provision_workforce_category_table(uuid, text) to service_role;

-- Provision tables for custom categories that already exist, including Pickers.
do $$
declare
  category record;
begin
  for category in
    select company_id, code
    from public.workforce_categories
    where is_active = true
      and code not in ('employees', 'workforce', 'contractors', 'vendors', 'workers')
  loop
    perform public.provision_workforce_category_table(category.company_id, category.code);
  end loop;
end;
$$;

notify pgrst, 'reload schema';

commit;
