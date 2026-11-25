begin;
set local lock_timeout='5s';

-- A deliberate no-registration disposition, separate from person/pay mappings.
create table if not exists public.provider_member_nil_maps (
  company_id uuid not null references public.companies(id),
  provider_id uuid not null references public.providers(id),
  station_id uuid not null references public.stations(id),
  provider_member_id text not null check (provider_member_id<>'' and provider_member_id=upper(btrim(provider_member_id))),
  marked_by uuid not null references auth.users(id),
  marked_at timestamptz not null default clock_timestamp(),
  primary key(company_id,provider_id,station_id,provider_member_id)
);
create table if not exists public.provider_member_nil_map_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  provider_id uuid not null references public.providers(id),
  station_id uuid not null references public.stations(id),
  provider_member_id text not null,
  action text not null check(action in ('marked','cleared','mapping_linked')),
  actor_user_id uuid references auth.users(id),
  mapping_id uuid,
  created_at timestamptz not null default clock_timestamp()
);
alter table public.provider_member_nil_maps enable row level security;
alter table public.provider_member_nil_map_events enable row level security;
revoke all on public.provider_member_nil_maps,public.provider_member_nil_map_events from public,anon,authenticated;
grant select,insert,update,delete on public.provider_member_nil_maps to service_role;
grant select,insert on public.provider_member_nil_map_events to service_role;

create or replace function public.provider_set_member_nil_map(
  p_company uuid,p_actor uuid,p_provider uuid,p_station uuid,p_member text,p_nil boolean,p_locations uuid[]
) returns jsonb language plpgsql security invoker set search_path='' as $function$
declare member_key text:=upper(btrim(coalesce(p_member,''))); v_station_code text; changed boolean;
begin
  if p_company is null or p_actor is null or p_provider is null or p_station is null or p_nil is null
    or member_key='' or length(member_key)>200 or member_key ~* '^[0-9.]+e[+-]?[0-9]+$' then
    raise exception 'A valid company, actor, provider, location and exact Provider Member ID are required.';
  end if;
  if p_locations is not null and not coalesce(p_station=any(p_locations),false) then
    raise exception 'This provider member is outside your allocated locations.';
  end if;
  if not exists(select 1 from auth.users where id=p_actor) then raise exception 'Mapping actor was not found.'; end if;
  select s.station_code into v_station_code from public.stations s
    join public.providers p on p.company_id=s.company_id and p.id=s.provider_id
    where s.company_id=p_company and s.id=p_station and s.provider_id=p_provider;
  if not found then raise exception 'The selected provider location is unavailable.'; end if;
  perform public.lock_workforce_payment_allocation_company(p_company);
  if p_nil then
    if not exists(select 1 from public.cps_shipment_daily source
      where source.company_id=p_company and source.station_code=v_station_code
        and upper(btrim(source.provider_employee_id))=member_key) then
      raise exception 'This Provider Member ID is not in the selected location activity.';
    end if;
    if exists(select 1 from public.field_executive_provider_mappings mapping
      where mapping.company_id=p_company and mapping.provider_id=p_provider and mapping.station_id=p_station
        and upper(btrim(mapping.provider_member_id))=member_key and mapping.status<>'cancelled'
        and (mapping.effective_to is null or mapping.effective_to>=(now() at time zone 'Asia/Kolkata')::date))
      or exists(select 1 from public.workforce person where person.company_id=p_company
        and person.location_id=p_station and person.deleted_at is null
        and upper(btrim(person.provider_employee_id))=member_key) then
      raise exception 'This Provider Member ID already has a registered associate or mapping. Clear its existing link before using Nill Map.';
    end if;
    insert into public.provider_member_nil_maps(company_id,provider_id,station_id,provider_member_id,marked_by)
      values(p_company,p_provider,p_station,member_key,p_actor) on conflict do nothing;
    changed:=found;
  else
    delete from public.provider_member_nil_maps where company_id=p_company and provider_id=p_provider
      and station_id=p_station and provider_member_id=member_key;
    changed:=found;
  end if;
  if changed then
    insert into public.provider_member_nil_map_events(company_id,provider_id,station_id,provider_member_id,action,actor_user_id)
      values(p_company,p_provider,p_station,member_key,case when p_nil then 'marked' else 'cleared' end,p_actor);
  end if;
  return jsonb_build_object('nil_mapped',p_nil);
end $function$;
revoke all on function public.provider_set_member_nil_map(uuid,uuid,uuid,uuid,text,boolean,uuid[]) from public,anon,authenticated;
grant execute on function public.provider_set_member_nil_map(uuid,uuid,uuid,uuid,text,boolean,uuid[]) to service_role;

-- A subsequent real mapping automatically resolves the no-registration marker.
create or replace function public.provider_clear_nil_map_on_link()
returns trigger language plpgsql security definer set search_path='' as $function$
begin
  if new.workforce_id is null or new.status='cancelled' or new.station_id is null then return new; end if;
  perform public.lock_workforce_payment_allocation_company(new.company_id);
  with removed as (
    delete from public.provider_member_nil_maps where company_id=new.company_id and provider_id=new.provider_id
      and station_id=new.station_id and provider_member_id=upper(btrim(new.provider_member_id)) returning *
  ) insert into public.provider_member_nil_map_events(company_id,provider_id,station_id,provider_member_id,action,mapping_id)
    select company_id,provider_id,station_id,provider_member_id,'mapping_linked',new.id from removed;
  return new;
end $function$;
revoke all on function public.provider_clear_nil_map_on_link() from public,anon,authenticated;
drop trigger if exists provider_mapping_clear_nil_map on public.field_executive_provider_mappings;
create trigger provider_mapping_clear_nil_map after insert or update on public.field_executive_provider_mappings
  for each row execute function public.provider_clear_nil_map_on_link();
notify pgrst,'reload schema';
commit;
