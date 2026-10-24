-- Connection Vehicle (no fleet link) + Breakdown Vehicle (company plate, out-on-road proof).
-- Safe to re-run: inserts use ON CONFLICT; function/replace and dropdown refresh are idempotent.

alter table public.fleet_vehicles
  add column if not exists current_location_type text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'fleet_vehicles_current_location_type_check'
      and conrelid = 'public.fleet_vehicles'::regclass
  ) then
    alter table public.fleet_vehicles
      add constraint fleet_vehicles_current_location_type_check
      check (current_location_type is null or current_location_type in ('station', 'ho', 'workshop', 'in_transit', 'other'));
  end if;
end $$;

insert into public.fleet_adhoc_reason_rules(
  company_id, reason_key, label, source_code, required_status, required_statuses,
  effect_status, block_rent, contact_role_code, sort_order, is_active, approval_steps
)
select
  c.id,
  r.reason_key,
  r.label,
  r.source_code,
  null,
  array[]::text[],
  r.effect_status,
  false,
  r.contact_role_code,
  r.sort_order,
  true,
  null
from public.companies c
cross join (values
  ('connection_vehicle', 'Connection Vehicle', null::text, null::text, null::text, 7),
  ('breakdown_vehicle', 'Breakdown Vehicle', 'OWN', 'breakdown', 'OPERATIONS_FLTM', 8)
) r(reason_key, label, source_code, effect_status, contact_role_code, sort_order)
where exists (
  select 1 from public.payment_heads h
  where h.company_id = c.id and h.code = 'VAN_ADHOC'
)
on conflict (company_id, reason_key) do update set
  label = excluded.label,
  source_code = excluded.source_code,
  required_status = excluded.required_status,
  required_statuses = excluded.required_statuses,
  effect_status = excluded.effect_status,
  contact_role_code = excluded.contact_role_code,
  sort_order = excluded.sort_order,
  is_active = true;

update public.fleet_adhoc_reason_rules r
set approval_steps = jsonb_build_array(
  jsonb_build_object(
    'id', 'company-fleet',
    'step_order', 1,
    'is_required', true,
    'candidates', jsonb_build_array(jsonb_build_object('role_id', fm.id, 'scope', 'company'))
  ),
  jsonb_build_object(
    'id', 'company-business',
    'step_order', 2,
    'is_required', true,
    'candidates', jsonb_build_array(
      jsonb_build_object('role_id', bh.id, 'scope', 'company'),
      jsonb_build_object('role_id', nh.id, 'scope', 'company')
    )
  )
)
from public.user_roles fm, public.user_roles bh, public.user_roles nh
where r.reason_key = 'breakdown_vehicle'
  and r.approval_steps is null
  and fm.company_id = r.company_id and fm.code = 'OPERATIONS_FLTM'
  and bh.company_id = r.company_id and bh.code = 'OPERATIONS_BH'
  and nh.company_id = r.company_id and nh.code = 'OPERATIONS_NH';

create or replace function public.fleet_validate_adhoc_request() returns trigger
language plpgsql set search_path = '' as $$
declare
  rule public.fleet_adhoc_reason_rules;
  v public.fleet_vehicles;
  source text;
  station text;
  out_on_road boolean;
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

  if rule.reason_key = 'breakdown_vehicle' then
    out_on_road :=
      coalesce(v.current_location_type, '') = 'in_transit'
      or v.status in ('breakdown', 'under_service')
      or exists (
        select 1
        from public.fleet_daily_km k
        where k.company_id = new.company_id
          and upper(replace(k.vehicle_no, ' ', '')) = upper(replace(v.vehicle_no, ' ', ''))
          and k.movement_date = new.adhoc_deployment_date
          and k.source = 'wheelseye'
          and coalesce(k.km, 0) > 0
      );
    if not out_on_road then
      raise exception 'Company vehicle is not recorded as out on road for this date. Fleet location must be In transit, GPS must show movement today, or status must already be Breakdown / Under service.';
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
