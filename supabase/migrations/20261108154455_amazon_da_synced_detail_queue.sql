-- Small, private status snapshots; PDFs and identity documents are not stored here.
create table public.amazon_da_detail_snapshots (
 company_id uuid not null references public.companies(id),
 provider_id text not null check(provider_id ~ '^amzn1[.]flex[.]provider[.]v1[.][0-9a-fA-F-]{36}$'),
 station_id uuid not null references public.stations(id),
 identity_email text,
 associate_name text not null,
 source_status text not null default 'ONBOARDING',
 sync_milestones boolean not null default true,
 milestones jsonb not null default '[]'::jsonb check(jsonb_typeof(milestones)='array'),
 milestones_at timestamptz,
 idfy jsonb,
 idfy_at timestamptz,
 milestone_error text,
 idfy_error text,
 requested_at timestamptz,
 next_sync_at timestamptz not null default now(),
 attempted_at timestamptz,
 enabled boolean not null default true,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 primary key(company_id,provider_id)
);
create index amazon_da_details_due on public.amazon_da_detail_snapshots(company_id,next_sync_at) where enabled;
create index amazon_da_details_station on public.amazon_da_detail_snapshots(company_id,station_id);
alter table public.amazon_da_detail_snapshots enable row level security;
revoke all on public.amazon_da_detail_snapshots from public,anon,authenticated;
grant select,insert,update on public.amazon_da_detail_snapshots to service_role;

create table public.amazon_da_sync_leases (
 company_id uuid primary key references public.companies(id),
 token uuid not null,
 lease_until timestamptz not null
);
alter table public.amazon_da_sync_leases enable row level security;
revoke all on public.amazon_da_sync_leases from public,anon,authenticated;
grant select,insert,update on public.amazon_da_sync_leases to service_role;
create function public.claim_amazon_da_sync(p_company uuid,p_token uuid)
returns boolean language sql security invoker set search_path=public as $$
 with claimed as (
 insert into public.amazon_da_sync_leases(company_id,token,lease_until)
 values(p_company,p_token,now()+interval '8 minutes')
 on conflict(company_id) do update set token=excluded.token,lease_until=excluded.lease_until
 where amazon_da_sync_leases.lease_until<now()
 returning 1
 ) select exists(select 1 from claimed);
$$;
revoke all on function public.claim_amazon_da_sync(uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_amazon_da_sync(uuid,uuid) to service_role;

create table public.amazon_da_idfy_actions (
 id uuid primary key,
 company_id uuid not null references public.companies(id),
 station_id uuid not null references public.stations(id),
 provider_id text not null,
 idfy_profile_id text not null check(idfy_profile_id ~ '^[0-9]+$'),
 block_id text,
 action text not null check(action in ('response','report_view','report_download')),
 actor_id uuid not null,
 actor_name text not null,
 actor_role text not null,
 form_version text,
 values_submitted jsonb not null default '{}'::jsonb,
 changes jsonb not null default '[]'::jsonb,
 status text not null check(status in ('queued','sending','submitted','unconfirmed','failed','downloaded')),
 result_message text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index amazon_da_idfy_history on public.amazon_da_idfy_actions(company_id,station_id,provider_id,created_at desc);
create unique index amazon_da_idfy_one_sending on public.amazon_da_idfy_actions(company_id,idfy_profile_id,block_id) where action='response' and status in ('queued','sending','unconfirmed');
alter table public.amazon_da_idfy_actions enable row level security;
revoke all on public.amazon_da_idfy_actions from public,anon,authenticated;
grant select,insert,update on public.amazon_da_idfy_actions to service_role;
create function public.guard_amazon_da_idfy_history() returns trigger language plpgsql security invoker set search_path=public as $$
begin
 if row(new.id,new.company_id,new.station_id,new.provider_id,new.idfy_profile_id,new.block_id,new.action,new.actor_id,new.actor_name,new.actor_role,new.form_version,new.values_submitted,new.created_at)
 is distinct from row(old.id,old.company_id,old.station_id,old.provider_id,old.idfy_profile_id,old.block_id,old.action,old.actor_id,old.actor_name,old.actor_role,old.form_version,old.values_submitted,old.created_at) then
 raise exception 'IDfy action identity and original submission are immutable'; end if;
 if old.status not in ('queued','sending','unconfirmed') then raise exception 'Completed IDfy history is immutable'; end if;
 if not ((old.status='queued' and new.status in ('sending','failed')) or (old.status='sending' and new.status in ('submitted','unconfirmed','failed')) or (old.status='unconfirmed' and new.status in ('unconfirmed','submitted'))) then raise exception 'Invalid IDfy action transition'; end if;
 if old.status<>'queued' and new.changes is distinct from old.changes then raise exception 'Submitted field history is immutable'; end if;
 new.updated_at=clock_timestamp();return new;
end; $$;
create trigger guard_amazon_da_idfy_history before update on public.amazon_da_idfy_actions for each row execute function public.guard_amazon_da_idfy_history();
revoke all on function public.guard_amazon_da_idfy_history() from public,anon,authenticated;

create table public.amazon_da_idfy_events (
 id uuid primary key default gen_random_uuid(),
 action_id uuid not null references public.amazon_da_idfy_actions(id),
 status text not null,
 message text,
 created_at timestamptz not null default now()
);
create index amazon_da_idfy_event_action on public.amazon_da_idfy_events(action_id,created_at);
alter table public.amazon_da_idfy_events enable row level security;
revoke all on public.amazon_da_idfy_events from public,anon,authenticated;
grant select,insert on public.amazon_da_idfy_events to service_role;
create function public.record_amazon_da_idfy_event() returns trigger language plpgsql security invoker set search_path=public as $$
begin
 insert into public.amazon_da_idfy_events(action_id,status,message) values(new.id,new.status,new.result_message);
 return new;
end; $$;
create trigger record_amazon_da_idfy_event after insert or update on public.amazon_da_idfy_actions for each row execute function public.record_amazon_da_idfy_event();
revoke all on function public.record_amazon_da_idfy_event() from public,anon,authenticated;
