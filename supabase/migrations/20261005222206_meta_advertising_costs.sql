-- Actual Meta spend is a daily operating expense, not the daily ad budget.
create table public.ops_advertising_settings (
 company_id uuid primary key references public.companies(id),
 is_enabled boolean not null default true,
 start_date date not null,
 refresh_minutes integer not null default 60 check(refresh_minutes between 30 and 1440),
 cost_label text not null default 'Meta advertising' check(length(cost_label) between 1 and 120),
 updated_at timestamptz not null default now(), updated_by uuid
);
create table public.ops_advertising_months (
 company_id uuid not null references public.companies(id), month date not null,
 account_id text not null, through_date date, synced_at timestamptz,
 last_error text, checked_at timestamptz, lease_until timestamptz,
 primary key(company_id,month), check(extract(day from month)=1)
);
create table public.ops_advertising_daily (
 company_id uuid not null references public.companies(id),account_id text not null,
 spend_date date not null,ad_id text not null,ad_name text not null default '',
 campaign_name text not null default '',spend numeric(16,2) not null check(spend>=0),
 currency text not null check(currency='INR'),synced_at timestamptz not null default now(),
 primary key(company_id,account_id,spend_date,ad_id)
);
create table public.ops_advertising_mappings (
 id uuid primary key default gen_random_uuid(),company_id uuid not null references public.companies(id),
 ad_id text not null,station_code text not null,effective_from date not null,effective_to date,
 updated_at timestamptz not null default now(),updated_by uuid,
 check(effective_to is null or effective_to>=effective_from),
 unique(company_id,ad_id,effective_from)
);
-- Service-only tables: UI actions verify company, station access and CPS Input permission.
alter table public.ops_advertising_settings enable row level security;
alter table public.ops_advertising_months enable row level security;
alter table public.ops_advertising_daily enable row level security;
alter table public.ops_advertising_mappings enable row level security;
revoke all on public.ops_advertising_settings,public.ops_advertising_months,public.ops_advertising_daily,public.ops_advertising_mappings from anon,authenticated;
grant all on public.ops_advertising_settings,public.ops_advertising_months,public.ops_advertising_daily,public.ops_advertising_mappings to service_role;
insert into public.ops_advertising_settings(company_id,start_date)
select m.company_id,coalesce(date_trunc('month',min(a.created_on))::date,date_trunc('month',current_date)::date)
from public.meta_leads_settings m left join public.lead_ads a on a.company_id=m.company_id
where m.is_enabled and m.ad_account_id is not null group by m.company_id
on conflict do nothing;

create function public.ops_replace_advertising_month(p_company uuid,p_account text,p_month date,p_through date,p_rows jsonb)
returns void language plpgsql security invoker set search_path=public as $$
begin
 if p_month<>date_trunc('month',p_month)::date or p_through<p_month or date_trunc('month',p_through)::date<>p_month then raise exception 'Invalid spend period';end if;
 if jsonb_typeof(p_rows)<>'array' then raise exception 'Invalid spend data';end if;
 if exists(select 1 from jsonb_to_recordset(p_rows) x(spend_date date,ad_id text,spend numeric,currency text)
 where spend_date is null or spend_date<p_month or spend_date>p_through or nullif(ad_id,'') is null or spend is null or spend<0 or currency is distinct from 'INR') then raise exception 'Invalid spend row';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_company::text||p_month::text,0));
 delete from ops_advertising_daily where company_id=p_company and spend_date between p_month and p_through;
 insert into ops_advertising_daily(company_id,account_id,spend_date,ad_id,ad_name,campaign_name,spend,currency)
 select p_company,p_account,x.spend_date,x.ad_id,coalesce(x.ad_name,''),coalesce(x.campaign_name,''),x.spend,x.currency
 from jsonb_to_recordset(p_rows) x(spend_date date,ad_id text,ad_name text,campaign_name text,spend numeric,currency text);
 insert into ops_advertising_months(company_id,month,account_id,through_date,synced_at,checked_at,last_error,lease_until)
 values(p_company,p_month,p_account,p_through,now(),now(),null,null)
 on conflict(company_id,month) do update set account_id=excluded.account_id,through_date=excluded.through_date,synced_at=now(),checked_at=now(),last_error=null,lease_until=null;
end $$;
revoke all on function public.ops_replace_advertising_month(uuid,text,date,date,jsonb) from public,anon,authenticated;
grant execute on function public.ops_replace_advertising_month(uuid,text,date,date,jsonb) to service_role;

create function public.ops_claim_advertising_month(p_company uuid,p_account text,p_month date)
returns boolean language plpgsql security invoker set search_path=public as $$
declare claimed boolean;
begin
 insert into ops_advertising_months(company_id,month,account_id,lease_until,checked_at)
 values(p_company,p_month,p_account,now()+interval '10 minutes',now())
 on conflict(company_id,month) do update set lease_until=excluded.lease_until,checked_at=now()
 where ops_advertising_months.lease_until is null or ops_advertising_months.lease_until<now()
 returning true into claimed;
 return coalesce(claimed,false);
end $$;
revoke all on function public.ops_claim_advertising_month(uuid,text,date) from public,anon,authenticated;
grant execute on function public.ops_claim_advertising_month(uuid,text,date) to service_role;
