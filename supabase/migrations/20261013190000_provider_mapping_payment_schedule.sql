-- Commit a prevalidated multi-period rate plan atomically through the existing
-- audited mapping writer and all payroll/publication/overlap guards.
create or replace function public.workforce_save_mapping_schedule(
  p_company uuid, p_actor uuid, p_workforce uuid, p_dropx text,
  p_periods jsonb, p_locations uuid[], p_actor_name text, p_expected_versions jsonb
) returns jsonb language plpgsql security invoker set search_path to '' as $$
declare
  person public.workforce;
  payload jsonb;
  first_payload jsonb;
  previous_end date;
  starts date;
  ends date;
  station uuid;
  existing public.field_executive_provider_mappings;
  anchor public.field_executive_provider_mappings;
  count_periods integer;
  result jsonb;
  item record;
begin
  if p_actor is null or jsonb_typeof(p_periods) is distinct from 'array' then raise exception 'An authenticated reviewer and payment periods are required'; end if;
  count_periods := jsonb_array_length(p_periods);
  if count_periods < 2 or count_periods > 12 then raise exception 'Plan between 2 and 12 payment periods'; end if;
  first_payload := p_periods->0;
  station := (first_payload->>'station_id')::uuid;
  select * into person from public.workforce where id=p_workforce and company_id=p_company and deleted_at is null for update;
  if person.id is null then raise exception 'Associate not found'; end if;
  if p_locations is not null and (person.location_id is null or not(person.location_id=any(p_locations)) or not(station=any(p_locations))) then raise exception 'Mapping is outside your station scope'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_company::text || (first_payload->>'provider_id') || (first_payload->>'provider_member_id'),0));
  if jsonb_typeof(p_expected_versions) is distinct from 'array' or
    (select count(*) from public.field_executive_provider_mappings where company_id=p_company and workforce_id=p_workforce and station_id=station and status<>'cancelled') <> jsonb_array_length(p_expected_versions)
    or exists(select 1 from jsonb_array_elements(p_expected_versions) version where not exists (
      select 1 from public.field_executive_provider_mappings m where m.company_id=p_company and m.workforce_id=p_workforce and m.station_id=station and m.id=(version->>'id')::uuid and m.updated_at is not distinct from (version->>'updated_at')::timestamptz and m.status<>'cancelled'
    )) then raise exception 'Mapping changed while the schedule was being prepared. Reload and review it.'; end if;
  -- Validate the entire sequence before the first write. Inclusive dates meet
  -- on adjacent days, and only the final period may have no end date.
  for item in select value,ordinality from jsonb_array_elements(p_periods) with ordinality loop
    payload:=item.value; starts:=(payload->>'effective_from')::date; ends:=nullif(payload->>'effective_to','')::date;
    if (payload->>'station_id')::uuid is distinct from station or payload->>'provider_id' is distinct from first_payload->>'provider_id' or upper(btrim(payload->>'provider_member_id')) is distinct from upper(btrim(first_payload->>'provider_member_id')) or (payload->>'workforce_id')::uuid is distinct from p_workforce or (payload->>'company_id')::uuid is distinct from p_company then raise exception 'All periods must belong to the same associate, provider and station'; end if;
    if starts is null or (ends is not null and ends<starts) or (item.ordinality<count_periods and ends is null) or (item.ordinality>1 and starts is distinct from previous_end+1) then raise exception 'Payment periods must have valid adjacent dates without overlaps or gaps'; end if;
    previous_end:=ends;
  end loop;
  for payload in select value from jsonb_array_elements(p_periods) loop
    starts:=(payload->>'effective_from')::date;
    select * into existing from public.field_executive_provider_mappings m
      where m.company_id=p_company and m.workforce_id=p_workforce and m.station_id=station and m.provider_id=(payload->>'provider_id')::uuid and upper(btrim(m.provider_member_id))=upper(btrim(payload->>'provider_member_id')) and m.status<>'cancelled'
      and m.effective_from<=starts and (m.effective_to is null or m.effective_to>=starts)
      order by m.effective_from desc,m.id limit 1 for update;
    if existing.id is null and person.location_id is distinct from station then
      select * into anchor from public.field_executive_provider_mappings m where m.company_id=p_company and m.workforce_id=p_workforce and m.station_id=person.location_id and m.provider_id=(payload->>'provider_id')::uuid and upper(btrim(m.provider_member_id))=upper(btrim(payload->>'provider_member_id')) and m.status<>'cancelled' and m.effective_from<=starts and (m.effective_to is null or (nullif(payload->>'effective_to','') is not null and m.effective_to >= (payload->>'effective_to')::date)) order by m.effective_from desc limit 1;
      if anchor.id is null then raise exception 'Map this Provider ID at its registered location for the complete period first'; end if;
      perform public.workforce_keep_joining_mapping(p_company,p_actor,p_workforce,anchor.id,p_dropx,payload,p_locations,p_actor_name);
    else
      perform public.workforce_save_joining_mapping(p_company,p_actor,p_workforce,existing.id,p_dropx,payload,p_locations,p_actor_name);
    end if;
  end loop;
  select coalesce(jsonb_agg(to_jsonb(m) order by m.effective_from),'[]'::jsonb) into result from public.field_executive_provider_mappings m where m.company_id=p_company and m.workforce_id=p_workforce and m.station_id=station and m.provider_id=(first_payload->>'provider_id')::uuid and upper(btrim(m.provider_member_id))=upper(btrim(first_payload->>'provider_member_id'));
  return result;
end;
$$;
revoke all on function public.workforce_save_mapping_schedule(uuid,uuid,uuid,text,jsonb,uuid[],text,jsonb) from public,anon,authenticated;
grant execute on function public.workforce_save_mapping_schedule(uuid,uuid,uuid,text,jsonb,uuid[],text,jsonb) to service_role;
notify pgrst, 'reload schema';
