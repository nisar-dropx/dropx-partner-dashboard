-- HBSC has no provider delivery IDs available. Allow the Expense Request UI
-- to submit a selected Workforce person by DropX ID, while retaining the
-- Workforce owner and settlement safeguards for payout processing.
begin;

alter table public.payment_requests
  add column if not exists delivery_provider_employee_id text;

do $$
declare
  definition text;
  old_block text := $old$
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
$old$;
  new_block text := $new$
  if upper(btrim(station.station_code)) = 'HBSC' and new.delivery_shipment_id is null then
    select w.id, w.full_name, upper(btrim(w.dropx_id))
      into resolved_worker, resolved_name, normalized_id
    from public.workforce w
    where w.company_id = new.company_id
      and w.location_id = new.location_id
      and w.deleted_at is null
      and upper(btrim(w.dropx_id)) = upper(btrim(new.delivery_provider_employee_id));
    if not found then
      raise exception 'Select an active HBSC Workforce person by DropX ID';
    end if;
    resolved_stations := array[new.location_id];
  else
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
  end if;
$new$;
begin
  select pg_get_functiondef('public.payment_delivery_identity_guard()'::regprocedure) into definition;
  if position(old_block in definition) = 0 then
    raise exception 'HBSC manual identity migration could not find the current delivery identity guard block';
  end if;
  execute replace(definition, old_block, new_block);
end $$;

notify pgrst, 'reload schema';
commit;
