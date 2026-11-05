-- Reprocess stored PayTap Core review events after card map seed.
-- Parses Core debit POS payloads in SQL so import does not wait on Fleet app deploy.

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
  ignored integer := 0;
  other integer := 0;
  skipped integer := 0;
begin
  select company_id into cid from public.fleet_paytap_connections
  where endpoint_id = 'cc07a36f-3d1a-4d94-928d-394692040c58';
  if cid is null then
    raise exception 'PayTap connection not found';
  end if;

  for r in
    select event_id, body_hash, payload
    from public.fleet_paytap_events
    where company_id = cid
      and state = 'review'
      and payload ? 'card_ending'
      and payload ? 'ext_txn_id'
      and payload ? 'txn_status'
    order by received_at, id
  loop
    crdr := upper(trim(coalesce(r.payload->>'crdr', '')));
    txn_type := upper(trim(coalesce(nullif(r.payload->>'transaction_type', ''), 'POS')));
    status := upper(trim(coalesce(r.payload->>'txn_status', '')));
    description := upper(trim(coalesce(r.payload->>'description', '')));

    if crdr = 'CREDIT' or txn_type = 'B2C' or description like '%CASHBACK%' or description like '%SURGE_CHARGE%' then
      result := public.fleet_paytap_ingest(
        cid, r.event_id, r.body_hash, r.payload, 'ignored',
        'Non-fuel PayTap credit/cashback retained without creating a fuel record.',
        null, true
      );
      ignored := ignored + 1;
      continue;
    end if;

    if crdr <> '' and crdr <> 'DEBIT' then
      skipped := skipped + 1;
      continue;
    end if;
    if txn_type <> 'POS' or status <> 'PAYMENT_SUCCESS' then
      skipped := skipped + 1;
      continue;
    end if;

    card := right(regexp_replace(coalesce(r.payload->>'card_ending', ''), '\D', '', 'g'), 4);
    amount := nullif(regexp_replace(coalesce(r.payload->>'amount', ''), '[^0-9.]', '', 'g'), '')::numeric;
    txn_date := trim(coalesce(r.payload->>'txn_date', ''));
    if card !~ '^\d{4}$' or amount is null or amount <= 0 or txn_date !~ '^\d{14}$' then
      skipped := skipped + 1;
      continue;
    end if;

    -- Compact IST wall clock → timestamptz (same as parsePaytapCompactIst).
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
    elsif result = 'ignored' then ignored := ignored + 1;
    else other := other + 1;
    end if;
  end loop;

  raise notice 'Core reprocess: % imported, % review, % ignored, % other, % skipped',
    imported, reviewed, ignored, other, skipped;
end;
$$;

select state, count(*)::int as n
from public.fleet_paytap_events e
join public.fleet_paytap_connections c on c.company_id = e.company_id
where c.endpoint_id = 'cc07a36f-3d1a-4d94-928d-394692040c58'
group by state
order by state;
