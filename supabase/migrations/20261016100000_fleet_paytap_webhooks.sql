begin;
create table public.fleet_paytap_connections (
 company_id uuid primary key references public.companies(id),endpoint_id uuid not null unique default gen_random_uuid(),
 secret_id uuid,enabled boolean not null default false,mapping jsonb not null default '{"paths":{},"paymentTypes":[],"successStatuses":[],"fuelProducts":[],"amountDivisor":1}',
 verified_at timestamptz,last_event_at timestamptz,updated_at timestamptz not null default now(),updated_by uuid
);
create table public.fleet_paytap_events (
 id uuid primary key default gen_random_uuid(),company_id uuid not null references public.companies(id),event_id text not null,body_hash text not null,
 received_at timestamptz not null default now(),processed_at timestamptz,state text not null,reason text not null,
 payload jsonb not null,fuel_id uuid references public.fleet_fuel_transactions(id),unique(company_id,event_id)
);
create index fleet_paytap_events_company_recent on public.fleet_paytap_events(company_id,received_at desc,id);
alter table public.fleet_paytap_connections enable row level security;
alter table public.fleet_paytap_events enable row level security;
revoke all on public.fleet_paytap_connections,public.fleet_paytap_events from public,anon,authenticated;
grant select,insert,update on public.fleet_paytap_connections,public.fleet_paytap_events to service_role;

create function public.fleet_paytap_save_connection(p_company uuid,p_actor uuid,p_enabled boolean,p_mapping jsonb,p_secret text default null) returns void
language plpgsql security definer set search_path='' as $$
declare oldrow public.fleet_paytap_connections; secret uuid;
begin
 if not exists(select 1 from public.profiles where id=p_actor and company_id=p_company) then raise exception 'Invalid actor';end if;
 insert into public.fleet_paytap_connections(company_id) values(p_company) on conflict do nothing;
 select * into oldrow from public.fleet_paytap_connections where company_id=p_company for update;
 secret:=oldrow.secret_id;
 if nullif(p_secret,'') is not null then
  if length(p_secret)<16 or length(p_secret)>1024 then raise exception 'Invalid signing secret';end if;
  if secret is null then select vault.create_secret(p_secret,'fleet_paytap_'||p_company::text) into secret;
  else perform vault.update_secret(secret,p_secret);end if;
 end if;
 if p_enabled and secret is null then raise exception 'Save the PayTap signing secret before enabling reception';end if;
 update public.fleet_paytap_connections set enabled=p_enabled,mapping=p_mapping,secret_id=secret,updated_at=now(),updated_by=p_actor,
 verified_at=case when nullif(p_secret,'') is not null then null else verified_at end where company_id=p_company;
 insert into public.fleet_system_logs(company_id,event_kind,entity,action,actor_user_id,actor_label,before_values,after_values)
 values(p_company,'change','fleet_paytap_connections','configure',p_actor,(select full_name from public.profiles where id=p_actor and company_id=p_company),
 jsonb_build_object('enabled',oldrow.enabled,'mapping',oldrow.mapping),jsonb_build_object('enabled',p_enabled,'mapping',p_mapping,'secret_changed',nullif(p_secret,'') is not null));
end;$$;
create function public.fleet_paytap_secret(p_endpoint uuid) returns table(company_id uuid,signing_secret text,mapping jsonb)
language sql security definer set search_path='' as $$
 select c.company_id,s.decrypted_secret,c.mapping from public.fleet_paytap_connections c join vault.decrypted_secrets s on s.id=c.secret_id where c.endpoint_id=p_endpoint and c.enabled;
$$;

-- Atomic receipt, duplicate detection and company-scoped fuel insertion. Retried events cannot double count.
create function public.fleet_paytap_ingest(p_company uuid,p_event text,p_hash text,p_payload jsonb,p_state text,p_reason text,p_fuel jsonb default null,p_reprocess boolean default false) returns text
language plpgsql security definer set search_path='' as $$
declare e public.fleet_paytap_events;v public.fleet_vehicles;t public.fleet_fuel_transactions;matches integer;fid uuid;result text;
begin
 perform 1 from public.fleet_paytap_connections where company_id=p_company for update;
 insert into public.fleet_paytap_events(company_id,event_id,body_hash,payload,state,reason)
 values(p_company,p_event,p_hash,p_payload,p_state,p_reason) on conflict(company_id,event_id) do nothing;
 select * into e from public.fleet_paytap_events where company_id=p_company and event_id=p_event for update;
 if e.body_hash<>p_hash then raise exception 'EVENT_ID_CONFLICT';end if;
 if e.processed_at is not null and (not p_reprocess or e.state<>'review') then return e.state;end if;
 result:=p_state;
 if p_state='ready' and p_fuel is not null then
  select count(*) into matches from public.fleet_vehicles where company_id=p_company and regexp_replace(upper(vehicle_no),'[^A-Z0-9]','','g')=p_fuel->>'vehicle_no';
  if matches<>1 then result:='review';p_reason:='Vehicle number must match exactly one Fleet vehicle in this company.';
  else
   select * into v from public.fleet_vehicles where company_id=p_company and regexp_replace(upper(vehicle_no),'[^A-Z0-9]','','g')=p_fuel->>'vehicle_no';
   insert into public.fleet_fuel_transactions(company_id,provider,transaction_id,transaction_at,transaction_date,vehicle_no,fuel_quantity,fuel_amount,rate,product,station_name,odometer,raw_payload)
   values(p_company,'PAYTAP',p_fuel->>'transaction_id',(p_fuel->>'transaction_at')::timestamptz,(p_fuel->>'transaction_date')::date,v.vehicle_no,
    (p_fuel->>'fuel_quantity')::numeric,(p_fuel->>'fuel_amount')::numeric,(p_fuel->>'rate')::numeric,p_fuel->>'product',p_fuel->>'station_name',(p_fuel->>'odometer')::numeric,jsonb_build_object('paytap_event_id',p_event))
   on conflict do nothing returning id into fid;
   if fid is not null then result:='imported';p_reason:='Fuel record created.';
   else
    select * into t from public.fleet_fuel_transactions where company_id=p_company and provider='PAYTAP' and transaction_id=p_fuel->>'transaction_id';
    if t.id is not null and t.vehicle_no=v.vehicle_no and t.transaction_at=(p_fuel->>'transaction_at')::timestamptz and t.fuel_quantity=(p_fuel->>'fuel_quantity')::numeric and t.fuel_amount=(p_fuel->>'fuel_amount')::numeric and t.product=p_fuel->>'product' then
     result:='duplicate';p_reason:='Payment already recorded; no duplicate fuel entry.';fid:=t.id;
    else result:='review';p_reason:='Transaction ID already exists with different details. Reconcile before changing fuel totals.';end if;
   end if;
  end if;
 end if;
 update public.fleet_paytap_events set state=result,reason=p_reason,fuel_id=fid,processed_at=now() where id=e.id;
 update public.fleet_paytap_connections set verified_at=coalesce(verified_at,now()),last_event_at=now() where company_id=p_company;
 return result;
end;$$;
revoke all on function public.fleet_paytap_save_connection(uuid,uuid,boolean,jsonb,text),public.fleet_paytap_secret(uuid),public.fleet_paytap_ingest(uuid,text,text,jsonb,text,text,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.fleet_paytap_save_connection(uuid,uuid,boolean,jsonb,text),public.fleet_paytap_secret(uuid),public.fleet_paytap_ingest(uuid,text,text,jsonb,text,text,jsonb,boolean) to service_role;
commit;
