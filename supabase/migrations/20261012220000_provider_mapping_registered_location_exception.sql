-- A provider member may have simultaneous mappings at several locations only
-- when the same canonical Workforce profile retains the exact provider/member
-- mapping at its registered location. The registered-location mapping is the
-- anchor and must start no later than any additional-location mapping.
--
-- This is a deferred constraint because the established save/move RPCs update
-- mapping rows and the Workforce registered location in one transaction. The
-- final committed state must be valid, while a temporary intermediate state
-- inside that transaction must not break ordinary mapping corrections.
begin;

create or replace function public.workforce_assert_provider_mapping_registered_location(
  p_company uuid,
  p_workforce uuid
)
returns void
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  registered_station uuid;
  invalid_mapping public.field_executive_provider_mappings%rowtype;
  anchor_start date;
begin
  if p_company is null or p_workforce is null then
    return;
  end if;

  -- Serialize anchor/dependent validation for the canonical profile. This
  -- closes the write-skew window between a concurrent Keep all insert and an
  -- anchor close performed through a different mapping write path.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_company::text || p_workforce::text || ':registered-location-anchor',
      0
    )
  );

  -- A deleted/reclassified profile is not a valid owner for an active mapping.
  -- Do not reject a completed cleanup transaction that left no active rows.
  select workforce.location_id
  into registered_station
  from public.workforce workforce
  where workforce.company_id = p_company
    and workforce.id = p_workforce
    and workforce.deleted_at is null
    and workforce.migration_state <> 'reclassified';

  select mapping.*
  into invalid_mapping
  from public.field_executive_provider_mappings mapping
  where mapping.company_id = p_company
    and mapping.status = 'active'
    and mapping.effective_to is null
    and public.workforce_provider_mapping_person(
      mapping.company_id,
      mapping.workforce_id,
      mapping.field_executive_id,
      mapping.employee_id,
      mapping.contractor_id
    ) = p_workforce
    and not exists (
      select 1
      from public.field_executive_provider_mappings anchor
      where anchor.company_id = mapping.company_id
        and anchor.status = 'active'
        and anchor.effective_to is null
        and anchor.station_id = registered_station
        and anchor.provider_id = mapping.provider_id
        and upper(btrim(anchor.provider_member_id))
          = upper(btrim(mapping.provider_member_id))
        and anchor.effective_from <= mapping.effective_from
        and public.workforce_provider_mapping_person(
          anchor.company_id,
          anchor.workforce_id,
          anchor.field_executive_id,
          anchor.employee_id,
          anchor.contractor_id
        ) = p_workforce
    )
  order by mapping.effective_from, mapping.id
  limit 1;

  if invalid_mapping.id is null then
    return;
  end if;

  if registered_station is null then
    raise exception 'The mapped DropX profile has no registered location';
  end if;

  select min(anchor.effective_from)
  into anchor_start
  from public.field_executive_provider_mappings anchor
  where anchor.company_id = p_company
    and anchor.status = 'active'
    and anchor.effective_to is null
    and anchor.station_id = registered_station
    and anchor.provider_id = invalid_mapping.provider_id
    and upper(btrim(anchor.provider_member_id))
      = upper(btrim(invalid_mapping.provider_member_id))
    and public.workforce_provider_mapping_person(
      anchor.company_id,
      anchor.workforce_id,
      anchor.field_executive_id,
      anchor.employee_id,
      anchor.contractor_id
    ) = p_workforce;

  if anchor_start is not null
    and anchor_start > invalid_mapping.effective_from
  then
    raise exception 'The registered-location mapping must start on or before every additional-location mapping';
  end if;

  raise exception 'The registered-location mapping is required; map this Provider ID at the DropX profile registered location before adding or retaining another location';
end
$function$;

comment on function public.workforce_assert_provider_mapping_registered_location(
  uuid, uuid
) is 'Validates that every active/open mapping group has an active/open same-owner, same-provider/member anchor at the Workforce registered location whose effective date is no later than its dependent rows.';

create or replace function public.workforce_provider_mapping_registered_location_guard()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  old_person uuid;
  new_person uuid;
begin
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
is 'Deferred integrity guard for additional-location mappings and their required registered-location anchor; protects anchor update, close, cancel and delete operations at transaction commit.';

drop trigger if exists field_executive_provider_mappings_03_registered_location_guard
  on public.field_executive_provider_mappings;
create constraint trigger field_executive_provider_mappings_03_registered_location_guard
after insert or update or delete on public.field_executive_provider_mappings
deferrable initially deferred
for each row execute function public.workforce_provider_mapping_registered_location_guard();

revoke all on function public.workforce_assert_provider_mapping_registered_location(
  uuid, uuid
) from public, anon, authenticated;
grant execute on function public.workforce_assert_provider_mapping_registered_location(
  uuid, uuid
) to service_role;

revoke all on function public.workforce_provider_mapping_registered_location_guard()
from public, anon, authenticated;
grant execute on function public.workforce_provider_mapping_registered_location_guard()
to service_role;

commit;
