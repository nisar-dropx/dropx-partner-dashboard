-- Google Workspace accounts are issued only after People confirms that the
-- employee has actually joined. Also establishes the isolated Ops Pulse
-- location-mail data model; mailbox access is derived from station scope.

insert into public.app_pages (company_id, code, name, sort_order, is_active, created_at, updated_at)
select company.id, 'ops_location_mail', 'Mail', 85, true, now(), now()
from public.companies company
on conflict (company_id, code) do update
set name = excluded.name, sort_order = excluded.sort_order, is_active = true, updated_at = now();

insert into public.role_page_permissions (company_id, role_id, page_id, can_view, can_add, can_edit, updated_at)
select role.company_id, role.id, page.id, true, true, true, now()
from public.user_roles role
join public.app_pages page on page.company_id = role.company_id and page.code = 'ops_location_mail'
where upper(role.code) = 'OWNER'
on conflict (company_id, role_id, page_id) do update
set can_view = true, can_add = true, can_edit = true, updated_at = now();

alter table public.employees
  add column if not exists joining_status text not null default 'planned',
  add column if not exists joined_at timestamptz,
  add column if not exists joined_by uuid,
  add column if not exists joining_remarks text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'employees_joining_status_check'
  ) then
    alter table public.employees
      add constraint employees_joining_status_check
      check (joining_status in ('planned', 'joined', 'no_show'));
  end if;
end $$;

-- Existing employees who already own a mapped Google account are established
-- joiners. Everyone else remains planned until People explicitly confirms.
update public.employees employee
set joining_status = 'joined',
    joined_at = coalesce(employee.joined_at, employee.date_of_join::timestamptz, now()),
    joining_remarks = coalesce(employee.joining_remarks, 'Backfilled from existing Google Workspace account')
where employee.joining_status <> 'joined'
  and exists (
    select 1
    from public.google_workspace_accounts account
    where account.company_id = employee.company_id
      and account.source_type = 'employee'
      and account.source_record_id = employee.id
      and account.account_state <> 'deleted'
  );

create index if not exists employees_joining_queue_idx
  on public.employees(company_id, joining_status, date_of_join)
  where is_active;

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
  joining_ready boolean := false;
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
      or old.full_name is distinct from new.full_name
      or old.profile_completion_status is distinct from new.profile_completion_status
      or old.joining_status is distinct from new.joining_status
      or old.date_of_join is distinct from new.date_of_join;
  end if;

  joining_ready := new.is_active
    and coalesce(new.profile_completion_status, '') = 'active'
    and new.joining_status = 'joined'
    and new.joined_at is not null
    and new.date_of_join <= current_date;

  if joining_ready and policy_row.id is not null and lifecycle_changed then
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
      jsonb_build_object(
        'policy_id', policy_row.id,
        'reason', 'joining_confirmed',
        'joined_at', new.joined_at,
        'joined_by', new.joined_by
      )
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
after insert or update of is_active, designation_id, location_id, full_name,
  profile_completion_status, joining_status, date_of_join
on public.employees
for each row execute function public.queue_google_workspace_employee_lifecycle();

create table if not exists public.ops_location_mailboxes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  workspace_account_id uuid references public.google_workspace_accounts(id) on delete set null,
  credential_email text not null,
  display_name text not null,
  provider_type text not null default 'google_workspace',
  status text not null default 'active',
  sync_enabled boolean not null default true,
  last_history_id text,
  last_synced_at timestamptz,
  last_sync_error text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(company_id, credential_email),
  check (provider_type in ('google_workspace')),
  check (status in ('active', 'paused', 'error', 'inactive'))
);

create table if not exists public.ops_location_mailbox_addresses (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  mailbox_id uuid not null references public.ops_location_mailboxes(id) on delete cascade,
  station_id uuid not null references public.stations(id) on delete cascade,
  email_address text not null,
  address_type text not null default 'primary',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(company_id, station_id, email_address),
  check (address_type in ('primary', 'alias', 'group'))
);

create table if not exists public.ops_location_mail_messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  mailbox_id uuid not null references public.ops_location_mailboxes(id) on delete cascade,
  station_id uuid references public.stations(id) on delete set null,
  google_message_id text not null,
  google_thread_id text not null,
  direction text not null,
  from_email text not null,
  to_emails text[] not null default '{}',
  cc_emails text[] not null default '{}',
  subject text not null default '',
  snippet text not null default '',
  body_text text,
  body_html text,
  sent_at timestamptz not null,
  is_read boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(company_id, mailbox_id, google_message_id),
  check (direction in ('inbound', 'outbound'))
);

create index if not exists ops_location_mailbox_addresses_scope_idx
  on public.ops_location_mailbox_addresses(company_id, station_id, is_active);
create index if not exists ops_location_mail_messages_thread_idx
  on public.ops_location_mail_messages(company_id, mailbox_id, google_thread_id, sent_at desc);
create index if not exists ops_location_mail_messages_inbox_idx
  on public.ops_location_mail_messages(company_id, station_id, sent_at desc);

alter table public.ops_location_mailboxes enable row level security;
alter table public.ops_location_mailbox_addresses enable row level security;
alter table public.ops_location_mail_messages enable row level security;

revoke all on public.ops_location_mailboxes from anon, authenticated;
revoke all on public.ops_location_mailbox_addresses from anon, authenticated;
revoke all on public.ops_location_mail_messages from anon, authenticated;

comment on column public.employees.joining_status is 'People-controlled confirmation gate. Google identity issuance requires joined.';
comment on table public.ops_location_mailboxes is 'Physical Google Workspace inboxes surfaced in Ops Pulse.';
comment on table public.ops_location_mailbox_addresses is 'Station-scoped public addresses routed through a physical Ops mailbox.';
comment on table public.ops_location_mail_messages is 'Audited station-mail messages synchronized from Google Workspace.';
