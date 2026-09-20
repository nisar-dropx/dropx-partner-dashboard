-- Read-time CPS: no browser-side privileged reads, no local scheduler, and no
-- rewriting of payroll/import facts or Finance reports.
create table public.ops_cps_cost_inputs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  label text not null check (length(label) between 1 and 120),
  head text not null check (head in ('DA','UTR','Van','Other')),
  station_codes text[] not null check (cardinality(station_codes) between 1 and 150),
  amount numeric(14,2) not null check (amount >= 0),
  frequency text not null check (frequency in ('monthly','once')),
  allocation text not null default 'equal' check (allocation in ('equal','delivery_share')),
  effective_from date not null,
  effective_to date,
  is_active boolean not null default true,
  notes text check(length(notes) <= 500),
  created_by uuid not null,
  updated_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(effective_to is null or effective_to >= effective_from),
  check(frequency <> 'once' or effective_to is null or effective_to = effective_from)
);
create index ops_cps_cost_inputs_period on public.ops_cps_cost_inputs(company_id,effective_from,effective_to) where is_active;
alter table public.ops_cps_cost_inputs enable row level security;
revoke all on public.ops_cps_cost_inputs from public,anon,authenticated;
grant select,insert,update on public.ops_cps_cost_inputs to service_role;
create table public.ops_cps_cost_input_audit (
  id bigint generated always as identity primary key,
  company_id uuid not null,
  input_id uuid not null references public.ops_cps_cost_inputs(id),
  previous_record jsonb not null,
  changed_by uuid not null,
  changed_at timestamptz not null default now()
);
alter table public.ops_cps_cost_input_audit enable row level security;
revoke all on public.ops_cps_cost_input_audit from public,anon,authenticated;
grant select,insert on public.ops_cps_cost_input_audit to service_role;
grant usage on sequence public.ops_cps_cost_input_audit_id_seq to service_role;
create function public.ops_cps_audit_cost_input() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  insert into public.ops_cps_cost_input_audit(company_id,input_id,previous_record,changed_by)
  values(old.company_id,old.id,to_jsonb(old),new.updated_by);
  new.updated_at := clock_timestamp();
  return new;
end; $$;
revoke all on function public.ops_cps_audit_cost_input() from public,anon,authenticated;
create trigger ops_cps_cost_input_change before update on public.ops_cps_cost_inputs
for each row execute function public.ops_cps_audit_cost_input();

create function public.ops_cps_live_snapshot(p_company uuid,p_from date,p_through date,p_stations text[])
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
  if p_company is null or p_stations is null or cardinality(p_stations)>150
    or p_from is null or p_through is null or p_through<p_from or p_through-p_from>30
    or date_trunc('month',p_from)<>date_trunc('month',p_through)
    or p_through>(now() at time zone 'Asia/Kolkata')::date then
    raise exception 'Choose a valid CPS period (up to one month) and location scope';
  end if;
  with places as materialized (
    select s.station_code,s.id from public.stations s where s.company_id=p_company
      and s.station_code=any(p_stations) and s.is_active and not coalesce(s.hide_from_location_list,false)
  ), calendar as (
    select p.station_code,d::date work_date from places p
    cross join generate_series(p_from,p_through,interval '1 day') d
  ), shipments as materialized (
    select s.station_code,s.work_date,sum(s.total_delivery) deliveries,sum(s.total_activity) activity,
      sum(s.amazon_delivery) amazon_delivery,sum(s.swa_delivery) swa_delivery,
      sum(s.c_return) c_return,sum(s.mfn) mfn,sum(s.mfn_return) mfn_return,
      count(*) associate_rows,
      count(*) filter(where coalesce(s.mapping_status,'')<>'Mapped' and s.total_activity>0) unmapped,
      count(*) filter(where s.mapping_status='Mapped' and s.da_total_pay=0 and s.total_activity>0) unpaid,
      sum(s.da_total_pay) da,max(s.updated_at) updated_at
    from public.cps_shipment_daily s join places p using(station_code)
    where s.company_id=p_company and s.work_date between p_from and p_through
    group by s.station_code,s.work_date
  ), rents as materialized (
    select r.allocation_station_code station_code,d::date work_date,
      sum(round((r.monthly_rent+r.monthly_maintenance)*extract(day from d)/extract(day from (date_trunc('month',d)+interval '1 month - 1 day')),2)
        -round((r.monthly_rent+r.monthly_maintenance)*(extract(day from d)-1)/extract(day from (date_trunc('month',d)+interval '1 month - 1 day')),2)) amount
    from public.finance_rent_master r join places p on p.station_code=r.allocation_station_code
    cross join lateral generate_series(greatest(p_from,r.effective_from),least(p_through,coalesce(r.effective_to,p_through)),interval '1 day') d
    where r.company_id=p_company and r.deleted_at is null
    group by r.allocation_station_code,d
  ), approved_adhoc as materialized (
    select p.station_code,r.work_date,r.request_no,
      case when upper(h.code||'_'||h.name) ~ 'VAN|VEHICLE' then 'Van' else 'DA' end head,
      h.name sub_head,coalesce(r.amount_approved,r.amount,r.amount_requested,0) amount
    from public.payment_requests r join public.payment_heads h on h.id=r.payment_head_id and h.company_id=p_company
    join places p on (case when r.location_id is not null then p.id=r.location_id
      else p.station_code=upper(trim(coalesce(nullif(r.station_code,''),r.location_code))) end)
    where r.company_id=p_company and r.work_date between p_from and p_through
      and upper(h.code||'_'||h.name) ~ 'ADHOC|AD_HOC|SPOT_MANPOWER'
      and upper(h.code||'_'||h.name) ~ 'VAN|VEHICLE|_DA|DRIVER|ASSOCIATE|MANPOWER'
      and upper(coalesce(r.status,'')) not in ('REJECTED','RETURNED','CANCELLED')
      and upper(coalesce(r.approval_status,'')) not in ('REJECTED','RETURNED','CANCELLED')
      and (upper(coalesce(r.status,'')) in ('APPROVED','PROCESSING','PROCESSED','PAID')
        or upper(coalesce(r.approval_status,'')) in ('APPROVED','PROCESSING','PROCESSED','PAID')
        or ((upper(coalesce(r.status,'')) like '%\_APPROVED' or upper(coalesce(r.approval_status,'')) like '%\_APPROVED')
          and r.current_approver_user_id is null and r.current_approver_role_id is null))
  ), inputs as materialized (
    select i.* from public.ops_cps_cost_inputs i where i.company_id=p_company and i.is_active
      and i.station_codes && p_stations and i.effective_from<=p_through and coalesce(i.effective_to,p_through)>=p_from
  ), input_volumes as (
    -- The denominator includes the input's whole allocation group, never just
    -- the viewer's station filter. Month weights are shared across all views.
    select i.id,s.station_code,sum(s.total_delivery) volume
    from inputs i join public.cps_shipment_daily s on s.company_id=p_company and s.station_code=any(i.station_codes)
      and s.work_date between date_trunc('month',p_from)::date
      and least((date_trunc('month',p_from)+interval '1 month - 1 day')::date,(now() at time zone 'Asia/Kolkata')::date)
    group by i.id,s.station_code
  ), input_days as materialized (
    select i.id,i.head,i.label,c.station_code,c.work_date,
      (case when i.frequency='once' then i.amount else
        round(i.amount*extract(day from c.work_date)/extract(day from (date_trunc('month',c.work_date)+interval '1 month - 1 day')),2)
        -round(i.amount*(extract(day from c.work_date)-1)/extract(day from (date_trunc('month',c.work_date)+interval '1 month - 1 day')),2) end)
      * (case when i.allocation='delivery_share' and coalesce(v.total,0)>0 then coalesce(s.volume,0)/v.total
        else 1::numeric/cardinality(i.station_codes) end) amount
    from inputs i join calendar c on c.station_code=any(i.station_codes)
      and c.work_date>=i.effective_from and c.work_date<=coalesce(i.effective_to,p_through)
      and (i.frequency='monthly' or c.work_date=i.effective_from)
    left join input_volumes s on s.id=i.id and s.station_code=c.station_code
    left join (select id,sum(volume) total from input_volumes group by id) v on v.id=i.id
  ), ledger as materialized (
    select station_code,work_date,'DA' head,'Associate payout' sub_head,'Shipment payment mapping' source,da amount from shipments
    union all select f.station_code,f.transaction_date,'Van','Fuel cards','Fuel import',sum(f.amount)
      from public.cps_fuel_daily f join places p using(station_code) where f.company_id=p_company
      and f.transaction_date between p_from and p_through group by f.station_code,f.transaction_date
    union all select c.station_code,c.expense_date,
      case c.cps_head when 'DA Variable CPS' then 'DA' when 'UTR CPS' then 'UTR' when 'VAN CPS' then 'Van' else 'Other' end,
      coalesce(nullif(c.cps_sub_head,''),nullif(c.category,''),'Other operating expense'),'Cashbook',sum(c.amount)
      from public.cps_cashbook_daily c join places p using(station_code)
      where c.company_id=p_company and c.expense_date between p_from and p_through
      and not exists(select 1 from approved_adhoc a where a.request_no is not null
        and a.station_code=c.station_code and upper(trim(a.request_no)) in
        (upper(trim(coalesce(c.remarks,''))),upper(trim(coalesce(c.raw_payload->>'Payment Request',''))),
         upper(trim(coalesce(c.raw_payload->>'Payment Request No',''))),upper(trim(coalesce(c.raw_payload->>'Request No',''))),upper(trim(coalesce(c.raw_payload->>'Remark','')))))
      and not (lower(trim(coalesce(c.cps_sub_head,c.category,''))) in ('station rent','office rent','premise rent')
        and exists(select 1 from rents r where r.station_code=c.station_code and r.work_date=c.expense_date))
      group by c.station_code,c.expense_date,c.cps_head,coalesce(nullif(c.cps_sub_head,''),nullif(c.category,''),'Other operating expense')
    union all select station_code,work_date,head,sub_head,'Approved Adhoc requests',sum(amount) from approved_adhoc group by station_code,work_date,head,sub_head
    union all select station_code,work_date,'Other','Rent and maintenance','Finance Rent Master',amount from rents
    union all select station_code,work_date,head,label,'CPS Inputs',amount from input_days
  ), costs as (
    select station_code,work_date,
      sum(amount) filter(where head='DA') da,sum(amount) filter(where head='UTR') utr,
      sum(amount) filter(where head='Van') van,sum(amount) filter(where head='Other') other,
      sum(amount) filter(where source='Finance Rent Master') rent,sum(amount) total
    from ledger group by station_code,work_date
  ), daily as (
    select c.station_code,c.work_date,coalesce(s.deliveries,0) deliveries,coalesce(s.activity,0) activity,
      coalesce(s.amazon_delivery,0) amazon_delivery,coalesce(s.swa_delivery,0) swa_delivery,
      coalesce(s.c_return,0) c_return,coalesce(s.mfn,0) mfn,coalesce(s.mfn_return,0) mfn_return,
      coalesce(s.associate_rows,0) associate_rows,coalesce(s.unmapped,0) unmapped,coalesce(s.unpaid,0) unpaid,
      coalesce(k.da,0) da,coalesce(k.utr,0) utr,coalesce(k.van,0) van,coalesce(k.other,0) other,
      coalesce(k.rent,0) rent,coalesce(k.total,0) total,t.target_cps target,
      s.station_code is not null shipment_present,
      exists(select 1 from input_days i where i.station_code=c.station_code and i.work_date=c.work_date and i.head='UTR') utr_configured,
      s.updated_at
    from calendar c left join shipments s using(station_code,work_date) left join costs k using(station_code,work_date)
    left join lateral(select target_cps from public.cps_station_targets t where t.company_id=p_company
      and t.station_code=c.station_code and t.is_active and t.effective_from<=c.work_date order by t.effective_from desc limit 1) t on true
  )
  select jsonb_build_object('daily',coalesce((select jsonb_agg(d order by d.work_date,d.station_code) from daily d),'[]'::jsonb),
    'breakup',coalesce((select jsonb_agg(l order by l.work_date,l.station_code,l.head,l.sub_head) from ledger l where l.amount<>0),'[]'::jsonb),
    'generated_at',now()) into result;
  return result;
end; $$;
revoke all on function public.ops_cps_live_snapshot(uuid,date,date,text[]) from public,anon,authenticated;
grant execute on function public.ops_cps_live_snapshot(uuid,date,date,text[]) to service_role;
