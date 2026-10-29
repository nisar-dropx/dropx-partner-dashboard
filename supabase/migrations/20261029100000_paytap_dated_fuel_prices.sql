begin;
-- A rate belongs to the purchase day, station and liquid fuel; never roll today's rate backwards.
create table public.fleet_fuel_price_settings (
 company_id uuid primary key references public.companies(id),enabled boolean not null default false,
 model text not null default 'gpt-5-mini',api_secret_id uuid,updated_at timestamptz not null default now(),updated_by uuid
);
create table public.fleet_fuel_prices (
 id uuid primary key default gen_random_uuid(),company_id uuid not null references public.companies(id),
 station_code text not null,city text not null,price_date date not null,fuel_type text not null check(fuel_type in ('petrol','diesel')),
 status text not null default 'pending' check(status in ('pending','searching','ready','unavailable')),
 rate numeric(12,3) check(rate>0),source_url text,source_title text,evidence text,model text,
 attempts integer not null default 0,last_attempt_at timestamptz,checked_at timestamptz,reason text,
 requested_by uuid,created_at timestamptz not null default now(),
 unique(company_id,station_code,price_date,fuel_type),
 check(status<>'ready' or (rate is not null and source_url like 'https://%' and length(evidence)>0))
);
create index fleet_fuel_prices_queue on public.fleet_fuel_prices(status,last_attempt_at);
alter table public.fleet_fuel_price_settings enable row level security;
alter table public.fleet_fuel_prices enable row level security;
revoke all on public.fleet_fuel_price_settings,public.fleet_fuel_prices from public,anon,authenticated;
grant select,insert,update on public.fleet_fuel_price_settings,public.fleet_fuel_prices to service_role;
create function public.fleet_fuel_price_configure(p_company uuid,p_actor uuid,p_enabled boolean,p_model text,p_key text default null) returns void
language plpgsql security definer set search_path='' as $$
declare oldrow public.fleet_fuel_price_settings;sid uuid;
begin
 if not exists(select 1 from public.profiles where id=p_actor and company_id=p_company) then raise exception 'Invalid actor';end if;
 if p_model !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{1,99}$' then raise exception 'Invalid model';end if;
 insert into public.fleet_fuel_price_settings(company_id) values(p_company) on conflict do nothing;
 select * into oldrow from public.fleet_fuel_price_settings where company_id=p_company for update;
 sid:=oldrow.api_secret_id;
 if nullif(p_key,'') is not null then
  if length(p_key)<20 or length(p_key)>1024 then raise exception 'Invalid API key';end if;
  if sid is null then select vault.create_secret(p_key,'fleet_fuel_price_openai_'||p_company::text) into sid;
  else perform vault.update_secret(sid,p_key);end if;
 end if;
 update public.fleet_fuel_price_settings set enabled=p_enabled,model=p_model,api_secret_id=sid,updated_at=now(),updated_by=p_actor where company_id=p_company;
 insert into public.fleet_system_logs(company_id,event_kind,entity,action,actor_user_id,actor_label,before_values,after_values)
 values(p_company,'change','fleet_fuel_price_settings','configure',p_actor,(select full_name from public.profiles where id=p_actor and company_id=p_company),
 jsonb_build_object('enabled',oldrow.enabled,'model',oldrow.model),jsonb_build_object('enabled',p_enabled,'model',p_model,'key_changed',nullif(p_key,'') is not null));
end;$$;
create function public.fleet_fuel_price_credentials(p_company uuid) returns table(model text,api_key text)
language sql security definer set search_path='' as $$
 select c.model,s.decrypted_secret from public.fleet_fuel_price_settings c left join vault.decrypted_secrets s on s.id=c.api_secret_id where c.company_id=p_company and c.enabled;
$$;
-- Claim once across Fleet/Dashboard requests. Retry failed searches after six hours, at most three automatic attempts.
create function public.fleet_fuel_price_claim(p_company uuid,p_id uuid) returns setof public.fleet_fuel_prices
language sql security definer set search_path='' as $$
 update public.fleet_fuel_prices set status='searching',attempts=attempts+1,last_attempt_at=now(),reason=null
 where company_id=p_company and id=p_id and status<>'ready' and attempts<3
 and (last_attempt_at is null or last_attempt_at<now()-interval '6 hours') returning *;
$$;
-- Apply only to amount-only PayTap rows waiting for this exact price. Measured quantities and money never change.
create function public.fleet_fuel_price_finish(p_company uuid,p_id uuid,p_rate numeric,p_url text,p_title text,p_evidence text,p_model text,p_reason text) returns void
language plpgsql security definer set search_path='' as $$
declare p public.fleet_fuel_prices;
begin
 select * into p from public.fleet_fuel_prices where company_id=p_company and id=p_id for update;
 if p.id is null or p.status<>'searching' then raise exception 'Price lookup is not claimed';end if;
 if p_rate is not null and (p_rate<=0 or p_rate>1000 or coalesce(p_url,'') not like 'https://%' or coalesce(length(p_evidence),0)=0) then raise exception 'Invalid price evidence';end if;
 update public.fleet_fuel_prices set status=case when p_rate is null then 'unavailable' else 'ready' end,rate=p_rate,source_url=p_url,source_title=p_title,evidence=p_evidence,model=p_model,checked_at=now(),reason=p_reason where id=p_id;
 if p_rate is not null then
  update public.fleet_fuel_transactions set rate=p_rate,raw_payload=coalesce(raw_payload,'{}')||jsonb_build_object('quantity_source','estimated','price_id',p.id,'price_date',p.price_date,'price_city',p.city,'price_station',p.station_code,'price_fuel_type',p.fuel_type,'price_source_url',p_url)
  where company_id=p_company and provider='PAYTAP' and fuel_quantity=0 and coalesce(rate,0)=0
   and raw_payload->>'price_id'=p.id::text and raw_payload->>'quantity_source'='pending_price';
 end if;
 insert into public.fleet_system_logs(company_id,event_kind,entity,action,actor_user_id,actor_label,before_values,after_values)
 values(p_company,'change','fleet_fuel_prices','internet_lookup',p.requested_by,'Fuel price web lookup',null,jsonb_build_object('station',p.station_code,'date',p.price_date,'fuel_type',p.fuel_type,'rate',p_rate,'source_url',p_url,'reason',p_reason));
end;$$;
revoke all on function public.fleet_fuel_price_configure(uuid,uuid,boolean,text,text),public.fleet_fuel_price_credentials(uuid),public.fleet_fuel_price_claim(uuid,uuid),public.fleet_fuel_price_finish(uuid,uuid,numeric,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.fleet_fuel_price_configure(uuid,uuid,boolean,text,text),public.fleet_fuel_price_credentials(uuid),public.fleet_fuel_price_claim(uuid,uuid),public.fleet_fuel_price_finish(uuid,uuid,numeric,text,text,text,text,text) to service_role;
create or replace function public.fleet_paytap_ingest(p_company uuid,p_event text,p_hash text,p_payload jsonb,p_state text,p_reason text,p_fuel jsonb default null,p_reprocess boolean default false) returns text
language plpgsql security definer set search_path='' as $$
declare e public.fleet_paytap_events;v public.fleet_vehicles;t public.fleet_fuel_transactions;matches integer;fid uuid;result text;price public.fleet_fuel_prices;city_name text;price_meta jsonb;price_rate numeric;
begin
 perform 1 from public.fleet_paytap_connections where company_id=p_company for update;
 insert into public.fleet_paytap_events(company_id,event_id,body_hash,payload,state,reason)
 values(p_company,p_event,p_hash,p_payload,p_state,p_reason) on conflict(company_id,event_id) do nothing;
 select * into e from public.fleet_paytap_events where company_id=p_company and event_id=p_event for update;
 if e.body_hash<>p_hash then raise exception 'EVENT_ID_CONFLICT';end if;
 if e.processed_at is not null and (not p_reprocess or (e.state<>'review' and not (e.state='imported' and exists(select 1 from public.fleet_fuel_transactions where id=e.fuel_id and company_id=p_company and fuel_quantity=0 and coalesce(rate,0)=0 and raw_payload->>'quantity_source'='pending_price')))) then return e.state;end if;
 result:=p_state;
 if p_state='ready' and p_fuel is not null then
  select count(*) into matches from public.fleet_vehicles where company_id=p_company and regexp_replace(upper(vehicle_no),'[^A-Z0-9]','','g')=p_fuel->>'vehicle_no';
  if matches<>1 then result:='review';p_reason:='Vehicle number must match exactly one Fleet vehicle in this company.';
  else
   select * into v from public.fleet_vehicles where company_id=p_company and regexp_replace(upper(vehicle_no),'[^A-Z0-9]','','g')=p_fuel->>'vehicle_no';
   price_meta:=jsonb_build_object('paytap_event_id',p_event,'quantity_source','actual');
   price_rate:=(p_fuel->>'rate')::numeric;
   if (p_fuel->>'fuel_quantity')::numeric=0 then
    price_meta:=price_meta||jsonb_build_object('quantity_source','pending_price');price_rate:=null;
    -- Use an unambiguous company station city, not a station code guessed by the model.
    select case when count(*)=1 then max(nullif(trim(city),'')) end into city_name from public.stations
     where company_id=p_company and upper(trim(station_code))=upper(trim(v.station_code));
    if lower(trim(v.fuel_type)) in ('petrol','diesel') and city_name is not null and (lower(p_fuel->>'product') not in ('petrol','diesel') or lower(p_fuel->>'product')=lower(trim(v.fuel_type))) then
     insert into public.fleet_fuel_prices(company_id,station_code,city,price_date,fuel_type)
     values(p_company,upper(trim(v.station_code)),city_name,(p_fuel->>'transaction_date')::date,lower(trim(v.fuel_type))) on conflict do nothing;
     select * into price from public.fleet_fuel_prices where company_id=p_company and station_code=upper(trim(v.station_code)) and price_date=(p_fuel->>'transaction_date')::date and fuel_type=lower(trim(v.fuel_type));
     price_meta:=price_meta||jsonb_build_object('price_id',price.id,'price_date',price.price_date,'price_city',price.city,'price_station',price.station_code,'price_fuel_type',price.fuel_type);
     if price.status='ready' then price_rate:=price.rate;price_meta:=price_meta||jsonb_build_object('quantity_source','estimated','price_source_url',price.source_url);end if;
    else price_meta:=price_meta||jsonb_build_object('quantity_reason','Check the vehicle fuel type matches the payment product and the station has a unique city, then retry the event.');end if;
   end if;
   insert into public.fleet_fuel_transactions(company_id,provider,transaction_id,transaction_at,transaction_date,vehicle_no,fuel_quantity,fuel_amount,rate,product,station_name,odometer,raw_payload)
   values(p_company,'PAYTAP',p_fuel->>'transaction_id',(p_fuel->>'transaction_at')::timestamptz,(p_fuel->>'transaction_date')::date,v.vehicle_no,
    (p_fuel->>'fuel_quantity')::numeric,(p_fuel->>'fuel_amount')::numeric,price_rate,p_fuel->>'product',p_fuel->>'station_name',(p_fuel->>'odometer')::numeric,price_meta)
   on conflict do nothing returning id into fid;
   if fid is not null then result:='imported';p_reason:=case when (p_fuel->>'fuel_quantity')::numeric>0 then 'Fuel record created with supplied litres.' when price_rate>0 then 'Fuel spend recorded; litres estimated from dated location price.' else 'Fuel spend recorded; litres await a sourced location price or vehicle/location setup.' end;
   else
    select * into t from public.fleet_fuel_transactions where company_id=p_company and provider='PAYTAP' and transaction_id=p_fuel->>'transaction_id';
    if t.id is not null and t.vehicle_no=v.vehicle_no and t.transaction_at=(p_fuel->>'transaction_at')::timestamptz and t.fuel_quantity=(p_fuel->>'fuel_quantity')::numeric and t.fuel_amount=(p_fuel->>'fuel_amount')::numeric and t.product=p_fuel->>'product' then
     result:='duplicate';p_reason:='Payment already recorded; no duplicate fuel entry.';fid:=t.id;
     if p_reprocess and e.fuel_id=t.id and t.fuel_quantity=0 and coalesce(t.rate,0)=0 and t.raw_payload->>'quantity_source'='pending_price' then
      update public.fleet_fuel_transactions set rate=price_rate,raw_payload=price_meta where id=t.id and company_id=p_company;
      result:='imported';p_reason:=case when price_rate>0 then 'Fuel spend recorded; litres estimated from dated location price.' else 'Fuel spend recorded; litres await a sourced location price or vehicle/location setup.' end;
     end if;
    else result:='review';p_reason:='Transaction ID already exists with different details. Reconcile before changing fuel totals.';end if;
   end if;
  end if;
 end if;
 update public.fleet_paytap_events set state=result,reason=p_reason,fuel_id=fid,processed_at=now() where id=e.id;
 update public.fleet_paytap_connections set verified_at=coalesce(verified_at,now()),last_event_at=now() where company_id=p_company;
 return result;
end;$$;

commit;
