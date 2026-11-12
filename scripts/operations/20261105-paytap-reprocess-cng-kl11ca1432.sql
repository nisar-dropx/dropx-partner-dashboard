-- After CNG-aware fleet_paytap_ingest hotfix: import KL11CA1432 (card 5154) review events.

do $$
declare
  cid uuid;
  r record;
  fuel jsonb;
  crdr text;
  txn_type text;
  status text;
  description text;
  card text;
  amount numeric;
  txn_date text;
  at_ts timestamptz;
  day date;
  result text;
  imported integer := 0;
  reviewed integer := 0;
begin
  select company_id into cid from public.fleet_paytap_connections
  where endpoint_id = 'cc07a36f-3d1a-4d94-928d-394692040c58';
  if cid is null then raise exception 'PayTap connection not found'; end if;

  -- Ensure vehicle fuel type is CNG (authoritative for this plate).
  update public.fleet_vehicles
  set fuel_type = 'CNG'
  where company_id = cid
    and regexp_replace(upper(vehicle_no), '[^A-Z0-9]', '', 'g') = 'KL11CA1432'
    and lower(trim(coalesce(fuel_type, ''))) <> 'cng';

  for r in
    select event_id, body_hash, payload
    from public.fleet_paytap_events
    where company_id = cid
      and state = 'review'
      and right(regexp_replace(coalesce(payload->>'card_ending', ''), '\D', '', 'g'), 4) = '5154'
    order by received_at, id
  loop
    crdr := upper(trim(coalesce(r.payload->>'crdr', '')));
    txn_type := upper(trim(coalesce(nullif(r.payload->>'transaction_type', ''), 'POS')));
    status := upper(trim(coalesce(r.payload->>'txn_status', '')));
    description := upper(trim(coalesce(r.payload->>'description', '')));
    if crdr = 'CREDIT' or txn_type = 'B2C' or description like '%CASHBACK%' or description like '%SURGE_CHARGE%' then
      perform public.fleet_paytap_ingest(cid, r.event_id, r.body_hash, r.payload, 'ignored',
        'Non-fuel PayTap credit/cashback retained without creating a fuel record.', null, true);
      continue;
    end if;
    if (crdr <> '' and crdr <> 'DEBIT') or txn_type <> 'POS' or status <> 'PAYMENT_SUCCESS' then
      continue;
    end if;
    card := right(regexp_replace(coalesce(r.payload->>'card_ending', ''), '\D', '', 'g'), 4);
    amount := nullif(regexp_replace(coalesce(r.payload->>'amount', ''), '[^0-9.]', '', 'g'), '')::numeric;
    txn_date := trim(coalesce(r.payload->>'txn_date', ''));
    if card !~ '^\d{4}$' or amount is null or amount <= 0 or txn_date !~ '^\d{14}$' then
      continue;
    end if;
    at_ts := (to_timestamp(txn_date, 'YYYYMMDDHH24MISS')::timestamp at time zone 'Asia/Kolkata');
    day := (timezone('Asia/Kolkata', at_ts))::date;
    fuel := jsonb_build_object(
      'transaction_id', trim(r.payload->>'ext_txn_id'),
      'vehicle_no', '',
      'card_ending', card,
      'transaction_at', at_ts,
      'transaction_date', day,
      'fuel_quantity', 0,
      'fuel_amount', round(amount, 2),
      'rate', 0,
      'product', '',
      'station_name', nullif(left(trim(coalesce(r.payload->>'merchant_name', '')), 200), ''),
      'odometer', null
    );
    result := public.fleet_paytap_ingest(
      cid, r.event_id, r.body_hash, r.payload, 'ready',
      'Verified PayTap Core fuel payment', fuel, true
    );
    if result = 'imported' then imported := imported + 1;
    elsif result = 'review' then reviewed := reviewed + 1;
    end if;
  end loop;
  raise notice 'KL11CA1432 CNG reprocess: % imported, % still review', imported, reviewed;
end;
$$;

select e.state, e.reason, t.vehicle_no, t.product, t.fuel_amount, t.fuel_quantity, t.raw_payload->>'quantity_source' as quantity_source
from public.fleet_paytap_events e
join public.fleet_paytap_connections c on c.company_id = e.company_id
left join public.fleet_fuel_transactions t on t.id = e.fuel_id
where c.endpoint_id = 'cc07a36f-3d1a-4d94-928d-394692040c58'
  and right(regexp_replace(coalesce(e.payload->>'card_ending', ''), '\D', '', 'g'), 4) = '5154'
order by e.received_at, e.id;
