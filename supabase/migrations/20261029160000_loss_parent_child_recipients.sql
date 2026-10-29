begin;
-- Preserve the station-only directory for hierarchy traversal, then compose only
-- configured EDSP/XPT relationships. No cross-company or sibling expansion.
do $$ declare definition text; begin
 if to_regprocedure('public.loss_recovery_people_station(uuid,uuid)') is null then
  definition:=pg_get_functiondef('public.loss_recovery_people(uuid,uuid)'::regprocedure);
  definition:=replace(definition,'FUNCTION public.loss_recovery_people(', 'FUNCTION public.loss_recovery_people_station(');
  if position('FUNCTION public.loss_recovery_people_station(' in definition)=0 then
   raise exception 'Station recovery directory could not be preserved';
  end if;
  execute definition;
 end if;
end $$;

create or replace function public.loss_recovery_station_scope(p_company uuid,p_station uuid)
returns table(station_id uuid,station_code text)
language sql stable security invoker set search_path=public as $$
 with selected as (
  select s.*,upper(m.code) model from stations s
  left join location_models m on m.id=s.location_model_id
  where s.company_id=p_company and s.id=p_station
 )
 select id,station_code from selected
 union
 select linked.id,linked.station_code from selected s
 join stations linked on linked.company_id=p_company and linked.provider_id=s.provider_id and linked.is_active
 join location_models m on m.id=linked.location_model_id
 where (s.model='EDSP' and linked.parent_station_id=s.id and upper(m.code)='XPT')
    or (s.model='XPT' and s.parent_station_id=linked.id and upper(m.code)='EDSP');
$$;

create or replace function public.loss_recovery_people_with_locations(p_company uuid,p_station uuid)
returns table(ref text,employee_code text,full_name text,designation text,is_active boolean,station_codes text[])
language sql stable security invoker set search_path=public as $$
 select d.ref,
  (array_agg(d.employee_code order by (s.station_id=p_station) desc,s.station_code))[1],
  (array_agg(d.full_name order by (s.station_id=p_station) desc,s.station_code))[1],
  (array_agg(d.designation order by (s.station_id=p_station) desc,s.station_code))[1],
  bool_and(d.is_active),array_agg(distinct s.station_code order by s.station_code)
 from loss_recovery_station_scope(p_company,p_station) s
 cross join lateral loss_recovery_people_station(p_company,s.station_id) d
 group by d.ref order by 3,2;
$$;

-- The save-time validator uses this same directory, not a UI-only expansion.
create or replace function public.loss_recovery_people(p_company uuid,p_station uuid)
returns table(ref text,employee_code text,full_name text,designation text,is_active boolean)
language sql stable security invoker set search_path=public as $$
 select ref,employee_code,full_name,designation,is_active
 from loss_recovery_people_with_locations(p_company,p_station);
$$;
revoke all on function public.loss_recovery_people_station(uuid,uuid),public.loss_recovery_station_scope(uuid,uuid),public.loss_recovery_people_with_locations(uuid,uuid),public.loss_recovery_people(uuid,uuid) from public,anon,authenticated;
grant execute on function public.loss_recovery_people_station(uuid,uuid),public.loss_recovery_station_scope(uuid,uuid),public.loss_recovery_people_with_locations(uuid,uuid),public.loss_recovery_people(uuid,uuid) to service_role;
commit;
