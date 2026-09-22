-- Finance-only additions. Existing operational facts and payment records are read-only.
create table public.finance_pricing_revisions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  provider text not null check (provider in ('Amazon', 'Flipkart')),
  station_code text not null check (station_code ~ '^[A-Z0-9_-]{1,40}$'),
  effective_month date not null check (extract(day from effective_month) = 1),
  revision integer not null check (revision > 0),
  rates jsonb not null default '{}'::jsonb,
  slabs jsonb not null default '[]'::jsonb,
  slab_mode text not null default 'progressive' check (slab_mode in ('progressive','all_units')),
  reason text not null,
  source_file text,
  source_sha256 text,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique(company_id, provider, station_code, effective_month, revision)
);
alter table public.finance_pricing_revisions enable row level security;
revoke all on public.finance_pricing_revisions from anon, authenticated;
grant select, insert on public.finance_pricing_revisions to service_role;
-- No UPDATE/DELETE API: edits are immutable revisions, including the original source values.
create function public.finance_pricing_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin raise exception 'Pricing history is immutable; create a new revision.'; end;
$$;
create trigger finance_pricing_no_rewrite before update or delete on public.finance_pricing_revisions
for each row execute function public.finance_pricing_immutable();
revoke all on function public.finance_pricing_immutable() from public, anon, authenticated;

create function public.finance_save_pricing(p_company uuid, p_actor uuid, p_items jsonb)
returns integer language plpgsql security invoker set search_path = '' as $$
declare item jsonb; current_revision integer; item_month date; saved integer := 0;
begin
  if p_company is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 500 then
    raise exception 'Invalid pricing import.';
  end if;
  -- Serializes the whole batch. Any stale revision or invalid record rolls back every row.
  perform pg_advisory_xact_lock(hashtextextended('finance-pricing:' || p_company::text, 0));
  for item in select value from jsonb_array_elements(p_items) loop
    item_month := (item->>'effective_month')::date;
    if item_month is null or extract(day from item_month) <> 1 or
      coalesce(item->>'reason','') = '' or length(item->>'reason') > 500 or
      jsonb_typeof(item->'rates') <> 'object' or jsonb_typeof(item->'slabs') <> 'array' then
      raise exception 'Invalid pricing fields.';
    end if;
    select coalesce(max(revision),0) into current_revision from public.finance_pricing_revisions
      where company_id=p_company and provider=item->>'provider' and station_code=item->>'station_code' and effective_month=item_month;
    if current_revision <> coalesce((item->>'expected_revision')::integer,-1) then
      raise exception 'Pricing changed or already exists for %. Refresh and review the latest revision.', item->>'station_code';
    end if;
    insert into public.finance_pricing_revisions(company_id,provider,station_code,effective_month,revision,rates,slabs,slab_mode,reason,source_file,source_sha256,created_by)
    values(p_company,item->>'provider',item->>'station_code',item_month,current_revision+1,item->'rates',item->'slabs',item->>'slab_mode',item->>'reason',item->>'source_file',item->>'source_sha256',p_actor);
    saved := saved + 1;
  end loop;
  return saved;
end;
$$;
revoke all on function public.finance_save_pricing(uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.finance_save_pricing(uuid,uuid,jsonb) to service_role;

-- Aggregates at the database, without the API's 1,000-row truncation.
create function public.finance_business_snapshot(p_company uuid, p_from date, p_through date, p_station_codes text[])
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
begin
  if p_company is null or p_from is null or p_through is null or extract(day from p_from) <> 1
    or p_through < p_from or date_trunc('month',p_through) <> p_from
    or p_through > (now() at time zone 'Asia/Kolkata')::date then
    raise exception 'Choose a billing month and a through date no later than today.';
  end if;
  return jsonb_build_object(
    'shipments',coalesce((select jsonb_agg(to_jsonb(s)) from (
      select station_code, client, count(distinct work_date) as days, min(work_date) as first_date, max(work_date) as last_date,
        sum(total_delivery)::text as deliveries, sum(mfn)::text as mfn, sum(c_return)::text as returns,
        count(*) filter(where total_delivery is null) as missing_delivery_rows, max(updated_at) as updated_at
      from public.cps_shipment_daily where company_id=p_company and work_date between p_from and p_through
        and (p_station_codes is null or station_code=any(p_station_codes)) group by station_code,client
    ) s),'[]'::jsonb),
    'costs',coalesce((select jsonb_agg(to_jsonb(c)) from (
      select station_code, count(*) as days, min(work_date) as first_date, max(work_date) as last_date,
        count(*) filter(where total_cost is null) as missing_cost_rows,
        sum(total_cost)::text as total, sum(da_pay_cost)::text as da, sum(staff_cost)::text as staff,
        sum(fuel_cost)::text as fuel, sum(vehicle_cost)::text as vehicle, sum(rent_cost)::text as rent,
        sum(other_cost)::text as other, sum(utr_cost)::text as utr, sum(van_cost)::text as van,
        max(updated_at) as updated_at
      from public.cps_station_daily where company_id=p_company and work_date between p_from and p_through
        and (p_station_codes is null or station_code=any(p_station_codes)) group by station_code
    ) c),'[]'::jsonb), 'read_at',now());
end;
$$;
revoke all on function public.finance_business_snapshot(uuid,date,date,text[]) from public, anon, authenticated;
grant execute on function public.finance_business_snapshot(uuid,date,date,text[]) to service_role;

-- Add Finance permissions only to companies and roles already configured for Finance.
insert into public.app_pages(company_id,code,name,sort_order,is_active)
select distinct m.company_id,p.code,p.name,p.sort_order,true
from public.company_product_memberships m cross join (values
 ('finance_pricing','Pricing Master',110),('finance_revenue','Revenue & Billing',111),('finance_pnl','Profit & Loss',112)
) p(code,name,sort_order) where lower(m.product_code)='finance'
on conflict(company_id,code) do nothing;
insert into public.role_page_permissions(company_id,role_id,page_id,can_view,can_add,can_edit)
select distinct m.company_id,m.role_id,target.id,source.can_view,
  case when target.code='finance_pricing' then source.can_add else false end,
  case when target.code='finance_pricing' then source.can_edit else false end
from public.company_product_memberships m
join public.app_pages target on target.company_id=m.company_id and target.code in ('finance_pricing','finance_revenue','finance_pnl')
join public.app_pages existing on existing.company_id=m.company_id and existing.code=case when target.code='finance_pricing' then 'master_payment_heads' else 'payment_reports' end
join public.role_page_permissions source on source.company_id=m.company_id and source.role_id=m.role_id and source.page_id=existing.id
where lower(m.product_code)='finance' and m.is_active and m.role_id is not null
on conflict(company_id,role_id,page_id) do nothing;
