begin;
set local lock_timeout='5s';
alter table public.provider_member_nil_maps add column if not exists effective_from date not null default (now() at time zone 'Asia/Kolkata')::date;
alter table public.provider_member_nil_maps add column if not exists effective_to date;
alter table public.provider_member_nil_maps drop constraint if exists provider_nil_period_order;
alter table public.provider_member_nil_maps add constraint provider_nil_period_order check(effective_to is null or effective_to>=effective_from);
alter table public.provider_member_nil_map_events add column if not exists effective_from date;
alter table public.provider_member_nil_map_events add column if not exists effective_to date;
alter table public.provider_member_nil_map_events drop constraint if exists provider_member_nil_map_events_action_check;
alter table public.provider_member_nil_map_events add constraint provider_member_nil_map_events_action_check check(action in ('marked','cleared','mapping_linked','remark_updated','period_updated'));

create or replace function public.provider_set_member_nil_map(
 p_company uuid,p_actor uuid,p_provider uuid,p_station uuid,p_member text,p_nil boolean,p_locations uuid[],p_remark text,p_effective_from date,p_effective_to date
) returns jsonb language plpgsql security invoker set search_path='' as $function$
declare member_key text:=upper(btrim(coalesce(p_member,''))); v_station_code text; v_remark text:=btrim(coalesce(p_remark,'')); previous public.provider_member_nil_maps%rowtype; changed boolean;
begin
 if p_company is null or p_actor is null or p_provider is null or p_station is null or p_nil is null or member_key='' or length(member_key)>200 or member_key ~* '^[0-9.]+e[+-]?[0-9]+$' then
  raise exception 'A valid company, actor, provider, location and exact Provider Member ID are required.';
 end if;
 if char_length(v_remark)>2000 then raise exception 'Remark must be 2000 characters or fewer.'; end if;
 if p_nil and (p_effective_from is null or p_effective_to is null or p_effective_to<p_effective_from) then raise exception 'Nill Map requires valid From and To dates, with To on or after From.'; end if;
 if p_locations is not null and not coalesce(p_station=any(p_locations),false) then raise exception 'This provider member is outside your allocated locations.'; end if;
 select s.station_code into v_station_code from public.stations s join public.providers p on p.company_id=s.company_id and p.id=s.provider_id
 where s.company_id=p_company and s.id=p_station and s.provider_id=p_provider;
 if not found then raise exception 'The selected provider location is unavailable.'; end if;
 perform public.lock_workforce_payment_allocation_company(p_company);
 select * into previous from public.provider_member_nil_maps where company_id=p_company and provider_id=p_provider and station_id=p_station and provider_member_id=member_key for update;
 if p_nil then
  if not exists(select 1 from public.cps_shipment_daily source where source.company_id=p_company and source.station_code=v_station_code and upper(btrim(source.provider_employee_id))=member_key) then
   raise exception 'This Provider Member ID is not in the selected location activity.';
  end if;
  if exists(select 1 from public.field_executive_provider_mappings m where m.company_id=p_company and m.provider_id=p_provider and m.station_id=p_station and upper(btrim(m.provider_member_id))=member_key and m.status<>'cancelled' and m.effective_from<=p_effective_to and coalesce(m.effective_to,'infinity'::date)>=p_effective_from) then
   raise exception 'Nill Map dates overlap an existing associate mapping. Choose a separate period.';
  end if;
  insert into public.provider_member_nil_maps(company_id,provider_id,station_id,provider_member_id,marked_by,remark,effective_from,effective_to)
  values(p_company,p_provider,p_station,member_key,p_actor,v_remark,p_effective_from,p_effective_to)
  on conflict(company_id,provider_id,station_id,provider_member_id) do update set marked_by=excluded.marked_by,marked_at=clock_timestamp(),remark=excluded.remark,effective_from=excluded.effective_from,effective_to=excluded.effective_to
  where (provider_member_nil_maps.remark,provider_member_nil_maps.effective_from,provider_member_nil_maps.effective_to) is distinct from (excluded.remark,excluded.effective_from,excluded.effective_to);
  changed:=found;
 else
  delete from public.provider_member_nil_maps where company_id=p_company and provider_id=p_provider and station_id=p_station and provider_member_id=member_key;
  changed:=found;
 end if;
 if changed then
  insert into public.provider_member_nil_map_events(company_id,provider_id,station_id,provider_member_id,action,actor_user_id,remark,effective_from,effective_to)
  values(p_company,p_provider,p_station,member_key,case when not p_nil then 'cleared' when previous.id is null then 'marked' else 'period_updated' end,p_actor,case when p_nil then v_remark else previous.remark end,case when p_nil then p_effective_from else previous.effective_from end,case when p_nil then p_effective_to else previous.effective_to end);
 end if;
 return jsonb_build_object('nil_mapped',p_nil,'remark',case when p_nil then v_remark else '' end,'effective_from',case when p_nil then p_effective_from end,'effective_to',case when p_nil then p_effective_to end);
end $function$;
revoke all on function public.provider_set_member_nil_map(uuid,uuid,uuid,uuid,text,boolean,uuid[],text,date,date) from public,anon,authenticated;
grant execute on function public.provider_set_member_nil_map(uuid,uuid,uuid,uuid,text,boolean,uuid[],text,date,date) to service_role;

-- Keep dated exclusions when a subsequent non-overlapping mapping is created.
-- Older undated exclusions retain the existing automatic clearing behavior.
create or replace function public.provider_clear_nil_map_on_link()
returns trigger language plpgsql security definer set search_path='' as $function$
begin
 if new.workforce_id is null or new.status='cancelled' or new.station_id is null then return new; end if;
 perform public.lock_workforce_payment_allocation_company(new.company_id);
 if exists(select 1 from public.provider_member_nil_maps n where n.company_id=new.company_id and n.provider_id=new.provider_id and n.station_id=new.station_id and n.provider_member_id=upper(btrim(new.provider_member_id)) and n.effective_to is not null and n.effective_from<=coalesce(new.effective_to,'infinity'::date) and n.effective_to>=new.effective_from) then
  raise exception 'Mapping dates overlap a Nill Map period. Start after its To date, or shorten or clear Nill Map first.';
 end if;
 with removed as (
  delete from public.provider_member_nil_maps where company_id=new.company_id and provider_id=new.provider_id and station_id=new.station_id and provider_member_id=upper(btrim(new.provider_member_id)) and effective_to is null returning *
 ) insert into public.provider_member_nil_map_events(company_id,provider_id,station_id,provider_member_id,action,mapping_id,remark,effective_from,effective_to)
 select company_id,provider_id,station_id,provider_member_id,'mapping_linked',new.id,remark,effective_from,effective_to from removed;
 return new;
end $function$;
notify pgrst,'reload schema';
commit;
