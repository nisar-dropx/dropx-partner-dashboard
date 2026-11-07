begin;
alter table public.payment_requests add column if not exists delivery_payout_station_ids uuid[] not null default '{}';

-- One configured provider family, never an arbitrary same-name or nearby station.
create or replace function public.payment_delivery_station_family(company uuid, station uuid)
returns table(station_id uuid) language sql stable security definer set search_path='' as $$
 with anchor as (
  select s.id,s.provider_id,case when upper(m.code)='XPT' then coalesce(s.parent_station_id,s.id) else s.id end parent_id
  from public.stations s left join public.location_models m on m.id=s.location_model_id and m.company_id=s.company_id
  where s.company_id=company and s.id=station
 )
 select s.id from anchor a join public.stations s on s.company_id=company and s.provider_id=a.provider_id
 left join public.location_models m on m.id=s.location_model_id and m.company_id=s.company_id
 where s.id=a.id or s.id=a.parent_id or (upper(m.code)='XPT' and s.parent_station_id=a.parent_id);
$$;

create or replace function public.payment_delivery_identity_roster_v2(p_company_id uuid,p_station_id uuid,p_work_date date)
returns table(provider_member_id text,workforce_id uuid,workforce_name text,dropx_id text,station_ids uuid[],station_codes text[])
language sql stable security definer set search_path='' as $$
 with candidates as (
  select upper(btrim(m.provider_member_id)) member,w.id worker,w.full_name,w.dropx_id,s.id station_id,s.station_code
  from public.payment_delivery_station_family(p_company_id,p_station_id) family
  join public.stations s on s.id=family.station_id and s.company_id=p_company_id
  join public.field_executive_provider_mappings m on m.company_id=p_company_id and m.station_id=s.id and m.provider_id=s.provider_id
  left join public.workforce w on w.company_id=m.company_id and (
    w.id=m.workforce_id or (m.workforce_id is null and (w.id=m.field_executive_id or w.source_profile_id=coalesce(m.contractor_id,m.employee_id,m.field_executive_id))))
  where m.status in ('active','closed') and m.effective_from<=p_work_date and (m.effective_to is null or m.effective_to>=p_work_date)
   and nullif(btrim(m.provider_member_id),'') is not null
 )
 select member,min(worker::text)::uuid,min(full_name),min(dropx_id),array_agg(distinct station_id order by station_id),array_agg(distinct station_code order by station_code)
 from candidates group by member having count(distinct worker)=1 and bool_and(worker is not null)
 order by min(full_name),member;
$$;

-- Older clients still select a shipment UUID; accept only family imports belonging
-- to the same independently resolved mapped owner. New clients need no import first.
create or replace function public.payment_delivery_identity_roster(p_company_id uuid,p_station_id uuid,p_work_date date)
returns table(shipment_id uuid,provider_member_id text,associate_name text,workforce_id uuid,workforce_name text,dropx_id text)
language sql stable security definer set search_path='' as $$
 select shipment.id,r.provider_member_id,coalesce(nullif(btrim(shipment.provider_employee_name),''),r.workforce_name),r.workforce_id,r.workforce_name,r.dropx_id
 from public.payment_delivery_identity_roster_v2(p_company_id,p_station_id,p_work_date) r
 join lateral (
  select d.id,d.provider_employee_name from public.cps_shipment_daily d
  join public.stations s on s.company_id=p_company_id and s.station_code=d.station_code and s.id=any(r.station_ids)
  join public.providers p on p.id=s.provider_id and p.company_id=p_company_id
  where d.company_id=p_company_id and upper(btrim(d.provider_employee_id))=r.provider_member_id and d.work_date<=p_work_date
   and lower(d.client)=case when lower(p.code||' '||p.name) like '%flipkart%' then 'flipkart' else 'amazon' end
  order by d.work_date desc,d.id limit 1
 ) shipment on true order by r.workforce_name,r.provider_member_id;
$$;

create or replace function public.payment_delivery_settlement_guard(p public.payment_requests)
returns void language plpgsql security definer set search_path='' as $$
declare target uuid; targets uuid[]:=case when cardinality(p.delivery_payout_station_ids)>0 then p.delivery_payout_station_ids else array[p.location_id] end;
begin
 perform public.lock_workforce_payment_allocation_company(p.company_id);
 if exists(select 1 from public.payment_requests r where r.company_id=p.company_id and r.id<>p.id
  and r.delivery_performer_workforce_id=p.delivery_performer_workforce_id and r.delivery_work_date=p.delivery_work_date
  and r.adhoc_payout_effect<>'none' and lower(r.status) in ('processed','paid')
  and (case when cardinality(r.delivery_payout_station_ids)>0 then r.delivery_payout_station_ids else array[r.location_id] end) && targets)
 then raise exception 'This associate already has a paid ad hoc request for this station family and work date'; end if;
 if exists(select 1 from public.workforce_payout_effective_paid_allocations a where a.company_id=p.company_id
  and a.credited_workforce_id=p.delivery_performer_workforce_id and a.station_id=any(targets)
  and p.delivery_work_date between a.period_start and a.period_end)
 or exists(select 1 from public.workforce_payroll_runs r join public.workforce_payroll_items i on i.payroll_run_id=r.id and i.company_id=r.company_id
  where r.company_id=p.company_id and i.workforce_id=p.delivery_performer_workforce_id and r.status in ('approved','paid') and i.status<>'excluded'
  and p.delivery_work_date between r.period_start and r.period_end)
 then raise exception 'This work date is already in a finalized Workforce payout. Finance must review it before paying ad hoc'; end if;
 perform public.workforce_bump_payout_period_dependency_revision(p.company_id,p.delivery_work_date);
 foreach target in array targets loop
  perform public.enqueue_workforce_payout_dependency_refresh(p.company_id,p.delivery_performer_workforce_id,target,p.delivery_work_date,p.delivery_work_date,p.updated_by);
 end loop;
end $$;
create or replace function public.payment_delivery_identity_guard()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  identity_policy text;
  expected_mode text;
  expected_effect text;
  station public.stations;
  shipment public.cps_shipment_daily;
  provider_text text;
  resolved_worker uuid;
  resolved_name text;
  normalized_id text;
  resolved_stations uuid[];
begin
  if tg_op = 'DELETE' then
    if old.delivery_identity_confirmed then
      raise exception 'Delivery-linked payments must be cancelled, not deleted';
    end if;
    return old;
  end if;

  select head.delivery_identity_policy into identity_policy
  from public.payment_heads head
  where head.company_id = new.company_id and head.id = new.payment_head_id;
  identity_policy := coalesce(identity_policy, 'none');

  if tg_op = 'UPDATE' and old.delivery_identity_confirmed then
    if row(
      new.company_id, new.location_id, new.payment_head_id, new.delivery_performer_mode,
      new.delivery_work_date, new.delivery_shipment_id, new.delivery_provider_employee_id,
      new.delivery_performer_workforce_id, new.delivery_performer_name,
      new.delivery_identity_confirmed, new.adhoc_payout_effect, new.adhoc_client, new.delivery_payout_station_ids
    ) is distinct from row(
      old.company_id, old.location_id, old.payment_head_id, old.delivery_performer_mode,
      old.delivery_work_date, old.delivery_shipment_id, old.delivery_provider_employee_id,
      old.delivery_performer_workforce_id, old.delivery_performer_name,
      old.delivery_identity_confirmed, old.adhoc_payout_effect, old.adhoc_client, old.delivery_payout_station_ids
    ) then
      raise exception 'Delivery identity is frozen. Cancel the unpaid request and create a corrected request';
    end if;
    -- The Master controls new requests. A later Master edit must never strand a
    -- request whose identity and payout treatment were already confirmed.
    if old.adhoc_payout_effect <> 'none'
      and lower(new.status) in ('processed', 'paid')
      and lower(old.status) not in ('processed', 'paid') then
      -- Already-confirmed requests can be in the bank queue during rollout.
      -- Complete their missing scope at settlement using the same saved owner,
      -- ID and work date. Never reinterpret an already paid request.
      if cardinality(new.delivery_payout_station_ids)=0 then
        select r.station_ids into resolved_stations
        from public.payment_delivery_identity_roster_v2(new.company_id,new.location_id,new.delivery_work_date) r
        where r.provider_member_id=upper(btrim(new.delivery_provider_employee_id))
          and r.workforce_id=new.delivery_performer_workforce_id;
        if cardinality(resolved_stations)>0 then
          select array_agg(distinct x order by x) into new.delivery_payout_station_ids
          from unnest(resolved_stations || array[new.location_id]) x;
        end if;
      end if;
      perform public.payment_delivery_settlement_guard(new);
    end if;
    return new;
  end if;

  -- Expense approval is created before payment details are collected.
  if new.amount is null then return new; end if;

  if identity_policy = 'none' then
    if new.delivery_performer_mode is not null or new.delivery_identity_confirmed then
      raise exception 'Delivery identity is not enabled for this payment head';
    end if;
    return new;
  end if;

  -- Existing Ad hoc DA / Wishmaster requests keep their established fields,
  -- reports and payout guard while the policy remains configurable in Master.
  if identity_policy = 'legacy_adhoc_da' then return new; end if;

  if identity_policy = 'paid_associate_day' then
    expected_mode := 'standalone_odcd';
    expected_effect := 'full_day';
  elsif identity_policy = 'van_execution' then
    if new.delivery_performer_mode = 'van_driver' then expected_effect := 'full_day';
    elsif new.delivery_performer_mode = 'bike_da' then expected_effect := 'none';
    elsif new.delivery_performer_mode = 'existing_odcd' then expected_effect := 'base_only';
    else raise exception 'Choose who performed the van deliveries';
    end if;
  else
    raise exception 'Invalid delivery identity policy in Payment Head master';
  end if;

  if expected_mode is not null and new.delivery_performer_mode is distinct from expected_mode then
    raise exception 'Invalid delivery performer type for this payment head';
  end if;
  if not new.delivery_identity_confirmed then
    raise exception 'Confirm that the selected person used their own delivery ID';
  end if;
  if new.delivery_work_date is null then raise exception 'Choose the delivery work date'; end if;

  select * into station from public.stations
  where company_id = new.company_id and id = new.location_id;
  if not found then raise exception 'Select a valid station'; end if;

  select lower(provider.code || ' ' || provider.name) into provider_text
  from public.providers provider
  where provider.company_id = station.company_id and provider.id = station.provider_id;
  if coalesce(provider_text, '') not like '%amazon%' and coalesce(provider_text, '') not like '%flipkart%' then
    raise exception 'Configure the station provider before selecting a delivery ID';
  end if;

  if new.delivery_shipment_id is not null then
    select * into shipment from public.cps_shipment_daily
    where company_id = new.company_id and id = new.delivery_shipment_id
      and station_code in (select s.station_code from public.stations s join public.payment_delivery_station_family(new.company_id,new.location_id) f on f.station_id=s.id where s.company_id=new.company_id)
      and work_date <= new.delivery_work_date
      and lower(client) = case when provider_text like '%flipkart%' then 'flipkart' else 'amazon' end;
    if not found then raise exception 'Select an imported delivery ID from this station and provider'; end if;
    normalized_id := nullif(btrim(shipment.provider_employee_id), '');
  else
    normalized_id := nullif(btrim(new.delivery_provider_employee_id), '');
  end if;

  if normalized_id is null or normalized_id !~ '^[A-Za-z0-9_-]{2,40}$' then
    raise exception 'Enter a valid provider delivery ID';
  end if;
  if provider_text like '%flipkart%' and normalized_id !~ '^[0-9]{12}$' then
    raise exception 'Enter the 12-digit FHR ID from Casper';
  end if;

  select r.workforce_id,r.station_ids into resolved_worker,resolved_stations
  from public.payment_delivery_identity_roster_v2(new.company_id,new.location_id,new.delivery_work_date) r
  where r.provider_member_id=upper(btrim(normalized_id));
  if resolved_worker is null then
    raise exception 'This delivery ID is unmapped or has more than one owner for the selected date. Correct ID Mapping before payment';
  end if;
  select workforce.full_name into resolved_name from public.workforce workforce
  where workforce.company_id = new.company_id and workforce.id = resolved_worker;

  new.delivery_provider_employee_id := normalized_id;
  new.delivery_performer_workforce_id := resolved_worker;
  new.delivery_payout_station_ids := resolved_stations;
  new.delivery_performer_name := resolved_name;
  new.adhoc_payout_effect := expected_effect;
  new.adhoc_client := case when provider_text like '%flipkart%' then 'Flipkart' else 'Amazon' end;
  new.work_date := new.delivery_work_date;
  new.requested_for_name := concat_ws(' / ', resolved_name, normalized_id);

  if expected_effect <> 'none' and lower(new.status) in ('processed', 'paid')
    and (tg_op = 'INSERT' or lower(old.status) not in ('processed', 'paid')) then
    perform public.payment_delivery_settlement_guard(new);
  end if;
  return new;
end $$;

revoke all on function public.payment_delivery_station_family(uuid,uuid), public.payment_delivery_identity_roster_v2(uuid,uuid,date),public.payment_delivery_identity_roster(uuid,uuid,date),public.payment_delivery_settlement_guard(public.payment_requests), public.payment_delivery_identity_guard() from public,anon,authenticated;
grant execute on function public.payment_delivery_identity_roster_v2(uuid,uuid,date),public.payment_delivery_identity_roster(uuid,uuid,date) to service_role;
notify pgrst,'reload schema';
commit;
