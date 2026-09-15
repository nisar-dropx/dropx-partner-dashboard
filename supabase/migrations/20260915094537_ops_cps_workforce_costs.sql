-- Additive CPS configuration; existing financial source records stay intact.
alter table public.ops_cps_cost_inputs drop constraint ops_cps_cost_inputs_head_check;
alter table public.ops_cps_cost_inputs add constraint ops_cps_cost_inputs_head_check check(head in ('DA','UTR','Van','Rent','Overhead','Other'));
alter table public.ops_cps_cost_inputs add column sub_head text check(length(sub_head)<=120),
  add column employee_id uuid references public.employees(id);
create index ops_cps_cost_inputs_employee on public.ops_cps_cost_inputs(company_id,employee_id,effective_from) where employee_id is not null;

create or replace function public.ops_cps_base_v2(p_company uuid,p_from date,p_through date,p_stations text[])
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
    union all select station_code,work_date,'Rent','Facility rent and maintenance','Finance Rent Master',amount from rents
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
revoke all on function public.ops_cps_base_v2(uuid,date,date,text[]) from public,anon,authenticated;
grant execute on function public.ops_cps_base_v2(uuid,date,date,text[]) to service_role;

-- Raw calculation inputs are available only to the scoped server, never directly
-- to browser roles. The server returns only requested station results.
create function public.ops_cps_source_facts(p_company uuid,p_from date,p_through date,p_stations text[])
returns jsonb language plpgsql stable security invoker set search_path='' as $$
begin
 if p_company is null or p_stations is null or cardinality(p_stations)>150 or p_from is null or p_through is null
   or p_through<p_from or p_through-p_from>30 or date_trunc('month',p_from)<>date_trunc('month',p_through)
   or p_through>(now() at time zone 'Asia/Kolkata')::date then raise exception 'Invalid CPS scope'; end if;
 return jsonb_build_object(
 'shipments',coalesce((select jsonb_agg(t) from (select id,client,work_date,station_code,provider_employee_id,provider_employee_name,amazon_delivery,swa_delivery,total_delivery,total_activity,c_return,mfn,mfn_return from public.cps_shipment_daily where company_id=p_company and work_date between p_from and p_through)t),'[]'::jsonb),
 'volumes',coalesce((select jsonb_agg(t) from (select station_code,work_date,sum(total_delivery) deliveries from public.cps_shipment_daily where company_id=p_company and work_date between p_from and p_through group by station_code,work_date)t),'[]'::jsonb),
 'mappings',coalesce((select jsonb_agg(t) from (select m.id,m.workforce_id,m.employee_id,m.contractor_id,m.field_executive_id,m.provider_id,m.provider_member_id,m.station_id,m.effective_from,m.effective_to,m.status,m.pay_type,m.payment_method_id,m.payment_values,m.delivery_rate,m.pickup_rate,m.mfn_rate,m.mfn_return_rate,m.guarantee_amount,m.guarantee_schedule,m.fuel_rate from public.field_executive_provider_mappings m where m.company_id=p_company and m.status in ('active','closed') and m.effective_from<=p_through and coalesce(m.effective_to,p_through)>=p_from)t),'[]'::jsonb),
 'workforce',coalesce((select jsonb_agg(t) from (select id,dropx_id,full_name,location_id,date_of_join,last_working_date,is_active,deleted_at,source_profile_type,source_profile_id from public.workforce where company_id=p_company)t),'[]'::jsonb),
 'components',coalesce((select jsonb_agg(t) from (select c.payment_method_id,c.component_code,c.component_type,coalesce(f.label,c.label) label,coalesce(f.pay_schedule,c.pay_schedule) pay_schedule,f.calculation_type,f.calculation_source,f.provider_calculation_sources from public.payment_method_components c left join public.payment_fields f on f.id=c.payment_field_id and f.company_id=p_company where c.company_id=p_company and c.is_active)t),'[]'::jsonb),
 'providers',coalesce((select jsonb_agg(t) from(select id,code,name from public.providers where company_id=p_company)t),'[]'::jsonb),
 'stations',coalesce((select jsonb_agg(t) from(select id,station_code,region,state,cluster,cluster_name,cluster_manager_email,ops_manager_email,is_active,hide_from_location_list from public.stations where company_id=p_company)t),'[]'::jsonb),
 'employees',coalesce((select jsonb_agg(t) from(select e.id,e.employee_code,e.full_name,e.email,e.location_id,e.date_of_join,e.last_working_date,e.is_active,e.deleted_at,d.code designation,op.location_access_mode,op.location_scope_ids from public.employees e left join public.designations d on d.id=e.designation_id left join public.org_positions op on op.id=e.org_position_id and op.company_id=p_company where e.company_id=p_company)t),'[]'::jsonb),
 'salaries',coalesce((select jsonb_agg(t) from(select a.id,a.employee_id,a.effective_from,a.effective_to,max(v.amount) filter(where h.head_type='ctc') monthly_ctc from public.hr_employee_salary_assignments a left join public.hr_employee_salary_values v on v.assignment_id=a.id and v.company_id=p_company left join public.hr_payroll_heads h on h.id=v.payroll_head_id and h.company_id=p_company where a.company_id=p_company and a.effective_from<=p_through and coalesce(a.effective_to,p_through)>=p_from group by a.id,a.employee_id,a.effective_from,a.effective_to)t),'[]'::jsonb),
 'rent_coverage',coalesce((select jsonb_agg(t) from(select allocation_station_code station_code,effective_from,effective_to from public.finance_rent_master where company_id=p_company and deleted_at is null and effective_from<=p_through and coalesce(effective_to,p_through)>=p_from)t),'[]'::jsonb),
 'manual_inputs',coalesce((select jsonb_agg(i) from public.ops_cps_cost_inputs i where i.company_id=p_company and i.employee_id is null and i.is_active and i.effective_from<=p_through and coalesce(i.effective_to,p_through)>=p_from),'[]'::jsonb),
 'people_rules',coalesce((select jsonb_agg(i) from public.ops_cps_cost_inputs i where i.company_id=p_company and i.employee_id is not null and i.is_active and i.effective_from<=p_through and coalesce(i.effective_to,p_through)>=p_from),'[]'::jsonb),
 'generated_at',now());
end; $$;
revoke all on function public.ops_cps_source_facts(uuid,date,date,text[]) from public,anon,authenticated;
grant execute on function public.ops_cps_source_facts(uuid,date,date,text[]) to service_role;

-- Provider-first mapping must inspect distinct members, not the first 1,000 raw daily rows.
create function public.ops_cps_mapping_members(p_company uuid,p_station_ids uuid[])
returns jsonb language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(t),'[]'::jsonb) from (
  select distinct on(s.station_code,upper(trim(s.provider_employee_id))) s.provider_employee_id,s.provider_employee_name,s.station_code,s.work_date
  from public.cps_shipment_daily s join public.stations st on st.company_id=s.company_id and st.station_code=s.station_code
  where s.company_id=p_company and (p_station_ids is null or st.id=any(p_station_ids))
  order by s.station_code,upper(trim(s.provider_employee_id)),s.work_date desc,s.updated_at desc
 )t;
$$;
revoke all on function public.ops_cps_mapping_members(uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.ops_cps_mapping_members(uuid,uuid[]) to service_role;
create unique index ops_cps_people_rule_revision on public.ops_cps_cost_inputs(company_id,employee_id,effective_from) where employee_id is not null and is_active;
