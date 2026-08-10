begin;

alter table if exists public.payment_requests
  add column if not exists payment_reference text;

alter table public.payment_requests
  drop constraint if exists payment_requests_payment_mode_check;

alter table public.payment_requests
  drop constraint if exists payment_requests_status_check;

alter table public.payment_requests
  add constraint payment_requests_payment_mode_check
    check (payment_mode is null or lower(payment_mode) in ('account_transfer', 'online_payment', 'upi_payment')),
  add constraint payment_requests_status_check
    check (
      lower(status) in ('pending', 'resubmitted', 'approved', 'rejected', 'returned', 'processing', 'processed', 'cancelled')
      or upper(status) like '%\_APPROVED' escape '\'
    );

do $$
declare
  constraint_row record;
begin
  if to_regclass('public.payment_request_approvals') is not null then
    for constraint_row in
      select conname
      from pg_constraint
      where conrelid = 'public.payment_request_approvals'::regclass
        and contype = 'c'
        and pg_get_constraintdef(oid) ilike '%action%'
    loop
      execute format('alter table public.payment_request_approvals drop constraint %I', constraint_row.conname);
    end loop;

    alter table public.payment_request_approvals
      add constraint payment_request_approvals_action_check
        check (lower(action) in ('created', 'submitted', 'approved', 'rejected', 'returned', 'resubmitted', 'processing', 'processed', 'cancelled'));
  end if;
end $$;

create table if not exists public.payment_contacts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  contact_no text,
  email text,
  bank_account_no text not null,
  ifsc text not null,
  account_holder_name text not null,
  provider_code text not null default 'idspay',
  verified_at timestamptz,
  verification_details jsonb not null default '{}'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists payment_contacts_company_account_ifsc_uidx
  on public.payment_contacts (company_id, upper(btrim(bank_account_no)), upper(btrim(ifsc)));
create index if not exists payment_contacts_company_holder_idx
  on public.payment_contacts (company_id, account_holder_name);

alter table public.payment_contacts enable row level security;

drop policy if exists payment_contacts_service_role_all on public.payment_contacts;
create policy payment_contacts_service_role_all
  on public.payment_contacts for all
  to service_role
  using (true)
  with check (true);

insert into public.app_pages (company_id, code, name, sort_order, is_active, updated_at)
select companies.id, 'master_contacts', 'Contacts', 126, true, now()
from public.companies
where not exists (
  select 1
  from public.app_pages pages
  where pages.company_id = companies.id
    and pages.code = 'master_contacts'
);

update public.app_pages
set name = 'Contacts', sort_order = 126, is_active = true, updated_at = now()
where code = 'master_contacts' and company_id is not null;

insert into public.role_page_permissions (company_id, role_id, page_id, can_view, can_add, can_edit)
select roles.company_id, roles.id, pages.id, true, true, true
from public.user_roles roles
join public.app_pages pages on pages.company_id = roles.company_id
where upper(roles.code) = 'OWNER'
  and pages.code = 'master_contacts'
  and not exists (
    select 1
    from public.role_page_permissions permissions
    where permissions.company_id = roles.company_id
      and permissions.role_id = roles.id
      and permissions.page_id = pages.id
  );

update public.role_page_permissions permissions
set can_view = true, can_add = true, can_edit = true
from public.user_roles roles, public.app_pages pages
where permissions.company_id = roles.company_id
  and permissions.role_id = roles.id
  and permissions.page_id = pages.id
  and upper(roles.code) = 'OWNER'
  and pages.code = 'master_contacts';

commit;
