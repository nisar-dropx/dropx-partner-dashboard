-- Separate DA-mapping communication settings and delivery ledger. No changes to Fleet status mail.
create table if not exists public.fleet_mapping_mail_settings (
 company_id uuid primary key references public.companies(id),
 config jsonb not null default '{}'::jsonb,
 updated_by uuid references public.profiles(id), updated_at timestamptz not null default now()
);
create table if not exists public.fleet_mapping_mail_settings_history (
 id uuid primary key default gen_random_uuid(),company_id uuid not null references public.companies(id),
 actor_id uuid references public.profiles(id),before_config jsonb,after_config jsonb not null,created_at timestamptz not null default now()
);
create table if not exists public.fleet_mapping_mail_logs (
 id uuid primary key default gen_random_uuid(),company_id uuid not null references public.companies(id),
 report_date date not null,slot text not null check(slot in ('introduction','daily','reminder')),
 recipient_email text not null,station_codes text[] not null default '{}',pending_vehicle_days integer not null default 0,
 status text not null check(status in ('sending','sent','failed','uncertain')),
 message_id text not null,root_message_id text not null,subject text not null,
 error_message text,created_at timestamptz not null default now(),sent_at timestamptz,
 unique(company_id,report_date,slot,recipient_email)
);
create index if not exists fleet_mapping_mail_thread_idx on public.fleet_mapping_mail_logs(company_id,recipient_email,created_at desc);
alter table public.fleet_mapping_mail_settings enable row level security;
alter table public.fleet_mapping_mail_settings_history enable row level security;
alter table public.fleet_mapping_mail_logs enable row level security;
revoke all on public.fleet_mapping_mail_settings,public.fleet_mapping_mail_settings_history,public.fleet_mapping_mail_logs from anon,authenticated;
grant all on public.fleet_mapping_mail_settings,public.fleet_mapping_mail_settings_history,public.fleet_mapping_mail_logs to service_role;
create or replace function public.fleet_mapping_mail_settings_history_fn() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 insert into public.fleet_mapping_mail_settings_history(company_id,actor_id,before_config,after_config)
 values(new.company_id,new.updated_by,case when tg_op='UPDATE' then old.config else null end,new.config);
 return new;
end;$$;
drop trigger if exists fleet_mapping_mail_settings_history on public.fleet_mapping_mail_settings;
create trigger fleet_mapping_mail_settings_history after insert or update on public.fleet_mapping_mail_settings for each row execute function public.fleet_mapping_mail_settings_history_fn();
