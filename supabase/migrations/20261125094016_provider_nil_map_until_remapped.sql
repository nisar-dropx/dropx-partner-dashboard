begin;
set local lock_timeout='5s';
-- Compatibility for already-open clients: Nill is a disposition, not a dated allocation.
create or replace function public.provider_set_member_nil_map(
 p_company uuid,p_actor uuid,p_provider uuid,p_station uuid,p_member text,p_nil boolean,p_locations uuid[],p_remark text,p_effective_from date,p_effective_to date
) returns jsonb language plpgsql security invoker set search_path='' as $function$
begin
 return public.provider_set_member_nil_map(p_company,p_actor,p_provider,p_station,p_member,p_nil,p_locations,p_remark);
end $function$;
revoke all on function public.provider_set_member_nil_map(uuid,uuid,uuid,uuid,text,boolean,uuid[],text,date,date) from public,anon,authenticated;
grant execute on function public.provider_set_member_nil_map(uuid,uuid,uuid,uuid,text,boolean,uuid[],text,date,date) to service_role;

create or replace function public.provider_clear_nil_map_on_link()
returns trigger language plpgsql security definer set search_path='' as $function$
begin
 if new.workforce_id is null or new.status='cancelled' or new.station_id is null then return new; end if;
 perform public.lock_workforce_payment_allocation_company(new.company_id);
 with removed as (
  delete from public.provider_member_nil_maps where company_id=new.company_id and provider_id=new.provider_id
   and station_id=new.station_id and provider_member_id=upper(btrim(new.provider_member_id)) returning *
 ) insert into public.provider_member_nil_map_events(company_id,provider_id,station_id,provider_member_id,action,mapping_id,remark,effective_from,effective_to)
 select company_id,provider_id,station_id,provider_member_id,'mapping_linked',new.id,remark,effective_from,effective_to from removed;
 return new;
end $function$;
revoke all on function public.provider_clear_nil_map_on_link() from public,anon,authenticated;
notify pgrst,'reload schema';
commit;
