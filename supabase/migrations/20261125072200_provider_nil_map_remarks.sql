begin;
set local lock_timeout='5s';
alter table public.provider_member_nil_maps add column if not exists remark text not null default '' check(char_length(remark)<=2000);
alter table public.provider_member_nil_map_events add column if not exists remark text not null default '' check(char_length(remark)<=2000);
alter table public.provider_member_nil_map_events drop constraint if exists provider_member_nil_map_events_action_check;
alter table public.provider_member_nil_map_events add constraint provider_member_nil_map_events_action_check
  check(action in ('marked','cleared','mapping_linked','remark_updated'));

-- Keep the original seven-argument API for already-open worksheets. The new
-- API validates through it and saves the remark in the same locked transaction.
create or replace function public.provider_set_member_nil_map(
  p_company uuid,p_actor uuid,p_provider uuid,p_station uuid,p_member text,p_nil boolean,p_locations uuid[],p_remark text
) returns jsonb language plpgsql security invoker set search_path='' as $function$
declare result jsonb; v_remark text:=btrim(coalesce(p_remark,''));
begin
  if char_length(v_remark)>2000 then raise exception 'Remark must be 2000 characters or fewer.'; end if;
  result:=public.provider_set_member_nil_map(p_company,p_actor,p_provider,p_station,p_member,p_nil,p_locations);
  if p_nil then
    update public.provider_member_nil_maps set remark=v_remark
      where company_id=p_company and provider_id=p_provider and station_id=p_station
        and provider_member_id=upper(btrim(p_member)) and remark is distinct from v_remark;
    if found then
      insert into public.provider_member_nil_map_events(company_id,provider_id,station_id,provider_member_id,action,actor_user_id,remark)
        values(p_company,p_provider,p_station,upper(btrim(p_member)),'remark_updated',p_actor,v_remark);
    end if;
  end if;
  return result||jsonb_build_object('remark',case when p_nil then v_remark else '' end);
end $function$;
revoke all on function public.provider_set_member_nil_map(uuid,uuid,uuid,uuid,text,boolean,uuid[],text) from public,anon,authenticated;
grant execute on function public.provider_set_member_nil_map(uuid,uuid,uuid,uuid,text,boolean,uuid[],text) to service_role;
notify pgrst,'reload schema';
commit;
