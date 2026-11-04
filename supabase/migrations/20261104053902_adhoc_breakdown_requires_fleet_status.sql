-- Fleet is the source of truth for Adhoc Van breakdown replacement requests.
-- Preserve submitted snapshots and approval routes; revalidate new/draft requests.
update public.fleet_adhoc_reason_rules
set required_status = 'breakdown', required_statuses = array['breakdown']::text[],
    label = case when reason_key = 'company_breakdown' and label = 'Company Vehicle Breakdown / Service'
      then 'Company Vehicle Breakdown' else label end
where reason_key in ('company_breakdown', 'vendor_breakdown', 'odcd_breakdown', 'breakdown_vehicle');

create or replace function public.fleet_validate_adhoc_request() returns trigger
language plpgsql set search_path = '' as $$
declare
  rule public.fleet_adhoc_reason_rules;
  v public.fleet_vehicles;
  source text;
  station text;
  required text[];
begin
  if new.adhoc_reason_key is null then return new; end if;
  if tg_op = 'UPDATE' and old.status <> 'draft'
    and (new.adhoc_reason_key, new.adhoc_vehicle_id, new.adhoc_deployment_date)
      is not distinct from (old.adhoc_reason_key, old.adhoc_vehicle_id, old.adhoc_deployment_date)
  then return new; end if;
  if tg_op = 'UPDATE' and old.status <> 'draft' then
    raise exception 'The replacement reason, vehicle and date cannot be changed after submission. Cancel and raise a corrected request.';
  end if;
  if not exists (
    select 1 from public.payment_heads
    where company_id = new.company_id and id = new.payment_head_id and code = 'VAN_ADHOC'
  ) then
    raise exception 'Vehicle reasons apply only to ad hoc vans.';
  end if;

  select * into rule
  from public.fleet_adhoc_reason_rules
  where company_id = new.company_id and reason_key = new.adhoc_reason_key and is_active;
  if not found then raise exception 'This ad hoc reason is unavailable. Refresh and try again.'; end if;
  if new.adhoc_deployment_date is null then raise exception 'Deployment date is required.'; end if;

  select station_code into station
  from public.stations
  where company_id = new.company_id and id = new.location_id;
  if station is null then raise exception 'Station unavailable.'; end if;

  if rule.source_code is null then
    new.adhoc_vehicle_id := null;
    new.adhoc_vehicle_snapshot := null;
    return new;
  end if;

  select * into v
  from public.fleet_vehicles
  where company_id = new.company_id and id = new.adhoc_vehicle_id
  for update;
  if not found
    or v.station_code <> station
    or v.deployment_status <> 'deployed'
    or v.deployment_date > new.adhoc_deployment_date
  then
    raise exception 'Select a deployed vehicle at this station for the request date.';
  end if;

  select coalesce(d.code, 'OWN') into source
  from public.fleet_vehicle_sources s
  left join public.designations d on d.id = s.designation_id
  where s.company_id = new.company_id and s.id = v.source_id and s.is_active;
  if source is distinct from rule.source_code then
    raise exception 'Vehicle source does not match the selected reason.';
  end if;

  if exists (
    select 1 from public.fleet_vehicle_status_master
    where company_id = new.company_id and status_key = v.status and is_terminal
  ) then
    raise exception 'This vehicle is no longer active.';
  end if;

  if rule.reason_key in ('company_breakdown', 'vendor_breakdown', 'odcd_breakdown', 'breakdown_vehicle') then
    if v.status is distinct from 'breakdown' then
      raise exception 'Vehicle must be marked Breakdown in Fleet before requesting a replacement.';
    end if;
  else
    required := coalesce(
      rule.required_statuses,
      case when rule.required_status is null then array[]::text[] else array[rule.required_status] end
    );
    if cardinality(required) > 0 and not (v.status = any (required)) then
      raise exception 'No matching eligible vehicle status recorded. Contact the Fleet Manager to update Fleet first.';
    end if;
  end if;

  if exists (
    select 1 from public.fleet_vehicle_day_availability
    where company_id = new.company_id
      and vehicle_id = v.id
      and work_date = new.adhoc_deployment_date
      and revoked_at is null
  ) then
    raise exception 'A replacement request already exists for this vehicle and date.';
  end if;

  new.adhoc_vehicle_snapshot := jsonb_build_object(
    'number', v.vehicle_no,
    'model', v.model,
    'partner', case when source = 'OWN' then null else coalesce(v.da_name, v.vendor_name) end,
    'source', source,
    'status', v.status,
    'location_type', v.current_location_type,
    'reason', rule.label,
    'date', new.adhoc_deployment_date
  );
  new.adhoc_approval_steps := rule.approval_steps;
  return new;
end $$;

update public.payment_head_questions q
set dropdown_options = (
  select string_agg(r.label, ', ' order by r.sort_order)
  from public.fleet_adhoc_reason_rules r
  where r.company_id = h.company_id and r.is_active
)
from public.payment_heads h
where q.payment_head_id = h.id
  and h.code = 'VAN_ADHOC'
  and q.question_text ~* 'reason.*(adhoc|ad hoc).*deployment';
