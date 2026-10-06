create table if not exists public.finance_insight_cache(company_id uuid not null references public.companies(id),cache_key text not null,text text not null,created_at timestamptz not null default now(),primary key(company_id,cache_key));
create table if not exists public.finance_insight_requests(company_id uuid not null references public.companies(id),actor_id uuid not null,last_requested_at timestamptz not null default now(),primary key(company_id,actor_id));
alter table public.finance_insight_cache enable row level security;
alter table public.finance_insight_requests enable row level security;
revoke all on public.finance_insight_cache,public.finance_insight_requests from anon,authenticated;
grant all on public.finance_insight_cache,public.finance_insight_requests to service_role;
create or replace function public.finance_claim_insight(p_company uuid,p_actor uuid) returns boolean language plpgsql security definer set search_path=public as $$
declare claimed boolean;begin
 insert into finance_insight_requests(company_id,actor_id,last_requested_at) values(p_company,p_actor,now()) on conflict(company_id,actor_id) do update set last_requested_at=now() where finance_insight_requests.last_requested_at<now()-interval '1 minute' returning true into claimed;
 return coalesce(claimed,false);
end;$$;
revoke all on function public.finance_claim_insight(uuid,uuid) from public,anon,authenticated;
grant execute on function public.finance_claim_insight(uuid,uuid) to service_role;
insert into public.finance_business_master(company_id,kind,key,label,data)
select id,'insight','finance_review','Finance AI review','{"model":"openai/gpt-5.4-mini","enabled":true}'::jsonb from public.companies where name='DROPX LOGISTICS'
on conflict(company_id,kind,key) do nothing;
-- Canonical region codes take precedence over inconsistent legacy state spellings.
with corrected as (
 select m.id,jsonb_set(m.data,'{recipient_codes}',coalesce((select jsonb_agg(s.station_code order by s.station_code) from stations s where s.company_id=m.company_id and s.is_active and not s.is_ho and not coalesce(s.hide_from_location_list,false) and case m.data->>'station_code' when 'HO_KL' then s.region='KL' when 'HO_AP' then s.region='AP' when 'HO_OD' then s.state='Odisha' else false end),'[]')) data
 from finance_business_master m join companies c on c.id=m.company_id where c.name='DROPX LOGISTICS' and m.kind='overhead' and m.data->>'station_code' in ('HO_KL','HO_AP','HO_OD'))
update finance_business_master m set data=c.data,revision=revision+1,updated_at=now() from corrected c where m.id=c.id and m.data is distinct from c.data;
