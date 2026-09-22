-- Additive rollout: no request approval, amount or payment state is changed.
alter table public.payment_notification_templates add column if not exists reminder_work_hours jsonb not null default '{"timezone":"Asia/Kolkata","start":"09:00","end":"18:00","days":[0,1,2,3,4,5,6]}'::jsonb;
alter table public.payment_notification_threads add column if not exists last_message_id text;
alter table public.payment_notification_threads add column if not exists subject text;
alter table public.payment_notification_threads add column if not exists lock_token uuid;
alter table public.payment_notification_threads add column if not exists locked_until timestamptz;
alter table public.payment_notification_threads enable row level security;
create table if not exists public.payment_email_attempts (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
 request_id uuid not null references public.payment_requests(id), event_type text not null,
 recipients text[] not null default '{}', message_id text, subject text,
 status text not null check (status in ('sending','accepted','failed','uncertain')),
 error_message text, created_at timestamptz not null default now(), sent_at timestamptz
);
alter table public.payment_email_attempts enable row level security;
revoke all on public.payment_email_attempts from anon, authenticated;
grant all on public.payment_email_attempts to service_role;
create policy payment_email_attempts_service_only on public.payment_email_attempts for all to service_role using (true) with check (true);
grant all on public.payment_notification_threads to service_role;
create index if not exists payment_email_attempts_request_time on public.payment_email_attempts(company_id,request_id,created_at desc);

create or replace function public.claim_payment_email_thread(p_company uuid,p_location uuid,p_month date,p_token uuid,p_subject text)
returns setof public.payment_notification_threads language plpgsql security invoker set search_path = '' as $$
begin
 if not exists(select 1 from public.stations where id=p_location and company_id=p_company) then
   raise exception 'Station does not belong to company';
 end if;
 insert into public.payment_notification_threads(company_id,location_id,thread_month,message_id,subject)
 values(p_company,p_location,p_month,'<dropx.payment.station.'||p_company||'.'||p_location||'.'||p_month||'@partner.dropxlogistics.com>',p_subject)
 on conflict(company_id,location_id,thread_month) do nothing;
 return query update public.payment_notification_threads set lock_token=p_token,locked_until=now()+interval '2 minutes'
 where company_id=p_company and location_id=p_location and thread_month=p_month
 and (locked_until is null or locked_until<now()) returning *;
end $$;
revoke all on function public.claim_payment_email_thread(uuid,uuid,date,uuid,text) from public,anon,authenticated;
grant execute on function public.claim_payment_email_thread(uuid,uuid,date,uuid,text) to service_role;
