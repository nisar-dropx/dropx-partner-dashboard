begin;

insert into public.app_pages (company_id, code, name, sort_order, is_active, created_at, updated_at)
select company.id, 'workspace_identity', 'Google Workspace', 113, true, now(), now()
from public.companies company
on conflict (company_id, code) do update
set name = excluded.name,
    sort_order = excluded.sort_order,
    is_active = true,
    updated_at = now();

insert into public.role_page_permissions (company_id, role_id, page_id, can_view, can_add, can_edit, updated_at)
select role.company_id, role.id, page.id, true, true, true, now()
from public.user_roles role
join public.app_pages page
  on page.company_id = role.company_id
 and page.code = 'workspace_identity'
where upper(role.code) = 'OWNER'
on conflict (company_id, role_id, page_id) do update
set can_view = true,
    can_add = true,
    can_edit = true,
    updated_at = now();

create table if not exists public.google_workspace_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  customer_id text,
  primary_domain text not null,
  delegated_admin_email text,
  default_org_unit_path text not null default '/',
  directory_sync_enabled boolean not null default false,
  provisioning_enabled boolean not null default false,
  automatic_suspension_enabled boolean not null default true,
  default_retention_days integer not null default 30,
  last_sync_at timestamptz,
  last_sync_status text,
  last_sync_error text,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint google_workspace_settings_domain_check
    check (primary_domain = lower(primary_domain) and primary_domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
  constraint google_workspace_settings_ou_check check (default_org_unit_path like '/%'),
  constraint google_workspace_settings_retention_check check (default_retention_days between 1 and 3650),
  constraint google_workspace_settings_sync_status_check
    check (last_sync_status is null or last_sync_status in ('running','success','failed','not_configured'))
);

create table if not exists public.google_workspace_designation_policies (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  designation_id uuid not null references public.designations(id) on delete cascade,
  issue_workspace_account boolean not null default false,
  approval_mode text not null default 'manual',
  email_pattern text not null default '{first}.{last}',
  org_unit_path text not null default '/',
  group_emails text[] not null default '{}',
  access_role_id uuid references public.user_roles(id) on delete restrict,
  product_codes text[] not null default '{}',
  location_access_mode text not null default 'assignment',
  send_activation_email boolean not null default true,
  retention_days integer,
  is_active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint google_workspace_designation_policy_unique unique (company_id, designation_id),
  constraint google_workspace_designation_policy_approval_check check (approval_mode in ('automatic','manual')),
  constraint google_workspace_designation_policy_pattern_check check (length(btrim(email_pattern)) between 3 and 120),
  constraint google_workspace_designation_policy_ou_check check (org_unit_path like '/%'),
  constraint google_workspace_designation_policy_products_check
    check (product_codes <@ array['operations','people','workforce','recruit','finance','tech']::text[]),
  constraint google_workspace_designation_policy_location_check
    check (location_access_mode in ('assignment','all_locations','none')),
  constraint google_workspace_designation_policy_retention_check
    check (retention_days is null or retention_days between 1 and 3650)
);

create index if not exists google_workspace_policy_company_active_idx
  on public.google_workspace_designation_policies(company_id, is_active, issue_workspace_account);

create table if not exists public.google_workspace_accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  google_user_id text,
  primary_email text not null,
  full_name text not null,
  org_unit_path text not null default '/',
  account_type text not null default 'unmatched',
  account_state text not null default 'pending',
  source_type text,
  source_record_id uuid,
  person_id uuid,
  profile_id uuid references public.profiles(id) on delete set null,
  designation_id uuid references public.designations(id) on delete set null,
  location_id uuid references public.stations(id) on delete set null,
  group_emails text[] not null default '{}',
  is_google_admin boolean not null default false,
  suspended boolean not null default false,
  archived boolean not null default false,
  deletion_eligible_at timestamptz,
  last_seen_at timestamptz,
  last_synced_at timestamptz,
  last_error text,
  google_etag text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint google_workspace_account_email_unique unique (company_id, primary_email),
  constraint google_workspace_account_google_id_unique unique (company_id, google_user_id),
  constraint google_workspace_account_type_check
    check (account_type in ('person','location','service','unmatched')),
  constraint google_workspace_account_state_check
    check (account_state in ('pending','provisioning','active','suspension_pending','suspended','deletion_pending','deleted','error')),
  constraint google_workspace_account_source_check
    check (source_type is null or source_type in ('employee','contractor','workforce','location','profile')),
  constraint google_workspace_account_ou_check check (org_unit_path like '/%')
);

create unique index if not exists google_workspace_account_source_unique
  on public.google_workspace_accounts(company_id, source_type, source_record_id)
  where source_type is not null and source_record_id is not null;
create index if not exists google_workspace_account_profile_idx
  on public.google_workspace_accounts(company_id, profile_id) where profile_id is not null;
create index if not exists google_workspace_account_state_idx
  on public.google_workspace_accounts(company_id, account_state, updated_at desc);

create table if not exists public.google_workspace_jobs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  account_id uuid references public.google_workspace_accounts(id) on delete cascade,
  job_type text not null,
  status text not null default 'queued',
  priority integer not null default 100,
  idempotency_key text not null unique,
  source_type text,
  source_record_id uuid,
  payload jsonb not null default '{}'::jsonb,
  attempt_count integer not null default 0,
  max_attempts integer not null default 8,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  completed_at timestamptz,
  last_error text,
  requested_by uuid references public.profiles(id) on delete set null,
  approved_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint google_workspace_job_type_check
    check (job_type in ('directory_sync','provision','update_access','suspend','restore','delete')),
  constraint google_workspace_job_status_check
    check (status in ('queued','running','completed','failed','blocked','cancelled')),
  constraint google_workspace_job_attempt_check
    check (attempt_count >= 0 and max_attempts between 1 and 25)
);

create index if not exists google_workspace_jobs_due_idx
  on public.google_workspace_jobs(status, next_attempt_at, priority, created_at)
  where status in ('queued','failed');

create table if not exists public.google_workspace_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  account_id uuid not null references public.google_workspace_accounts(id) on delete cascade,
  status text not null default 'retention',
  requested_at timestamptz not null default now(),
  eligible_at timestamptz not null,
  data_transfer_status text not null default 'pending',
  data_transfer_target_email text,
  legal_hold boolean not null default false,
  approved_by uuid references public.profiles(id) on delete set null,
  approved_at timestamptz,
  completed_at timestamptz,
  cancelled_by uuid references public.profiles(id) on delete set null,
  cancelled_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint google_workspace_deletion_account_unique unique (company_id, account_id),
  constraint google_workspace_deletion_status_check
    check (status in ('retention','eligible','approved','processing','completed','blocked','cancelled')),
  constraint google_workspace_deletion_transfer_check
    check (data_transfer_status in ('not_required','pending','in_progress','completed','blocked'))
);

create index if not exists google_workspace_deletion_due_idx
  on public.google_workspace_deletion_requests(status, eligible_at)
  where status in ('retention','eligible','approved');

create table if not exists public.google_workspace_audit_log (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  account_id uuid references public.google_workspace_accounts(id) on delete set null,
  job_id uuid references public.google_workspace_jobs(id) on delete set null,
  actor_user_id uuid references public.profiles(id) on delete set null,
  action text not null,
  status text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint google_workspace_audit_status_check check (status in ('requested','success','failed','blocked','cancelled'))
);

create index if not exists google_workspace_audit_company_created_idx
  on public.google_workspace_audit_log(company_id, created_at desc);

do $$
begin
  if to_regclass('public.company_product_memberships') is not null then
    alter table public.company_product_memberships
      drop constraint if exists company_product_memberships_source_check;
    alter table public.company_product_memberships
      add constraint company_product_memberships_source_check
      check (source_system in ('manual','product_owner','legacy_dashboard','people_hr','recruit','google_workspace'));
  end if;
end $$;

create or replace function public.revoke_dropx_workspace_access(
  p_company_id uuid,
  p_profile_id uuid,
  p_person_id uuid,
  p_reason text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_profile_id is not null then
    update public.profiles
    set is_active = false,
        updated_at = now()
    where company_id = p_company_id
      and id = p_profile_id
      and is_active;

    if to_regclass('public.company_product_memberships') is not null then
      execute 'update public.company_product_memberships set is_active = false, updated_at = now() where company_id = $1 and user_id = $2 and is_active'
      using p_company_id, p_profile_id;
    end if;
    if to_regclass('public.hr_user_access') is not null then
      execute 'update public.hr_user_access set is_active = false, updated_at = now() where company_id = $1 and user_id = $2 and is_active'
      using p_company_id, p_profile_id;
    end if;
    if to_regclass('public.hr_access_grants') is not null then
      execute 'update public.hr_access_grants set is_active = false, updated_at = now() where company_id = $1 and user_id = $2 and is_active'
      using p_company_id, p_profile_id;
    end if;
  end if;

  if p_person_id is not null and to_regclass('public.hr_user_person_links') is not null then
    execute 'update public.hr_user_person_links set status = ''inactive'', updated_at = now() where company_id = $1 and person_id = $2 and status = ''active'''
    using p_company_id, p_person_id;
  end if;

  insert into public.google_workspace_audit_log(company_id, account_id, actor_user_id, action, status, detail)
  select p_company_id, account.id, null, 'dropx_access_revoked', 'success', jsonb_build_object('reason', p_reason)
  from public.google_workspace_accounts account
  where account.company_id = p_company_id
    and (account.profile_id = p_profile_id or account.person_id = p_person_id)
  order by account.created_at
  limit 1;
end;
$$;

create or replace function public.queue_google_workspace_employee_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  policy_row public.google_workspace_designation_policies%rowtype;
  account_row public.google_workspace_accounts%rowtype;
  linked_person_id uuid;
  linked_profile_id uuid;
  retention_days_value integer;
  lifecycle_job_type text;
  lifecycle_changed boolean := false;
begin
  select * into policy_row
  from public.google_workspace_designation_policies policy
  where policy.company_id = new.company_id
    and policy.designation_id = new.designation_id
    and policy.is_active
    and policy.issue_workspace_account;

  select * into account_row
  from public.google_workspace_accounts account
  where account.company_id = new.company_id
    and account.source_type = 'employee'
    and account.source_record_id = new.id;

  if to_regclass('public.hr_engagements') is not null then
    execute 'select person_id from public.hr_engagements where company_id = $1 and employee_id = $2 order by created_at desc limit 1'
    into linked_person_id
    using new.company_id, new.id;
  end if;
  linked_profile_id := account_row.profile_id;
  if linked_profile_id is null and linked_person_id is not null and to_regclass('public.hr_user_person_links') is not null then
    execute 'select user_id from public.hr_user_person_links where company_id = $1 and person_id = $2 and status = ''active'' limit 1'
    into linked_profile_id
    using new.company_id, linked_person_id;
  end if;

  lifecycle_changed := tg_op = 'INSERT';
  if tg_op = 'UPDATE' then
    lifecycle_changed := old.is_active is distinct from new.is_active
      or old.designation_id is distinct from new.designation_id
      or old.location_id is distinct from new.location_id
      or old.full_name is distinct from new.full_name;
  end if;

  if new.is_active and policy_row.id is not null and lifecycle_changed then
    if account_row.id is not null and account_row.suspended then
      lifecycle_job_type := 'restore';
    elsif account_row.id is not null and account_row.google_user_id is not null then
      lifecycle_job_type := 'update_access';
    else
      lifecycle_job_type := 'provision';
    end if;

    insert into public.google_workspace_jobs(
      company_id, account_id, job_type, status, priority, idempotency_key,
      source_type, source_record_id, payload
    ) values (
      new.company_id, account_row.id, lifecycle_job_type,
      case when policy_row.approval_mode = 'automatic' then 'queued' else 'blocked' end,
      50,
      lifecycle_job_type || ':employee:' || new.id::text || ':' || txid_current()::text,
      'employee', new.id,
      jsonb_build_object('policy_id', policy_row.id, 'reason', 'employee_lifecycle')
    ) on conflict (idempotency_key) do nothing;
  end if;

  if tg_op = 'UPDATE' and old.is_active and not new.is_active then
    perform public.revoke_dropx_workspace_access(new.company_id, linked_profile_id, linked_person_id, 'employee_inactive');

    if account_row.id is not null then
      update public.google_workspace_accounts
      set account_state = 'suspension_pending',
          deletion_eligible_at = coalesce(deletion_eligible_at, now() + make_interval(days => coalesce(policy_row.retention_days, (
            select setting.default_retention_days from public.google_workspace_settings setting where setting.company_id = new.company_id
          ), 30))),
          updated_at = now()
      where id = account_row.id;

      insert into public.google_workspace_jobs(
        company_id, account_id, job_type, status, priority, idempotency_key,
        source_type, source_record_id, payload
      ) values (
        new.company_id, account_row.id, 'suspend', 'queued', 10,
        'suspend:' || account_row.id::text || ':' || txid_current()::text,
        'employee', new.id, jsonb_build_object('reason', 'employee_inactive')
      ) on conflict (idempotency_key) do nothing;

      select coalesce(policy_row.retention_days, setting.default_retention_days, 30)
      into retention_days_value
      from public.google_workspace_settings setting
      where setting.company_id = new.company_id;
      retention_days_value := coalesce(retention_days_value, policy_row.retention_days, 30);

      insert into public.google_workspace_deletion_requests(
        company_id, account_id, status, eligible_at, data_transfer_status, note
      ) values (
        new.company_id, account_row.id, 'retention', now() + make_interval(days => retention_days_value),
        'pending', 'Created automatically when the employee was made inactive.'
      )
      on conflict (company_id, account_id) do update
      set status = case when public.google_workspace_deletion_requests.status = 'completed' then 'completed' else 'retention' end,
          eligible_at = excluded.eligible_at,
          data_transfer_status = case when public.google_workspace_deletion_requests.status = 'completed' then public.google_workspace_deletion_requests.data_transfer_status else 'pending' end,
          updated_at = now();
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists employees_google_workspace_lifecycle on public.employees;
create trigger employees_google_workspace_lifecycle
after insert or update of is_active, designation_id, location_id, full_name
on public.employees
for each row execute function public.queue_google_workspace_employee_lifecycle();

create or replace function public.queue_google_workspace_profile_suspension()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  account_row public.google_workspace_accounts%rowtype;
  retention_days_value integer;
begin
  if old.is_active and not new.is_active then
    select * into account_row
    from public.google_workspace_accounts account
    where account.company_id = new.company_id
      and account.profile_id = new.id
      and account.account_state <> 'deleted'
    order by account.created_at
    limit 1;

    if account_row.id is not null then
      if to_regclass('public.company_product_memberships') is not null then
        execute 'update public.company_product_memberships set is_active = false, updated_at = now() where company_id = $1 and user_id = $2 and is_active'
        using new.company_id, new.id;
      end if;
      if to_regclass('public.hr_user_access') is not null then
        execute 'update public.hr_user_access set is_active = false, updated_at = now() where company_id = $1 and user_id = $2 and is_active'
        using new.company_id, new.id;
      end if;
      if to_regclass('public.hr_access_grants') is not null then
        execute 'update public.hr_access_grants set is_active = false, updated_at = now() where company_id = $1 and user_id = $2 and is_active'
        using new.company_id, new.id;
      end if;

      update public.google_workspace_accounts
      set account_state = 'suspension_pending', updated_at = now()
      where id = account_row.id;

      insert into public.google_workspace_jobs(
        company_id, account_id, job_type, status, priority, idempotency_key, source_type, source_record_id, payload
      ) values (
        new.company_id, account_row.id, 'suspend', 'queued', 10,
        'suspend:' || account_row.id::text || ':' || txid_current()::text,
        'profile', new.id, jsonb_build_object('reason', 'profile_inactive')
      ) on conflict (idempotency_key) do nothing;

      select coalesce(setting.default_retention_days, 30)
      into retention_days_value
      from public.google_workspace_settings setting
      where setting.company_id = new.company_id;
      retention_days_value := coalesce(retention_days_value, 30);

      insert into public.google_workspace_deletion_requests(
        company_id, account_id, status, eligible_at, data_transfer_status, note
      ) values (
        new.company_id, account_row.id, 'retention', now() + make_interval(days => retention_days_value),
        'pending', 'Created automatically when the DropX profile was made inactive.'
      )
      on conflict (company_id, account_id) do update
      set status = case when public.google_workspace_deletion_requests.status = 'completed' then 'completed' else 'retention' end,
          eligible_at = excluded.eligible_at,
          updated_at = now();
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_google_workspace_suspension on public.profiles;
create trigger profiles_google_workspace_suspension
after update of is_active on public.profiles
for each row execute function public.queue_google_workspace_profile_suspension();

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'google_workspace_settings',
    'google_workspace_designation_policies',
    'google_workspace_accounts',
    'google_workspace_jobs',
    'google_workspace_deletion_requests',
    'google_workspace_audit_log'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from public, anon, authenticated', table_name);
    execute format('grant select, insert, update, delete on table public.%I to service_role', table_name);
  end loop;
end $$;

revoke all on function public.revoke_dropx_workspace_access(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.queue_google_workspace_employee_lifecycle() from public, anon, authenticated;
revoke all on function public.queue_google_workspace_profile_suspension() from public, anon, authenticated;
grant execute on function public.revoke_dropx_workspace_access(uuid, uuid, uuid, text) to service_role;

comment on table public.google_workspace_settings is 'Company-scoped Google Workspace connection settings. Credentials remain in deployment secrets.';
comment on table public.google_workspace_designation_policies is 'Designation master policy for official email, OU, groups and DropX product access.';
comment on table public.google_workspace_accounts is 'Immutable mapping between Google Directory users and DropX people, profiles or locations.';
comment on table public.google_workspace_jobs is 'Idempotent outbox for Google Workspace directory and lifecycle operations.';
comment on table public.google_workspace_deletion_requests is 'Retention-controlled admin queue for permanent Google account deletion.';

notify pgrst, 'reload schema';

commit;
