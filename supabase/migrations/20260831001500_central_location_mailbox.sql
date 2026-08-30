begin;

alter table public.ops_location_mailboxes
  add column if not exists mailbox_mode text not null default 'individual';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ops_location_mailboxes_mode_check'
  ) then
    alter table public.ops_location_mailboxes
      add constraint ops_location_mailboxes_mode_check
      check (mailbox_mode in ('individual', 'central_routed'));
  end if;
end $$;

alter table public.ops_location_mailbox_addresses
  add column if not exists route_state text not null default 'pending',
  add column if not exists route_error text,
  add column if not exists last_provisioned_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ops_location_mailbox_addresses_route_state_check'
  ) then
    alter table public.ops_location_mailbox_addresses
      add constraint ops_location_mailbox_addresses_route_state_check
      check (route_state in ('pending', 'active', 'conflict', 'error', 'not_required'));
  end if;
end $$;

update public.ops_location_mailbox_addresses
set route_state = 'not_required', route_error = null
where address_type = 'primary'
  and route_state = 'pending';

create unique index if not exists ops_location_one_central_mailbox_idx
  on public.ops_location_mailboxes(company_id)
  where mailbox_mode = 'central_routed' and status <> 'inactive';

comment on column public.ops_location_mailboxes.mailbox_mode is
  'individual is a legacy one-station inbox; central_routed is one physical inbox serving station group routes.';
comment on column public.ops_location_mailbox_addresses.route_state is
  'Provisioning state of the public station route connected to the central Google Workspace inbox.';

commit;
