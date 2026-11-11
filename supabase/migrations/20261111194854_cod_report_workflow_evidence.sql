-- Private operational evidence. Never expose cash/route history to browser clients.
create table if not exists public.report_bot_cod_observations (
 company_id uuid not null, location_id uuid not null, observed_at timestamptz not null,
 payload jsonb not null, primary key(company_id,location_id,observed_at)
);
create table if not exists public.report_bot_cod_route_cache (
 company_id uuid not null, location_id uuid not null, business_date date not null,
 cache_key text not null, payload jsonb not null, expires_at timestamptz not null,
 primary key(company_id,location_id,business_date,cache_key)
);
alter table public.report_bot_cod_observations enable row level security;
alter table public.report_bot_cod_route_cache enable row level security;
revoke all on public.report_bot_cod_observations,public.report_bot_cod_route_cache from public,anon,authenticated;
grant select,insert,update,delete on public.report_bot_cod_observations,public.report_bot_cod_route_cache to service_role;
alter table public.report_bot_lm_dispatch_routes add column if not exists cod_workflow boolean not null default false;
comment on column public.report_bot_lm_dispatch_routes.cod_workflow is 'Combined, station-scoped COD workflow: data image and action caption. Replaces separate recon/deposit/bank routes.';
alter table public.report_bot_lm_dispatch_routes add column if not exists cod_route_service_url text;
alter table public.report_bot_lm_dispatch_routes add column if not exists cod_reconciliation_allowance_minutes integer not null default 15 check(cod_reconciliation_allowance_minutes between 5 and 60);
create index if not exists report_bot_cod_observations_retention on public.report_bot_cod_observations(observed_at);
create index if not exists report_bot_cod_route_cache_retention on public.report_bot_cod_route_cache(expires_at);
-- Bounded operational retention; scheduling happens in the backend, not ChatGPT.
create or replace function public.purge_cod_report_evidence() returns void language sql security invoker set search_path=public,pg_temp as $$
 delete from public.report_bot_cod_observations where observed_at < now()-interval '8 days';
 delete from public.report_bot_cod_route_cache where expires_at < now()-interval '1 day';
$$;
revoke all on function public.purge_cod_report_evidence() from public,anon,authenticated;
grant execute on function public.purge_cod_report_evidence() to service_role;

create table if not exists public.cod_shortfall_ledger (
 id uuid primary key default gen_random_uuid(), company_id uuid not null, location_id uuid not null,
 remittance_id text not null, remittance_code text not null, deposit_date date not null,
 expected_amount numeric(14,2) not null check(expected_amount>=0), deposited_amount numeric(14,2) not null check(deposited_amount>=0),
 original_short numeric(14,2) not null check(original_short>10), recovered_amount numeric(14,2) not null default 0,
 remaining_amount numeric(14,2) generated always as (greatest(0,least(original_short,last_source_short)-recovered_amount)) stored,
 last_source_short numeric(14,2) not null, last_source_at timestamptz not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check(recovered_amount>=0 and recovered_amount<=original_short), unique(company_id,location_id,remittance_id)
);
create index if not exists cod_shortfall_ledger_open on public.cod_shortfall_ledger(company_id,location_id,deposit_date) where recovered_amount<original_short;
create table if not exists public.cod_shortfall_recoveries (
 id uuid primary key default gen_random_uuid(), ledger_id uuid not null references public.cod_shortfall_ledger(id),
 company_id uuid not null, location_id uuid not null, submission_id uuid not null references public.cod_submissions(id),
 amount numeric(14,2) not null check(amount>0), note text not null check(length(note) between 8 and 300),
 receipt_snapshot jsonb not null,
 recorded_by uuid not null, recorded_by_name text not null, created_at timestamptz not null default now(),
 unique(ledger_id,submission_id)
);
alter table public.cod_shortfall_ledger enable row level security;
alter table public.cod_shortfall_recoveries enable row level security;
revoke all on public.cod_shortfall_ledger,public.cod_shortfall_recoveries from public,anon,authenticated;
grant select,insert,update on public.cod_shortfall_ledger to service_role;
grant select,insert on public.cod_shortfall_recoveries to service_role;
alter table public.report_bot_lm_dispatch_routes add column if not exists cod_shortfall_lead_minutes integer not null default 60 check(cod_shortfall_lead_minutes between 30 and 60);
alter table public.report_bot_lm_dispatch_routes add column if not exists cod_shortfalls_since date not null default (now() at time zone 'Asia/Kolkata')::date;

-- The server first verifies the reviewer, company and station scope. Row locks
-- prevent concurrent recoveries from allocating the same receipt amount twice.
create or replace function public.record_cod_shortfall_recovery(p_company uuid,p_ledger uuid,p_submission uuid,p_amount numeric,p_note text,p_actor uuid,p_actor_name text)
returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare l public.cod_shortfall_ledger; s public.cod_submissions; used numeric; result uuid;
begin
 select * into l from public.cod_shortfall_ledger where id=p_ledger and company_id=p_company for update;
 if not found then raise exception 'Short deposit not found'; end if;
 select * into s from public.cod_submissions where id=p_submission and company_id=p_company and location_id=l.location_id for update;
 if not found then raise exception 'Recovery slip must belong to this station'; end if;
 if s.returned_at is not null or s.ai_status is distinct from 'Valid' or s.deposited_amount is null or s.deposited_amount<=0 or s.deposit_date<l.deposit_date then raise exception 'Use a reviewed valid recovery deposit slip'; end if;
 if not exists(select 1 from jsonb_array_elements(case when jsonb_typeof(s.deposit_slip_attachments)='array' then s.deposit_slip_attachments else '[]'::jsonb end || case when jsonb_typeof(s.attachments)='array' then s.attachments else '[]'::jsonb end) proof where nullif(proof->>'storage_path','') is not null and nullif(proof->>'storage_bucket','') is not null) then raise exception 'Recovery slip proof required'; end if;
 if s.ai_result->>'source' is distinct from 'manual' then raise exception 'Review the recovery proof manually first'; end if;
 if upper(trim(coalesce(s.remittance_code,s.reference_no,'')))=upper(trim(l.remittance_code)) then raise exception 'Original short receipt cannot recover itself'; end if;
 if nullif(trim(coalesce(s.remittance_code,s.reference_no,'')),'') is null then raise exception 'Recovery remittance reference required'; end if;
 if p_actor is null or p_note is null or p_actor_name is null or length(trim(p_note)) not between 8 and 300 or p_amount is null or p_amount<=0 or p_amount<>round(p_amount,2) then raise exception 'Enter an amount and a clear recovery note'; end if;
 select coalesce(sum(amount),0) into used from public.cod_shortfall_recoveries where submission_id=p_submission;
 if p_amount>l.remaining_amount or p_amount>s.deposited_amount-used then raise exception 'Recovery exceeds the outstanding balance or unallocated receipt amount'; end if;
 insert into public.cod_shortfall_recoveries(ledger_id,company_id,location_id,submission_id,amount,note,receipt_snapshot,recorded_by,recorded_by_name)
 values(l.id,p_company,l.location_id,p_submission,p_amount,trim(p_note),jsonb_build_object('proof_version',s.proof_version,'reference',coalesce(s.remittance_code,s.reference_no),'deposit_date',s.deposit_date,'deposited_amount',s.deposited_amount,'attachments',s.deposit_slip_attachments,'legacy_attachments',s.attachments,'review',s.ai_result),p_actor,p_actor_name) returning id into result;
 update public.cod_shortfall_ledger set recovered_amount=recovered_amount+p_amount,updated_at=now() where id=l.id;
 return result;
end $$;
revoke all on function public.record_cod_shortfall_recovery(uuid,uuid,uuid,numeric,text,uuid,text) from public,anon,authenticated;
grant execute on function public.record_cod_shortfall_recovery(uuid,uuid,uuid,numeric,text,uuid,text) to service_role;
