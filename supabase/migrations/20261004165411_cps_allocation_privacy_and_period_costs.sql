-- Configurable People inclusion. Unknown roles are excluded until configured.
create table public.ops_cps_people_policies (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
 designation_code text not null, designation_name text not null,
 mode text not null check(mode in ('excluded','home','managed')),
 head text not null check(head in ('DA','UTR','Van','Overhead')),
 label text not null, allocation text not null check(allocation in ('equal','delivery_share')),
 effective_from date not null, updated_at timestamptz not null default now(), updated_by uuid,
 unique(company_id,designation_code,effective_from)
);
insert into public.ops_cps_people_policies(company_id,designation_code,designation_name,mode,head,label,allocation,effective_from)
select company_id,code,name,
 case when code in ('CLM','AOM','RM','CM','TC') then 'managed'
      when code in ('TL','SSA','SIC','SM','SRSM','DA','DCD','ODCD','WM','PTDA','DR') then 'home' else 'excluded' end,
 case when code='DR' then 'Van' when code in ('DA','DCD','ODCD','WM','PTDA') then 'DA' else 'UTR' end,
 case when code='TC' then 'Telecaller share' when code in ('CLM','AOM','RM','CM') then 'Manager share'
      when code='DR' then 'Van driver CTC' when code in ('DA','DCD','ODCD','WM','PTDA') then 'Salary / minimum guarantee'
      else 'Station staff CTC' end,'equal','2026-09-01'
from public.designations where company_id is not null;

create table public.ops_cps_expense_policies (
 id uuid primary key default gen_random_uuid(),company_id uuid not null references public.companies(id),
 cost_label text not null,mode text not null check(mode in ('transaction','monthly')),
 effective_from date not null,updated_at timestamptz not null default now(),updated_by uuid,
 unique(company_id,cost_label,effective_from),check(cost_label=lower(trim(cost_label)))
);
insert into public.ops_cps_expense_policies(company_id,cost_label,mode,effective_from)
select c.id,label,'monthly','2026-09-01' from public.companies c cross join
(values ('electricity bill'),('broadband expenses'),('broadband charge'),('water bill')) v(label);

create table public.ops_cps_expense_periods (
 company_id uuid not null references public.companies(id),source text not null check(source in ('payment','cashbook')),
 source_id uuid not null,period_from date not null,period_to date not null,
 reason text not null,updated_by uuid,updated_at timestamptz not null default now(),
 primary key(company_id,source,source_id),check(period_to>=period_from and period_to-period_from<=366)
);
-- Private server-side configuration; routes enforce company, location, and edit permission.
alter table public.ops_cps_people_policies enable row level security;
alter table public.ops_cps_expense_policies enable row level security;
alter table public.ops_cps_expense_periods enable row level security;
revoke all on public.ops_cps_people_policies,public.ops_cps_expense_policies,public.ops_cps_expense_periods from anon,authenticated;
grant select,insert,update on public.ops_cps_people_policies,public.ops_cps_expense_policies,public.ops_cps_expense_periods to service_role;

create function public.ops_cps_period_expenses(p_company uuid,p_from date,p_through date,p_stations text[])
returns jsonb language sql stable security invoker set search_path='' as $$
with approved as materialized (
 select r.id,r.work_date,r.request_no,r.utr,r.utr_cin,r.payment_reference,s.station_code,h.name label,
 case when upper(h.code||'_'||h.name) ~ 'VAN|VEHICLE|DRIVER' then 'Van' when upper(h.code||'_'||h.name) ~ 'ADHOC|AD_HOC|SPOT_MANPOWER' then 'DA' else 'Other' end head,
 coalesce(r.amount_approved,r.amount,r.amount_requested,0) amount
 from public.payment_requests r join public.payment_heads h on h.id=r.payment_head_id and h.company_id=p_company
 join public.stations s on s.company_id=p_company and (case when r.location_id is not null then s.id=r.location_id
 else s.station_code=upper(trim(coalesce(nullif(r.station_code,''),r.location_code))) end)
 where r.company_id=p_company and r.work_date<=(now() at time zone 'Asia/Kolkata')::date
 and upper(h.code||'_'||h.name) !~ 'ADVANCE|SALARY|DEPOSIT'
 and lower(coalesce(r.category,'')) not like '%advance%'
 and not (upper(h.code||'_'||h.name) ~ 'STATION_RENT|OFFICE_RENT|PREMISE_RENT'
 and exists(select 1 from public.finance_rent_master rent where rent.company_id=p_company and rent.allocation_station_code=s.station_code and rent.deleted_at is null and r.work_date between rent.effective_from and coalesce(rent.effective_to,r.work_date)))
 and upper(coalesce(r.status,'')) not in ('REJECTED','RETURNED','CANCELLED')
 and upper(coalesce(r.approval_status,'')) not in ('REJECTED','RETURNED','CANCELLED')
 and (upper(coalesce(r.status,'')) in ('FINAL_APPROVED','PROCESSING','PROCESSED','PAID')
 or upper(coalesce(r.approval_status,'')) in ('FINAL_APPROVED','PROCESSING','PROCESSED','PAID')
 or ((upper(coalesce(r.approval_status,'')) in ('APPROVED','RE_APPROVED') or upper(coalesce(r.status,'')) in ('APPROVED','RE_APPROVED'))
 and r.current_approver_user_id is null and r.current_approver_role_id is null and coalesce(cardinality(r.current_approver_role_ids),0)=0))
), expenses as (
 select 'payment' source,a.id source_id,a.station_code,a.label,a.request_no reference,a.amount,a.work_date booked_on,a.head
 from approved a where a.station_code=any(p_stations)
 union all
 select 'cashbook',c.id,c.station_code,coalesce(nullif(c.cps_sub_head,''),nullif(c.category,''),'Other operating expense'),c.id::text,c.amount,c.expense_date,
 case when lower(c.category) like '%generator%' then 'Other' when lower(c.category) in ('van adhoc','van fuel expenses','vehicle maintanance expenses') then 'Van' else case c.cps_head when 'DA Variable CPS' then 'DA' when 'UTR CPS' then 'UTR' when 'VAN CPS' then 'Van' else 'Other' end end
 from public.cps_cashbook_daily c where c.company_id=p_company and c.station_code=any(p_stations)
 and c.expense_date<=(now() at time zone 'Asia/Kolkata')::date
 and not (lower(trim(coalesce(nullif(c.cps_sub_head,''),c.category,''))) in ('station rent','office rent','premise rent')
 and exists(select 1 from public.finance_rent_master rent where rent.company_id=p_company and rent.allocation_station_code=c.station_code and rent.deleted_at is null and c.expense_date between rent.effective_from and coalesce(rent.effective_to,c.expense_date)))
 and not exists(select 1 from approved a where
 nullif(upper(trim(a.request_no)),'') in (upper(trim(coalesce(c.remarks,''))),upper(trim(coalesce(c.raw_payload->>'Payment Request',''))),upper(trim(coalesce(c.raw_payload->>'Payment Request No',''))),upper(trim(coalesce(c.raw_payload->>'Request No',''))),upper(trim(coalesce(c.raw_payload->>'Remark',''))))
 or nullif(trim(c.raw_payload->>'UPI Ref No'),'') in (nullif(trim(a.utr),''),nullif(trim(a.utr_cin),''),nullif(trim(a.payment_reference),''))
 or nullif(trim(c.raw_payload->>'Txn Id'),'')=nullif(trim(a.payment_reference),''))
), dated as (
 select e.*,coalesce(p.period_from,date_trunc('month',e.booked_on)::date) period_from,
 coalesce(p.period_to,(date_trunc('month',e.booked_on)+interval '1 month - 1 day')::date) period_to,
 p.source_id is not null confirmed
 from expenses e
 join lateral (select mode from public.ops_cps_expense_policies policy where policy.company_id=p_company
 and policy.cost_label=lower(trim(e.label)) and policy.effective_from<=e.booked_on order by effective_from desc limit 1) policy on policy.mode='monthly'
 left join public.ops_cps_expense_periods p on p.company_id=p_company and p.source=e.source and p.source_id=e.source_id
)
select coalesce(jsonb_agg(d order by d.station_code,d.booked_on,d.source_id),'[]'::jsonb) from dated d
where d.period_from<=p_through and d.period_to>=p_from;
$$;
revoke all on function public.ops_cps_period_expenses(uuid,date,date,text[]) from public,anon,authenticated;
grant execute on function public.ops_cps_period_expenses(uuid,date,date,text[]) to service_role;

-- All approved operating heads, with bank-reference de-duplication against cashbook.
CREATE OR REPLACE FUNCTION public.ops_cps_base_v2(p_company uuid, p_from date, p_through date, p_stations text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
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
  ), approved_requests as materialized (
    select p.station_code,r.work_date,r.request_no,r.utr,r.utr_cin,r.payment_reference,
      case when upper(h.code||'_'||h.name) ~ 'VAN|VEHICLE|DRIVER' then 'Van'
        when upper(h.code||'_'||h.name) ~ 'ADHOC|AD_HOC|SPOT_MANPOWER' then 'DA' else 'Other' end head,
      h.name sub_head,coalesce(r.amount_approved,r.amount,r.amount_requested,0) amount
    from public.payment_requests r join public.payment_heads h on h.id=r.payment_head_id and h.company_id=p_company
    join public.stations p on p.company_id=p_company and (case when r.location_id is not null then p.id=r.location_id
      else p.station_code=upper(trim(coalesce(nullif(r.station_code,''),r.location_code))) end)
    where r.company_id=p_company and r.work_date<=(now() at time zone 'Asia/Kolkata')::date
      and upper(h.code||'_'||h.name) !~ 'ADVANCE|SALARY|DEPOSIT'
      and lower(coalesce(r.category,'')) not like '%advance%'
      and not (upper(h.code||'_'||h.name) ~ 'STATION_RENT|OFFICE_RENT|PREMISE_RENT'
        and exists(select 1 from public.finance_rent_master rent where rent.company_id=p_company
          and rent.allocation_station_code=p.station_code and rent.deleted_at is null
          and r.work_date between rent.effective_from and coalesce(rent.effective_to,r.work_date)))
      and upper(coalesce(r.status,'')) not in ('REJECTED','RETURNED','CANCELLED')
      and upper(coalesce(r.approval_status,'')) not in ('REJECTED','RETURNED','CANCELLED')
      and (upper(coalesce(r.status,'')) in ('FINAL_APPROVED','PROCESSING','PROCESSED','PAID')
        or upper(coalesce(r.approval_status,'')) in ('FINAL_APPROVED','PROCESSING','PROCESSED','PAID')
        or ((upper(coalesce(r.approval_status,'')) in ('APPROVED','RE_APPROVED') or upper(coalesce(r.status,'')) in ('APPROVED','RE_APPROVED'))
          and r.current_approver_user_id is null and r.current_approver_role_id is null
          and coalesce(cardinality(r.current_approver_role_ids),0)=0))
  ), inputs as materialized (
    select i.* from public.ops_cps_cost_inputs i where i.company_id=p_company and i.is_active and i.employee_id is null
      and i.station_codes && p_stations and i.effective_from<=p_through and coalesce(i.effective_to,p_through)>=p_from
  ), input_volumes as (
    -- The denominator includes the input's whole allocation group, never just
    -- the viewer's station filter. Month weights are shared across all views.
    select i.id,s.station_code,s.work_date,sum(s.total_delivery) volume
    from inputs i join public.cps_shipment_daily s on s.company_id=p_company and s.station_code=any(i.station_codes)
      and s.work_date between p_from and p_through
    group by i.id,s.station_code,s.work_date
  ), input_days as materialized (
    select i.id,i.head,coalesce(nullif(i.sub_head,''),i.label) label,c.station_code,c.work_date,
      (case when i.frequency='once' then i.amount else
        round(i.amount*extract(day from c.work_date)/extract(day from (date_trunc('month',c.work_date)+interval '1 month - 1 day')),2)
        -round(i.amount*(extract(day from c.work_date)-1)/extract(day from (date_trunc('month',c.work_date)+interval '1 month - 1 day')),2) end)
      * (case when i.allocation='delivery_share' and coalesce(v.total,0)>0 then coalesce(s.volume,0)/v.total
        else 1::numeric/cardinality(i.station_codes) end) amount
    from inputs i join calendar c on c.station_code=any(i.station_codes)
      and c.work_date>=i.effective_from and c.work_date<=coalesce(i.effective_to,p_through)
      and (i.frequency='monthly' or c.work_date=i.effective_from)
    left join input_volumes s on s.id=i.id and s.station_code=c.station_code and s.work_date=c.work_date
    left join (select id,work_date,sum(volume) total from input_volumes group by id,work_date) v on v.id=i.id and v.work_date=c.work_date
  ), booked_ledger as materialized (
    select station_code,work_date,'DA' head,'Associate payout' sub_head,'Shipment payment mapping' source,da amount from shipments
    union all select f.station_code,f.transaction_date,'Van',case when upper(f.provider) in ('IOC','IOCL') then 'IOCL fuel' else f.provider||' fuel' end,'Fuel import',sum(f.amount)
      from public.cps_fuel_daily f join places p using(station_code) where f.company_id=p_company
      and f.transaction_date between p_from and p_through group by f.station_code,f.transaction_date,f.provider
    union all select c.station_code,c.expense_date,
      case when lower(c.category) like '%generator%' then 'Other'
        when lower(c.category) in ('van adhoc','van fuel expenses','vehicle maintanance expenses') then 'Van'
        else case c.cps_head when 'DA Variable CPS' then 'DA' when 'UTR CPS' then 'UTR' when 'VAN CPS' then 'Van' else 'Other' end end,
      coalesce(nullif(c.cps_sub_head,''),nullif(c.category,''),'Other operating expense'),'Cashbook',sum(c.amount)
      from public.cps_cashbook_daily c join places p using(station_code)
      where c.company_id=p_company and c.expense_date between p_from and p_through
      -- A settled cashbook record with the same request or bank reference is
      -- the same expense, even when its import date or station alias differs.
      and not exists(select 1 from approved_requests a where
        (nullif(upper(trim(a.request_no)),'') in
          (upper(trim(coalesce(c.remarks,''))),upper(trim(coalesce(c.raw_payload->>'Payment Request',''))),
           upper(trim(coalesce(c.raw_payload->>'Payment Request No',''))),upper(trim(coalesce(c.raw_payload->>'Request No',''))),upper(trim(coalesce(c.raw_payload->>'Remark','')))))
        or nullif(trim(c.raw_payload->>'UPI Ref No'),'') in (nullif(trim(a.utr),''),nullif(trim(a.utr_cin),''),nullif(trim(a.payment_reference),''))
        or nullif(trim(c.raw_payload->>'Txn Id'),'')=nullif(trim(a.payment_reference),''))
      and not (lower(trim(coalesce(c.cps_sub_head,c.category,''))) in ('station rent','office rent','premise rent')
        and exists(select 1 from rents r where r.station_code=c.station_code and r.work_date=c.expense_date))
      group by c.station_code,c.expense_date,c.cps_head,c.category,coalesce(nullif(c.cps_sub_head,''),nullif(c.category,''),'Other operating expense')
    union all select station_code,work_date,head,sub_head,'Approved payment requests',sum(amount) from approved_requests where station_code=any(p_stations) and work_date between p_from and p_through group by station_code,work_date,head,sub_head
    union all select station_code,work_date,'Rent','Facility rent and maintenance','Finance Rent Master',amount from rents
    union all select station_code,work_date,head,label,'CPS Inputs',amount from input_days
  ), ledger as materialized (
    select b.* from booked_ledger b
    where b.source not in ('Cashbook','Approved payment requests') or coalesce((
      select policy.mode from public.ops_cps_expense_policies policy where policy.company_id=p_company
      and policy.cost_label=lower(trim(b.sub_head)) and policy.effective_from<=b.work_date
      order by policy.effective_from desc limit 1),'transaction')<>'monthly'
    union all
    select e.station_code,d::date,e.head,e.label,
      case e.source when 'payment' then 'Approved payment requests' else 'Cashbook' end,
      round(e.amount*((d::date-e.period_from)+1)/(e.period_to-e.period_from+1),2)
       -round(e.amount*(d::date-e.period_from)/(e.period_to-e.period_from+1),2)
    from jsonb_to_recordset(public.ops_cps_period_expenses(p_company,p_from,p_through,p_stations))
      e(station_code text,label text,source text,amount numeric,period_from date,period_to date,head text)
    cross join lateral generate_series(greatest(p_from,e.period_from),least(p_through,e.period_to),interval '1 day') d
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
    'source_dates',jsonb_build_object(
      'shipments',(select max(s.work_date) from public.cps_shipment_daily s where s.company_id=p_company and s.station_code=any(p_stations) and s.work_date<=p_through),
      'fuel',(select max(f.transaction_date) from public.cps_fuel_daily f where f.company_id=p_company and f.station_code=any(p_stations) and f.transaction_date<=p_through),
      'cashbook',(select max(c.expense_date) from public.cps_cashbook_daily c where c.company_id=p_company and c.station_code=any(p_stations) and c.expense_date<=p_through)),
    'generated_at',now()) into result;
  return result;
end; $function$;

create table public.ops_cps_configuration_changes (
 id uuid primary key default gen_random_uuid(),company_id uuid not null references public.companies(id),
 configuration_table text not null,before_values jsonb,after_values jsonb not null,
 actor_id uuid,changed_at timestamptz not null default now()
);
create index ops_cps_configuration_changes_company_idx on public.ops_cps_configuration_changes(company_id,changed_at desc);
alter table public.ops_cps_configuration_changes enable row level security;
revoke all on public.ops_cps_configuration_changes from anon,authenticated;
grant select,insert on public.ops_cps_configuration_changes to service_role;
create function public.ops_cps_record_configuration_change() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 insert into public.ops_cps_configuration_changes(company_id,configuration_table,before_values,after_values,actor_id)
 values(new.company_id,tg_table_name,case when tg_op='UPDATE' then to_jsonb(old) else null end,to_jsonb(new),new.updated_by);
 return new;
end;$$;
revoke all on function public.ops_cps_record_configuration_change() from public,anon,authenticated;
create trigger cps_people_configuration_change after insert or update on public.ops_cps_people_policies for each row execute function public.ops_cps_record_configuration_change();
create trigger cps_expense_configuration_change after insert or update on public.ops_cps_expense_policies for each row execute function public.ops_cps_record_configuration_change();
create trigger cps_period_configuration_change after insert or update on public.ops_cps_expense_periods for each row execute function public.ops_cps_record_configuration_change();
