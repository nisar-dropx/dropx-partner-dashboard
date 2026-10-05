-- Use Fleet's visible rent terms as the current input for the existing dated CPS ledger.
-- Existing historical monthly rates and placement intervals are retained.
alter table public.fleet_vehicle_rent_rates alter column monthly_rent drop not null;
alter table public.fleet_vehicle_rent_rates add column if not exists daily_rent numeric(12,2);
alter table public.fleet_vehicle_rent_rates add constraint fleet_rent_one_period
  check ((monthly_rent is null or daily_rent is null) and (daily_rent is null or daily_rent >= 0));

create or replace function public.fleet_sync_vehicle_rent() returns trigger
language plpgsql set search_path = '' as $$
declare current_rate public.fleet_vehicle_rent_rates%rowtype;
  effective_day date := (now() at time zone 'Asia/Kolkata')::date;
  next_day date;
  monthly numeric := case when new.rent_period='monthly' then new.rent_amount end;
  daily numeric := case when new.rent_period='daily' then new.rent_amount end;
begin
  if tg_op='UPDATE' and new.rent_amount is not distinct from old.rent_amount
    and new.rent_period is not distinct from old.rent_period then return new; end if;
  select * into current_rate from public.fleet_vehicle_rent_rates
    where company_id=new.company_id and vehicle_id=new.id and effective_from<=effective_day
      and coalesce(effective_to,effective_day)>=effective_day order by effective_from desc limit 1;
  if found and current_rate.monthly_rent is not distinct from monthly
    and current_rate.daily_rent is not distinct from daily then return new; end if;
  if current_rate.id is null and monthly is null and daily is null then return new; end if;
  select min(effective_from) into next_day from public.fleet_vehicle_rent_rates
    where company_id=new.company_id and vehicle_id=new.id and effective_from>effective_day;
  update public.fleet_vehicle_rent_rates set effective_to=effective_day-1
    where company_id=new.company_id and vehicle_id=new.id and effective_from<effective_day
      and coalesce(effective_to,effective_day)>=effective_day;
  insert into public.fleet_vehicle_rent_rates(company_id,vehicle_id,monthly_rent,daily_rent,effective_from,effective_to,reason)
    values(new.company_id,new.id,monthly,daily,effective_day,next_day-1,'Vehicle rent updated in Fleet')
    on conflict(company_id,vehicle_id,effective_from) do update set
      monthly_rent=excluded.monthly_rent,daily_rent=excluded.daily_rent,reason=excluded.reason,updated_at=now();
  return new;
end; $$;
create trigger fleet_vehicle_rent_terms after insert or update of rent_amount,rent_period
  on public.fleet_vehicles for each row execute function public.fleet_sync_vehicle_rent();
revoke all on function public.fleet_sync_vehicle_rent() from public, anon, authenticated;
grant execute on function public.fleet_sync_vehicle_rent() to service_role;

-- One shared day-level source for CPS and P&L; only deployed vehicle days accrue.
create or replace function public.fleet_vehicle_rent_daily(p_company uuid,p_from date,p_through date,p_stations text[])
returns table(vehicle_id uuid,vehicle_no text,model text,station_code text,work_date date,
  monthly_rent numeric,daily_rent numeric,amount numeric,updated_at timestamptz)
language sql stable set search_path='' as $$
  select v.id,v.vehicle_no,v.model,p.station_code,d::date,r.monthly_rent,r.daily_rent,
    case when r.daily_rent is not null then r.daily_rent
      when r.monthly_rent is not null then
        round(r.monthly_rent*extract(day from d)/extract(day from (date_trunc('month',d)+interval '1 month - 1 day')),2)
        -round(r.monthly_rent*(extract(day from d)-1)/extract(day from (date_trunc('month',d)+interval '1 month - 1 day')),2)
    end,r.updated_at
  from public.fleet_vehicle_cost_placements p
  join public.fleet_vehicles v on v.company_id=p.company_id and v.id=p.vehicle_id
  join public.stations s on s.company_id=p.company_id and s.station_code=p.station_code
    and s.is_active and not coalesce(s.hide_from_location_list,false)
  cross join lateral generate_series(greatest(p_from,p.effective_from),least(p_through,coalesce(p.effective_to,p_through)),interval '1 day') d
  left join lateral(select * from public.fleet_vehicle_rent_rates r
    where r.company_id=p.company_id and r.vehicle_id=p.vehicle_id
      and r.effective_from<=d::date and coalesce(r.effective_to,d::date)>=d::date
    order by r.effective_from desc limit 1) r on true
  where p.company_id=p_company and (p_stations is null or p.station_code=any(p_stations))
    and p.deployed and p.ownership_type in ('own','rented','leased','odcd');
$$;
revoke all on function public.fleet_vehicle_rent_daily(uuid,date,date,text[]) from public,anon,authenticated;
grant execute on function public.fleet_vehicle_rent_daily(uuid,date,date,text[]) to service_role;

CREATE OR REPLACE FUNCTION public.fleet_save_vehicle_rent(p_company uuid, p_vehicle uuid, p_amount numeric, p_from date, p_reason text, p_actor uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_id uuid; next_date date;
begin
  if p_amount is null or p_amount<0 or p_amount>9999999 or p_amount<>round(p_amount,2) or p_from is null
    or length(trim(coalesce(p_reason,''))) not between 3 and 500 then raise exception 'Enter a valid monthly rent, effective date and reason'; end if;
  perform 1 from public.fleet_vehicles where company_id=p_company and id=p_vehicle for update;
  if not found then raise exception 'Vehicle not found in this company'; end if;
  insert into public.fleet_vehicle_rent_changes(company_id,vehicle_id,effective_from,monthly_rent,previous_rates,reason,changed_by)
  select p_company,p_vehicle,p_from,p_amount,coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb),trim(p_reason),p_actor
  from public.fleet_vehicle_rent_rates r where r.company_id=p_company and r.vehicle_id=p_vehicle;
  select min(effective_from) into next_date from public.fleet_vehicle_rent_rates
    where company_id=p_company and vehicle_id=p_vehicle and effective_from>p_from;
  update public.fleet_vehicle_rent_rates set effective_to=p_from-1
    where company_id=p_company and vehicle_id=p_vehicle and effective_from<p_from and coalesce(effective_to,p_from)>=p_from;
  insert into public.fleet_vehicle_rent_rates(company_id,vehicle_id,monthly_rent,effective_from,effective_to,reason,updated_by)
  values(p_company,p_vehicle,p_amount,p_from,next_date-1,trim(p_reason),p_actor)
  on conflict(company_id,vehicle_id,effective_from) do update set monthly_rent=excluded.monthly_rent,daily_rent=null,
    reason=excluded.reason,updated_by=excluded.updated_by,updated_at=now()
  returning id into v_id;
  if p_from <= (now() at time zone 'Asia/Kolkata')::date
    and (next_date is null or next_date > (now() at time zone 'Asia/Kolkata')::date) then
    update public.fleet_vehicles set rent_amount=p_amount,rent_period='monthly'
      where company_id=p_company and id=p_vehicle;
  end if;
  return v_id;
end; $function$

;

CREATE OR REPLACE FUNCTION public.ops_cps_vehicle_costs(p_company uuid, p_from date, p_through date, p_stations text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare result jsonb;
begin
  if p_company is null or p_stations is null or cardinality(p_stations)>150 or p_from is null or p_through is null
    or p_through<p_from or p_through-p_from>30 or date_trunc('month',p_from)<>date_trunc('month',p_through)
    or p_through>(now() at time zone 'Asia/Kolkata')::date then raise exception 'Invalid CPS scope'; end if;
  with days as materialized (
    select vehicle_id id,vehicle_no,model,station_code,work_date,monthly_rent,daily_rent,amount
    from public.fleet_vehicle_rent_daily(p_company,p_from,p_through,p_stations)
  )
  select jsonb_build_object(
    'breakup',coalesce((select jsonb_agg(jsonb_build_object('station_code',station_code,'work_date',work_date,'head','Van',
      'sub_head','Vehicle rent · '||vehicle_no,'source','Fleet Vehicle Master','amount',amount)) from days where amount is not null),'[]'::jsonb),
    'vehicles',coalesce((select jsonb_agg(t) from (select id vehicle_id,vehicle_no,model,station_code,monthly_rent,daily_rent,
      min(work_date) from_date,max(work_date) through_date,count(*) days,sum(amount) amount
      from days group by id,vehicle_no,model,station_code,monthly_rent,daily_rent)t),'[]'::jsonb),
    'gaps',coalesce((select jsonb_agg(jsonb_build_object('key','vehicle-rent|'||vehicle_no||'|'||station_code,'kind','Vehicle rent missing',
      'station_code',station_code,'provider_id',vehicle_no,'dropx_id','','name',model,'first_date',from_date,'last_date',through_date,
      'days',days,'deliveries',0,'known_cost',0,'owner','Fleet team','href','https://fleet.dropxlogistics.com/?section=attention'))
      from (select vehicle_no,model,station_code,min(work_date) from_date,max(work_date) through_date,count(*) days
        from days where amount is null group by vehicle_no,model,station_code)t),'[]'::jsonb)
  ) into result;
  return result;
end; $function$

;

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
      and not (coalesce(upper(trim(c.remarks)),'') in (select upper(trim(request_no)) from approved_requests where nullif(trim(request_no),'') is not null)
 or coalesce(upper(trim(c.raw_payload->>'Payment Request')),'') in (select upper(trim(request_no)) from approved_requests where nullif(trim(request_no),'') is not null)
 or coalesce(upper(trim(c.raw_payload->>'Payment Request No')),'') in (select upper(trim(request_no)) from approved_requests where nullif(trim(request_no),'') is not null)
 or coalesce(upper(trim(c.raw_payload->>'Request No')),'') in (select upper(trim(request_no)) from approved_requests where nullif(trim(request_no),'') is not null)
 or coalesce(upper(trim(c.raw_payload->>'Remark')),'') in (select upper(trim(request_no)) from approved_requests where nullif(trim(request_no),'') is not null)
 or coalesce(trim(c.raw_payload->>'UPI Ref No'),'') in (select trim(ref) from approved_requests cross join lateral (values(utr),(utr_cin),(payment_reference)) v(ref) where nullif(trim(ref),'') is not null)
 or coalesce(trim(c.raw_payload->>'Txn Id'),'') in (select trim(payment_reference) from approved_requests where nullif(trim(payment_reference),'') is not null))
      and not (lower(trim(coalesce(c.cps_sub_head,c.category,''))) in ('station rent','office rent','premise rent')
        and exists(select 1 from rents r where r.station_code=c.station_code and r.work_date=c.expense_date))
      group by c.station_code,c.expense_date,c.cps_head,c.category,coalesce(nullif(c.cps_sub_head,''),nullif(c.category,''),'Other operating expense')
    union all select station_code,work_date,head,sub_head,'Approved payment requests',sum(amount) from approved_requests where station_code=any(p_stations) and work_date between p_from and p_through group by station_code,work_date,head,sub_head
    union all select station_code,work_date,'Rent','Facility rent and maintenance','Finance Rent Master',amount from rents
    union all select station_code,work_date,head,label,'CPS Inputs',amount from input_days
    union all select station_code,work_date,'Van','Vehicle rent · '||vehicle_no,'Fleet Vehicle Master',amount
      from public.fleet_vehicle_rent_daily(p_company,p_from,p_through,p_stations) where amount is not null
  ), period_expenses as materialized (
    select public.ops_cps_period_expenses(p_company,p_from,p_through,p_stations) rows
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
    from period_expenses pe cross join lateral jsonb_to_recordset(pe.rows)
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
    'expense_periods',(select rows from period_expenses),
    'generated_at',now()) into result;
  return result;
end; $function$

;

CREATE OR REPLACE FUNCTION public.finance_rent_adjusted_daily(p_company uuid, p_from date, p_through date, p_station_codes text[])
 RETURNS TABLE(station_code text, work_date date, total numeric, missing_cost_rows bigint, da numeric, staff numeric, fuel numeric, vehicle numeric, rent numeric, other numeric, utr numeric, van numeric, updated_at timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with fleet_rent as (
    select station_code,work_date,sum(amount) amount,count(*) filter(where amount is null) missing,max(updated_at) updated_at
    from public.fleet_vehicle_rent_daily(p_company,p_from,p_through,p_station_codes)
    group by station_code,work_date
  ), rent_daily as (
    select
      r.allocation_station_code as station_code,
      d.work_date::date,
      sum(
        round(
          (r.monthly_rent + r.monthly_maintenance)
            * extract(day from d.work_date)::numeric
            / extract(day from (date_trunc('month', d.work_date)
              + interval '1 month - 1 day'))::numeric,
          2
        )
        - round(
          (r.monthly_rent + r.monthly_maintenance)
            * (extract(day from d.work_date)::numeric - 1)
            / extract(day from (date_trunc('month', d.work_date)
              + interval '1 month - 1 day'))::numeric,
          2
        )
      ) as rent,
      max(r.updated_at) as updated_at
    from public.finance_rent_master r
    join public.stations s
      on s.company_id = r.company_id
      and s.station_code = r.allocation_station_code
      and s.is_active
      and not coalesce(s.hide_from_location_list, false)
    cross join lateral generate_series(
      greatest(p_from, r.effective_from),
      least(p_through, coalesce(r.effective_to, p_through)),
      interval '1 day'
    ) d(work_date)
    where r.company_id = p_company
      and r.deleted_at is null
      and r.effective_from <= p_through
      and coalesce(r.effective_to, p_through) >= p_from
      and (
        p_station_codes is null
        or r.allocation_station_code = any(p_station_codes)
      )
    group by r.allocation_station_code, d.work_date
  ), base as (
    select
      station_code,
      work_date,
      sum(total_cost) as total,
      count(*) filter (where total_cost is null) as missing_cost_rows,
      sum(da_pay_cost) as da,
      sum(staff_cost) as staff,
      sum(fuel_cost) as fuel,
      sum(vehicle_cost) as vehicle,
      sum(rent_cost) as imported_rent,
      sum(other_cost) as other,
      sum(utr_cost) as utr,
      sum(van_cost) as van,
      max(updated_at) as updated_at
    from public.cps_station_daily
    where company_id = p_company
      and work_date between p_from and p_through
      and (p_station_codes is null or station_code = any(p_station_codes))
    group by station_code, work_date
  )
  select
    coalesce(b.station_code, r.station_code, f.station_code) as station_code,
    coalesce(b.work_date, r.work_date, f.work_date) as work_date,
    coalesce(case
      when b.station_code is null then r.rent
      when b.total is null then r.rent
      when r.rent is null then b.total
      else b.total - coalesce(b.imported_rent, 0) + r.rent
    end + coalesce(f.amount,0), f.amount) as total,
    case
      when b.station_code is null then 1
      else b.missing_cost_rows
    end + coalesce(f.missing,0) as missing_cost_rows,
    b.da,
    b.staff,
    b.fuel,
    coalesce(b.vehicle,0)+coalesce(f.amount,0) as vehicle,
    coalesce(r.rent, b.imported_rent) as rent,
    b.other,
    b.utr,
    coalesce(b.van,0)+coalesce(f.amount,0) as van,
    greatest(b.updated_at, r.updated_at, f.updated_at) as updated_at
  from base b
  full outer join rent_daily r
    on r.station_code = b.station_code and r.work_date = b.work_date
  full outer join fleet_rent f on f.station_code=coalesce(b.station_code,r.station_code)
    and f.work_date=coalesce(b.work_date,r.work_date);
$function$

;
