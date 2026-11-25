begin;
set local lock_timeout='5s';
create or replace function public.provider_set_member_nil_map(
 p_company uuid,p_actor uuid,p_provider uuid,p_station uuid,p_member text,p_nil boolean,p_locations uuid[],p_remark text,p_effective_from date,p_effective_to date
) returns jsonb language plpgsql security invoker set search_path='' as $function$
declare member_key text:=upper(btrim(coalesce(p_member,''))); v_station_code text; v_remark text:=btrim(coalesce(p_remark,'')); previous public.provider_member_nil_maps%rowtype; changed boolean;
begin
 if p_company is null or p_actor is null or p_provider is null or p_station is null or p_nil is null or member_key='' or length(member_key)>200 or member_key ~* '^[0-9.]+e[+-]?[0-9]+$' then
  raise exception 'A valid company, actor, provider, location and exact Provider Member ID are required.';
 end if;
 if char_length(v_remark)>2000 then raise exception 'Remark must be 2000 characters or fewer.'; end if;
 if p_nil and (p_effective_from is null or (p_effective_to is not null and p_effective_to<p_effective_from)) then raise exception 'Nill Map requires Effective from. Effective to is optional and cannot be before Effective from.'; end if;
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
  if exists(select 1 from public.field_executive_provider_mappings m where m.company_id=p_company and m.provider_id=p_provider and m.station_id=p_station and upper(btrim(m.provider_member_id))=member_key and m.status<>'cancelled' and m.effective_from<=coalesce(p_effective_to,'infinity'::date) and coalesce(m.effective_to,'infinity'::date)>=p_effective_from) then
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


notify pgrst,'reload schema';
commit;
