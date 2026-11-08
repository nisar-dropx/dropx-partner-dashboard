-- OpsPulse's server creates requests; the Amazon worker claims them once.
-- Never grant browser roles direct access to commands or audit events.
create table if not exists public.amazon_da_commands (
  id uuid primary key,
  company_id uuid not null references public.companies(id),
  station_id uuid not null references public.stations(id),
  provider_id text not null check (provider_id ~ '^amzn1\.flex\.provider\.'),
  associate_name text not null,
  actor_id uuid not null,
  actor_name text not null,
  actor_role text not null,
  action text not null check (action in ('OFFBOARD','INACTIVATE','RESEND_INVITATION')),
  reason_code text not null,
  remarks text not null check (length(trim(remarks)) between 3 and 1000),
  expected_status text not null,
  status text not null default 'queued' check (status in ('queued','checking','sending','confirmed','failed','unconfirmed')),
  result_message text,
  observed_status text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create unique index if not exists amazon_da_commands_one_open
  on public.amazon_da_commands(company_id,provider_id)
  where status in ('queued','checking','sending','unconfirmed');
create index if not exists amazon_da_commands_history
  on public.amazon_da_commands(company_id,station_id,provider_id,created_at desc);
create table if not exists public.amazon_da_command_events (
  id bigint generated always as identity primary key,
  command_id uuid not null references public.amazon_da_commands(id),
  status text not null,
  message text,
  observed_status text,
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists amazon_da_events_command on public.amazon_da_command_events(command_id,id);
alter table public.amazon_da_commands enable row level security;
alter table public.amazon_da_command_events enable row level security;
revoke all on public.amazon_da_commands,public.amazon_da_command_events from public,anon,authenticated;
grant select,insert,update on public.amazon_da_commands to service_role;
grant select,insert on public.amazon_da_command_events to service_role;
grant usage,select on sequence public.amazon_da_command_events_id_seq to service_role;

create or replace function public.amazon_da_command_guard() returns trigger
language plpgsql set search_path = public,pg_temp as $$
begin
  if TG_OP = 'INSERT' then
    if new.status <> 'queued' then raise exception 'Commands must start queued'; end if;
    if not exists(select 1 from public.stations s where s.id=new.station_id and s.company_id=new.company_id and s.is_active)
      then raise exception 'Station is outside this company or inactive'; end if;
    if not exists(select 1 from public.profiles p where p.id=new.actor_id and p.company_id=new.company_id and p.is_active)
      then raise exception 'An active company user is required'; end if;
  else
    if (to_jsonb(new)-array['status','result_message','observed_status','updated_at'])
       is distinct from (to_jsonb(old)-array['status','result_message','observed_status','updated_at'])
      then raise exception 'Amazon action identity and request are immutable'; end if;
    if not ((old.status='queued' and new.status in ('checking','failed'))
      or (old.status='checking' and new.status in ('sending','failed'))
      or (old.status='sending' and new.status in ('confirmed','failed','unconfirmed'))
      or (old.status='unconfirmed' and new.status='confirmed'))
      then raise exception 'Invalid Amazon action transition'; end if;
  end if;
  new.updated_at=clock_timestamp();
  return new;
end $$;
create or replace function public.amazon_da_command_audit() returns trigger
language plpgsql set search_path = public,pg_temp as $$
begin
  insert into public.amazon_da_command_events(command_id,status,message,observed_status)
  values(new.id,new.status,new.result_message,new.observed_status);
  return new;
end $$;
revoke all on function public.amazon_da_command_guard(),public.amazon_da_command_audit() from public,anon,authenticated;
drop trigger if exists amazon_da_command_guard on public.amazon_da_commands;
create trigger amazon_da_command_guard before insert or update on public.amazon_da_commands
  for each row execute function public.amazon_da_command_guard();
drop trigger if exists amazon_da_command_audit on public.amazon_da_commands;
create trigger amazon_da_command_audit after insert or update on public.amazon_da_commands
  for each row execute function public.amazon_da_command_audit();
