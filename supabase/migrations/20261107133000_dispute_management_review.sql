-- Management review stays within existing role, page and station access.
create or replace function public.workforce_dispute_manager_can_review(p_company uuid,p_actor uuid,p_roles uuid[],p_station uuid)
returns boolean language sql volatile set search_path='' as $fn$
 select p_actor is not null and p_station is not null and exists (
  select 1 from public.user_roles r
  where r.company_id=p_company and r.is_active and r.id=any(coalesce(p_roles,'{}'::uuid[]))
   and regexp_replace(r.code,'^(OPERATIONS_|WORKFORCE_)','') in ('AOM','HLM','NH','NATIONAL_HEAD','REGIONAL_HEAD','ZONAL_HEAD','PROGRAM_HEAD','BH','FINMGR','FINANCE_HEAD','MANAGING_PARTNER')
   and (r.code !~ '^(PEOPLE_|FLEET_|FINANCE_|RECRUIT_|TECH_)' or r.code='FINANCE_HEAD')
   and public.workforce_payout_dispute_first_eligible_role(p_company,p_station,array[r.id],false,
    array(select p.id from public.profiles p where p.company_id=p_company and p.id<>p_actor))=r.id
 )
$fn$;
revoke all on function public.workforce_dispute_manager_can_review(uuid,uuid,uuid[],uuid) from public,anon,authenticated;
grant execute on function public.workforce_dispute_manager_can_review(uuid,uuid,uuid[],uuid) to service_role;

create or replace function public.workforce_dispute_management_stations(p_company uuid,p_actor uuid,p_roles uuid[],p_stations uuid[])
returns table(station_id uuid) language sql volatile set search_path='' as $fn$
 select s.id from public.stations s where s.company_id=p_company and s.id=any(p_stations)
 and public.workforce_dispute_manager_can_review(p_company,p_actor,p_roles,s.id)
$fn$;
revoke all on function public.workforce_dispute_management_stations(uuid,uuid,uuid[],uuid[]) from public,anon,authenticated;
grant execute on function public.workforce_dispute_management_stations(uuid,uuid,uuid[],uuid[]) to service_role;

-- Retain all row locks, source validation, independent actors and processor ownership.
do $patch$
declare def text; old text; replacement text;
begin
 select pg_get_functiondef('public.workforce_dispute_transition_v2(uuid,uuid,uuid,text,uuid[],text,integer,uuid[],jsonb)'::regprocedure) into def;
 old := 'if p_action not in (''block_processing'', ''complete_processing'') then';
 replacement := 'if p_action not in (''block_processing'', ''complete_processing'') and not (v_role_key <> ''processor_role_ids'' and public.workforce_dispute_manager_can_review(p_company,p_actor,p_actor_role_ids,v_dispute.station_id)) then';
 if position(replacement in def)=0 then
  if position(old in def)=0 then raise exception 'Dispute review guard changed; migration requires review.'; end if;
  execute replace(def,old,replacement);
 end if;
 select pg_get_functiondef('public.workforce_dispute_transition_v3(uuid,uuid,uuid,text,uuid[],text,integer,uuid[],jsonb)'::regprocedure) into def;
 old := 'if p_actor is null or role_id is null or not coalesce(role_id=any(p_actor_role_ids),false) then';
 replacement := 'if p_actor is null or (not coalesce(role_id=any(p_actor_role_ids),false) and not (stage in (''initial'',''final'') and public.workforce_dispute_manager_can_review(p_company,p_actor,p_actor_role_ids,d.station_id))) then';
 if position(replacement in def)=0 then
  if position(old in def)=0 then raise exception 'Guided review guard changed; migration requires review.'; end if;
  execute replace(def,old,replacement);
 end if;
end $patch$;
