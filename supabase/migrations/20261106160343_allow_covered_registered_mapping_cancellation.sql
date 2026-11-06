-- Permit removal of a redundant registered-location history row only when
-- surviving registered mappings preserve complete coverage for its dependants.
begin;

-- Active mappings may be bounded; coverage still ends at effective_to.
create or replace function public.workforce_provider_mapping_period_covered(
 p_company uuid, p_workforce uuid, p_station uuid, p_provider uuid,
 p_member text, p_from date, p_to date
) returns boolean language sql stable security invoker set search_path to ''
as $covered$
 select case when p_from is null or (p_to is not null and p_to < p_from) then false
 else coalesce((
  select pg_catalog.range_agg(pg_catalog.daterange(m.effective_from,m.effective_to,'[]'))
   @> pg_catalog.daterange(p_from,p_to,'[]')
  from public.field_executive_provider_mappings m
  where m.company_id=p_company and m.station_id=p_station and m.provider_id=p_provider
   and upper(btrim(m.provider_member_id))=upper(btrim(p_member))
   and ((m.status='active' and (m.effective_to is null or m.effective_to>=m.effective_from))
     or (m.status='closed' and m.effective_to is not null and m.effective_to>=m.effective_from))
   and public.workforce_provider_mapping_person(m.company_id,m.workforce_id,
     m.field_executive_id,m.employee_id,m.contractor_id)=p_workforce
 ),false) end;
$covered$;

create or replace function public.workforce_provider_mapping_registered_location_guard()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  old_person uuid;
  new_person uuid;
  registered_station uuid;
begin
  -- Cancelling one exact history row cannot create a dependency when the row
  -- belongs to an additional location. For a registered-location row, inspect
  -- only the interval being removed. This intentionally avoids allowing an
  -- unrelated legacy data issue to prevent cleanup of an additional row.
  if tg_op = 'UPDATE'
    and old.status in ('active', 'closed')
    and new.status = 'cancelled'
    and (
      to_jsonb(old) - array['status', 'updated_at']::text[]
    ) is not distinct from (
      to_jsonb(new) - array['status', 'updated_at']::text[]
    )
  then
    old_person := public.workforce_provider_mapping_person(
      old.company_id,
      old.workforce_id,
      old.field_executive_id,
      old.employee_id,
      old.contractor_id
    );

    if old_person is null then
      raise exception 'Provider mapping must resolve to a canonical Workforce profile';
    end if;

    select workforce.location_id
    into registered_station
    from public.workforce workforce
    where workforce.company_id = old.company_id
      and workforce.id = old_person
      and workforce.deleted_at is null
      and workforce.migration_state <> 'reclassified';

    if old.station_id is not distinct from registered_station
      and exists (
        select 1
        from public.field_executive_provider_mappings additional
        where additional.company_id = old.company_id
          and additional.id is distinct from old.id
          and additional.status in ('active', 'closed')
          and additional.station_id is distinct from registered_station
          and public.workforce_provider_mapping_person(
            additional.company_id,
            additional.workforce_id,
            additional.field_executive_id,
            additional.employee_id,
            additional.contractor_id
          ) = old_person
          and daterange(
            additional.effective_from,
            coalesce(additional.effective_to, 'infinity'::date),
            '[]'
          ) && daterange(
            old.effective_from,
            coalesce(old.effective_to, 'infinity'::date),
            '[]'
          )
          -- The cancelled row is no longer counted by this helper. A surviving
          -- registered mapping must cover the exact additional-location slice
          -- that relied on the removed interval, with the same provider/ID.
          and not public.workforce_provider_mapping_period_covered(
            old.company_id, old_person, registered_station,
            additional.provider_id, additional.provider_member_id,
            greatest(additional.effective_from, old.effective_from),
            least(additional.effective_to, old.effective_to)
          )
      )
    then
      raise exception 'The registered-location mapping cannot be removed while an additional-location mapping overlaps this period. Remove the additional-location period first.';
    end if;

    return null;
  end if;

  -- All non-removal writes retain the complete registered-location coverage
  -- invariant established by the existing deferred constraint trigger.
  if tg_op in ('UPDATE', 'DELETE') then
    old_person := public.workforce_provider_mapping_person(
      old.company_id,
      old.workforce_id,
      old.field_executive_id,
      old.employee_id,
      old.contractor_id
    );
    perform public.workforce_assert_provider_mapping_registered_location(
      old.company_id,
      old_person
    );
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    new_person := public.workforce_provider_mapping_person(
      new.company_id,
      new.workforce_id,
      new.field_executive_id,
      new.employee_id,
      new.contractor_id
    );
    if new_person is null then
      raise exception 'Provider mapping must resolve to a canonical Workforce profile';
    end if;

    if tg_op = 'INSERT' then
      perform public.workforce_assert_provider_mapping_registered_location(
        new.company_id,
        new_person
      );
    elsif new.company_id is distinct from old.company_id
      or new_person is distinct from old_person
    then
      perform public.workforce_assert_provider_mapping_registered_location(
        new.company_id,
        new_person
      );
    end if;
  end if;

  return null;
end
$function$;

comment on function public.workforce_provider_mapping_registered_location_guard()
is 'Deferred integrity guard: cancelling a registered-location history row requires surviving same-provider/member coverage for every dependent additional-location date; all other writes retain full coverage validation.';

revoke all on function public.workforce_provider_mapping_registered_location_guard()
from public, anon, authenticated;
grant execute on function public.workforce_provider_mapping_registered_location_guard() to service_role;
commit;
