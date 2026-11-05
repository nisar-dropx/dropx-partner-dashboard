begin;

-- Card last-4 â†’ Fleet vehicle. PayTap Core webhooks identify spend by card_ending only.
create table if not exists public.fleet_paytap_cards (
 company_id uuid not null references public.companies(id) on delete cascade,
 card_ending text not null check (card_ending ~ '^\d{4}$'),
 vehicle_id uuid not null references public.fleet_vehicles(id) on delete cascade,
 kit_number text,
 masked_card text,
 paytap_vehicle_id text,
 updated_at timestamptz not null default now(),
 updated_by uuid,
 primary key (company_id, card_ending)
);
create index if not exists fleet_paytap_cards_vehicle on public.fleet_paytap_cards(company_id, vehicle_id);
alter table public.fleet_paytap_cards enable row level security;
revoke all on public.fleet_paytap_cards from public, anon, authenticated;
grant select, insert, update, delete on public.fleet_paytap_cards to service_role;

create or replace function public.fleet_paytap_upsert_cards(
 p_company uuid, p_actor uuid, p_cards jsonb
) returns integer
language plpgsql security definer set search_path = '' as $$
declare item jsonb; plate text; ending text; vid uuid; matches integer; n integer := 0;
begin
 if not exists (select 1 from public.profiles where id = p_actor and company_id = p_company) then
  raise exception 'Invalid actor';
 end if;
 if p_cards is null or jsonb_typeof(p_cards) <> 'array' or jsonb_array_length(p_cards) > 500 then
  raise exception 'Provide up to 500 card mappings';
 end if;
 for item in select * from jsonb_array_elements(p_cards)
 loop
  ending := right(regexp_replace(coalesce(item->>'card_ending', item->>'masked_card', ''), '\D', '', 'g'), 4);
  plate := upper(regexp_replace(coalesce(item->>'vehicle_no', item->>'vehicleRegNumber', ''), '[^A-Z0-9]', '', 'g'));
  if ending !~ '^\d{4}$' or plate = '' then
   raise exception 'Each card needs a 4-digit ending and vehicle registration';
  end if;
  select count(*) into matches from public.fleet_vehicles
   where company_id = p_company and regexp_replace(upper(vehicle_no), '[^A-Z0-9]', '', 'g') = plate;
  if matches = 0 then
   raise exception 'No Fleet vehicle matches %', coalesce(item->>'vehicle_no', item->>'vehicleRegNumber', plate);
  end if;
  if matches <> 1 then
   raise exception 'Vehicle % matches more than one Fleet record', plate;
  end if;
  select id into vid from public.fleet_vehicles
   where company_id = p_company and regexp_replace(upper(vehicle_no), '[^A-Z0-9]', '', 'g') = plate;
  insert into public.fleet_paytap_cards(company_id, card_ending, vehicle_id, kit_number, masked_card, paytap_vehicle_id, updated_at, updated_by)
  values (
   p_company, ending, vid,
   nullif(left(coalesce(item->>'kit_number', item->>'kitNumber', ''), 64), ''),
   nullif(left(coalesce(item->>'masked_card', item->>'maskedCardNumber', ''), 32), ''),
   nullif(left(coalesce(item->>'paytap_vehicle_id', item->>'vehicleId', ''), 64), ''),
   now(), p_actor
  )
  on conflict (company_id, card_ending) do update set
   vehicle_id = excluded.vehicle_id,
   kit_number = coalesce(excluded.kit_number, public.fleet_paytap_cards.kit_number),
   masked_card = coalesce(excluded.masked_card, public.fleet_paytap_cards.masked_card),
   paytap_vehicle_id = coalesce(excluded.paytap_vehicle_id, public.fleet_paytap_cards.paytap_vehicle_id),
   updated_at = now(),
   updated_by = p_actor;
  n := n + 1;
 end loop;
 insert into public.fleet_system_logs(company_id, event_kind, entity, action, actor_user_id, actor_label, before_values, after_values)
 values (
  p_company, 'change', 'fleet_paytap_cards', 'upsert', p_actor,
  (select full_name from public.profiles where id = p_actor and company_id = p_company),
  null, jsonb_build_object('count', n)
 );
 return n;
end;
$$;

revoke all on function public.fleet_paytap_upsert_cards(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fleet_paytap_upsert_cards(uuid, uuid, jsonb) to service_role;

-- Resolve Core payments by card_ending; fill product from vehicle fuel_type when blank.
create or replace function public.fleet_paytap_ingest(
 p_company uuid, p_event text, p_hash text, p_payload jsonb, p_state text, p_reason text,
 p_fuel jsonb default null, p_reprocess boolean default false
) returns text
language plpgsql security definer set search_path = '' as $$
declare
 e public.fleet_paytap_events;
 v public.fleet_vehicles;
 t public.fleet_fuel_transactions;
 matches integer;
 fid uuid;
 result text;
 price public.fleet_fuel_prices;
 city_name text;
 price_meta jsonb;
 price_rate numeric;
 fuel jsonb := p_fuel;
 card text;
 product text;
 plate text;
begin
 perform 1 from public.fleet_paytap_connections where company_id = p_company for update;
 insert into public.fleet_paytap_events(company_id, event_id, body_hash, payload, state, reason)
 values (p_company, p_event, p_hash, p_payload, p_state, p_reason)
 on conflict (company_id, event_id) do nothing;
 select * into e from public.fleet_paytap_events where company_id = p_company and event_id = p_event for update;
 if e.body_hash <> p_hash then raise exception 'EVENT_ID_CONFLICT'; end if;
 if e.processed_at is not null and (
  not p_reprocess
  or (
   e.state <> 'review'
   and not (
    e.state = 'imported'
    and exists (
     select 1 from public.fleet_fuel_transactions
     where id = e.fuel_id and company_id = p_company and fuel_quantity = 0
       and coalesce(rate, 0) = 0 and raw_payload->>'quantity_source' = 'pending_price'
    )
   )
  )
 ) then
  return e.state;
 end if;

 result := p_state;

 -- Resolve Core card â†’ vehicle before import.
 if p_state = 'ready' and fuel is not null then
  card := right(regexp_replace(coalesce(fuel->>'card_ending', ''), '\D', '', 'g'), 4);
  plate := regexp_replace(upper(coalesce(fuel->>'vehicle_no', '')), '[^A-Z0-9]', '', 'g');
  if plate = '' and card ~ '^\d{4}$' then
   select count(*) into matches
   from public.fleet_paytap_cards c
   join public.fleet_vehicles fv on fv.id = c.vehicle_id and fv.company_id = c.company_id
   where c.company_id = p_company and c.card_ending = card;
   if matches <> 1 then
    result := 'review';
    p_reason := format('Card ending %s is not linked to exactly one Fleet vehicle. Map the card under PayTap settings.', card);
    fuel := null;
   else
    select fv.* into v
    from public.fleet_paytap_cards c
    join public.fleet_vehicles fv on fv.id = c.vehicle_id and fv.company_id = c.company_id
    where c.company_id = p_company and c.card_ending = card;
    plate := regexp_replace(upper(v.vehicle_no), '[^A-Z0-9]', '', 'g');
    product := coalesce(nullif(trim(fuel->>'product'), ''), initcap(lower(trim(v.fuel_type))));
    if lower(trim(coalesce(product, ''))) not in ('petrol', 'diesel') then
     result := 'review';
     p_reason := format('Vehicle %s needs petrol or diesel fuel type before PayTap spend can import.', v.vehicle_no);
     fuel := null;
    else
     fuel := fuel || jsonb_build_object('vehicle_no', plate, 'product', product);
    end if;
   end if;
  end if;
 end if;

 if result = 'ready' and fuel is not null then
  select count(*) into matches
  from public.fleet_vehicles
  where company_id = p_company
    and regexp_replace(upper(vehicle_no), '[^A-Z0-9]', '', 'g') = fuel->>'vehicle_no';
  if matches <> 1 then
   result := 'review';
   p_reason := 'Vehicle number must match exactly one Fleet vehicle in this company.';
  else
   select * into v
   from public.fleet_vehicles
   where company_id = p_company
     and regexp_replace(upper(vehicle_no), '[^A-Z0-9]', '', 'g') = fuel->>'vehicle_no';
   price_meta := jsonb_build_object('paytap_event_id', p_event, 'quantity_source', 'actual');
   if nullif(fuel->>'card_ending', '') is not null then
    price_meta := price_meta || jsonb_build_object('card_ending', fuel->>'card_ending');
   end if;
   price_rate := (fuel->>'rate')::numeric;
   if (fuel->>'fuel_quantity')::numeric = 0 then
    price_meta := price_meta || jsonb_build_object('quantity_source', 'pending_price');
    price_rate := null;
    select case when count(*) = 1 then max(nullif(trim(city), '')) end into city_name
    from public.stations
    where company_id = p_company and upper(trim(station_code)) = upper(trim(v.station_code));
    if lower(trim(v.fuel_type)) in ('petrol', 'diesel')
       and city_name is not null
       and (lower(fuel->>'product') not in ('petrol', 'diesel') or lower(fuel->>'product') = lower(trim(v.fuel_type))) then
     insert into public.fleet_fuel_prices(company_id, station_code, city, price_date, fuel_type)
     values (p_company, upper(trim(v.station_code)), city_name, (fuel->>'transaction_date')::date, lower(trim(v.fuel_type)))
     on conflict do nothing;
     select * into price
     from public.fleet_fuel_prices
     where company_id = p_company
       and station_code = upper(trim(v.station_code))
       and price_date = (fuel->>'transaction_date')::date
       and fuel_type = lower(trim(v.fuel_type));
     price_meta := price_meta || jsonb_build_object(
      'price_id', price.id, 'price_date', price.price_date, 'price_city', price.city,
      'price_station', price.station_code, 'price_fuel_type', price.fuel_type
     );
     if price.status = 'ready' then
      price_rate := price.rate;
      price_meta := price_meta || jsonb_build_object('quantity_source', 'estimated', 'price_source_url', price.source_url);
     end if;
    else
     price_meta := price_meta || jsonb_build_object(
      'quantity_reason',
      'Check the vehicle fuel type matches the payment product and the station has a unique city, then retry the event.'
     );
    end if;
   end if;
   insert into public.fleet_fuel_transactions(
    company_id, provider, transaction_id, transaction_at, transaction_date, vehicle_no,
    fuel_quantity, fuel_amount, rate, product, station_name, odometer, raw_payload
   )
   values (
    p_company, 'PAYTAP', fuel->>'transaction_id', (fuel->>'transaction_at')::timestamptz,
    (fuel->>'transaction_date')::date, v.vehicle_no,
    (fuel->>'fuel_quantity')::numeric, (fuel->>'fuel_amount')::numeric, price_rate,
    fuel->>'product', fuel->>'station_name', (fuel->>'odometer')::numeric, price_meta
   )
   on conflict do nothing
   returning id into fid;
   if fid is not null then
    result := 'imported';
    p_reason := case
     when (fuel->>'fuel_quantity')::numeric > 0 then 'Fuel record created with supplied litres.'
     when price_rate > 0 then 'Fuel spend recorded; litres estimated from dated location price.'
     else 'Fuel spend recorded; litres await a sourced location price or vehicle/location setup.'
    end;
   else
    select * into t
    from public.fleet_fuel_transactions
    where company_id = p_company and provider = 'PAYTAP' and transaction_id = fuel->>'transaction_id';
    if t.id is not null
       and t.vehicle_no = v.vehicle_no
       and t.transaction_at = (fuel->>'transaction_at')::timestamptz
       and t.fuel_quantity = (fuel->>'fuel_quantity')::numeric
       and t.fuel_amount = (fuel->>'fuel_amount')::numeric
       and t.product = fuel->>'product' then
     result := 'duplicate';
     p_reason := 'Payment already recorded; no duplicate fuel entry.';
     fid := t.id;
     if p_reprocess and e.fuel_id = t.id and t.fuel_quantity = 0
        and coalesce(t.rate, 0) = 0 and t.raw_payload->>'quantity_source' = 'pending_price' then
      update public.fleet_fuel_transactions
      set rate = price_rate, raw_payload = price_meta
      where id = t.id and company_id = p_company;
      result := 'imported';
      p_reason := case
       when price_rate > 0 then 'Fuel spend recorded; litres estimated from dated location price.'
       else 'Fuel spend recorded; litres await a sourced location price or vehicle/location setup.'
      end;
     end if;
    else
     result := 'review';
     p_reason := 'Transaction ID already exists with different details. Reconcile before changing fuel totals.';
    end if;
   end if;
  end if;
 end if;

 update public.fleet_paytap_events
 set state = result, reason = p_reason, fuel_id = fid, processed_at = now()
 where id = e.id;
 update public.fleet_paytap_connections
 set verified_at = coalesce(verified_at, now()), last_event_at = now()
 where company_id = p_company;
 return result;
end;
$$;

revoke all on function public.fleet_paytap_ingest(uuid, text, text, jsonb, text, text, jsonb, boolean)
 from public, anon, authenticated;
grant execute on function public.fleet_paytap_ingest(uuid, text, text, jsonb, text, text, jsonb, boolean)
 to service_role;

commit;
