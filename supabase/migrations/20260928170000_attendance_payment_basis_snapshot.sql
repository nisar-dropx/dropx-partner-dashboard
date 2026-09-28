begin;

alter table public.payment_fields
  drop constraint if exists payment_fields_calculation_source_check;

alter table public.payment_fields
  add constraint payment_fields_calculation_source_check check (
    calculation_source is null or calculation_source in (
      'amazon_delivery',
      'swa_delivery',
      'total_delivery',
      'customer_return',
      'seller_pickup',
      'seller_return',
      'mfn_forward',
      'mfn_return',
      'total_activity',
      'attendance_eligibility',
      'performance_metric'
    )
  );

create or replace function public.enforce_attendance_payment_field_direct_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('workforce-payment-basis:' || new.company_id::text, 0));
  if new.calculation_source = 'attendance_eligibility'
    and old.calculation_source is distinct from new.calculation_source
    and exists (
      select 1
      from public.payment_method_components component
      join public.field_executive_provider_mappings mapping
        on mapping.company_id = new.company_id
       and mapping.payment_method_id = component.payment_method_id
       and mapping.status <> 'cancelled'
      where component.company_id = new.company_id
        and component.payment_field_id = new.id
    ) then
    raise exception 'Reassign provider ID mappings before changing this payment field to attendance.';
  end if;
  return new;
end;
$$;

drop trigger if exists payment_fields_attendance_direct_only on public.payment_fields;
create trigger payment_fields_attendance_direct_only
before update of calculation_source on public.payment_fields
for each row execute function public.enforce_attendance_payment_field_direct_only();

create or replace function public.enforce_provider_mapping_payment_basis()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('workforce-payment-basis:' || new.company_id::text, 0));
  if new.status <> 'cancelled'
    and new.payment_method_id is not null
    and exists (
      select 1
      from public.payment_method_components component
      join public.payment_fields field
        on field.company_id = new.company_id
       and field.id = component.payment_field_id
      where component.company_id = new.company_id
        and component.payment_method_id = new.payment_method_id
        and component.is_active = true
        and field.calculation_source = 'attendance_eligibility'
    ) then
    raise exception 'Attendance-based payment methods must be assigned in Direct pay allocations.';
  end if;
  return new;
end;
$$;

drop trigger if exists field_executive_provider_mappings_payment_basis
  on public.field_executive_provider_mappings;
drop trigger if exists field_executive_provider_mappings_00_payment_basis
  on public.field_executive_provider_mappings;
-- PostgreSQL fires same-event triggers by name. The 00 prefix takes the
-- company payment-basis lock before the existing direct-overlap worker lock.
create trigger field_executive_provider_mappings_00_payment_basis
before insert or update of company_id, payment_method_id, status
on public.field_executive_provider_mappings
for each row execute function public.enforce_provider_mapping_payment_basis();

create or replace function public.enforce_payment_component_provider_basis()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('workforce-payment-basis:' || new.company_id::text, 0));
  if new.is_active = true
    and exists (
      select 1
      from public.payment_fields field
      where field.company_id = new.company_id
        and field.id = new.payment_field_id
        and field.calculation_source = 'attendance_eligibility'
    )
    and exists (
      select 1
      from public.field_executive_provider_mappings mapping
      where mapping.company_id = new.company_id
        and mapping.payment_method_id = new.payment_method_id
        and mapping.status <> 'cancelled'
    ) then
    raise exception 'Reassign provider ID mappings before adding an attendance field to this payment method.';
  end if;
  return new;
end;
$$;

drop trigger if exists payment_method_components_provider_basis
  on public.payment_method_components;
create trigger payment_method_components_provider_basis
before insert or update of payment_method_id, payment_field_id, is_active
on public.payment_method_components
for each row execute function public.enforce_payment_component_provider_basis();

drop trigger if exists workforce_payment_allocations_calculation_snapshot
  on public.workforce_payment_allocations;
drop function if exists public.enrich_workforce_payment_component_calculation();

create or replace function public.apply_workforce_payment_component_basis(
  p_company_id uuid,
  p_allocation_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.workforce_payment_allocations allocation
  set payment_components = (
    select coalesce(jsonb_agg(
      case
        when snapshot.component ? 'calculation_source' then snapshot.component
        else snapshot.component || jsonb_build_object('calculation_source', metadata.calculation_source)
      end
      order by snapshot.position
    ), '[]'::jsonb)
    from jsonb_array_elements(allocation.payment_components) with ordinality snapshot(component, position)
    left join lateral (
      select field.calculation_source
      from public.payment_method_components method_component
      left join public.payment_fields field
        on field.id = method_component.payment_field_id
       and field.company_id = allocation.company_id
      where method_component.company_id = allocation.company_id
        and method_component.payment_method_id = allocation.payment_method_id
        and method_component.component_code = snapshot.component ->> 'component_code'
      order by method_component.is_active desc, method_component.sort_order, method_component.id
      limit 1
    ) metadata on true
  )
  where allocation.id = p_allocation_id
    and allocation.company_id = p_company_id
    and jsonb_typeof(allocation.payment_components) = 'array';

  if not found then
    raise exception 'The saved direct payment allocation snapshot is unavailable.';
  end if;
end;
$$;

revoke all on function public.apply_workforce_payment_component_basis(uuid, uuid)
  from public, anon, authenticated, service_role;

revoke execute on function public.save_workforce_payment_allocation(uuid, uuid, uuid, jsonb, date, date, text, uuid)
  from service_role;

create or replace function public.save_workforce_payment_allocation_v2(
  p_company_id uuid,
  p_workforce_id uuid,
  p_payment_method_id uuid,
  p_payment_values jsonb,
  p_effective_from date,
  p_effective_to date default null,
  p_change_reason text default null,
  p_actor_user_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_allocation_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('workforce-payment-basis:' || p_company_id::text, 0));
  v_allocation_id := public.save_workforce_payment_allocation(
    p_company_id,
    p_workforce_id,
    p_payment_method_id,
    p_payment_values,
    p_effective_from,
    p_effective_to,
    p_change_reason,
    p_actor_user_id
  );
  perform public.apply_workforce_payment_component_basis(p_company_id, v_allocation_id);
  return v_allocation_id;
end;
$$;

revoke all on function public.save_workforce_payment_allocation_v2(uuid, uuid, uuid, jsonb, date, date, text, uuid)
  from public, anon, authenticated;
grant execute on function public.save_workforce_payment_allocation_v2(uuid, uuid, uuid, jsonb, date, date, text, uuid)
  to service_role;

comment on function public.save_workforce_payment_allocation_v2(uuid, uuid, uuid, jsonb, date, date, text, uuid) is
  'Saves an effective-dated direct allocation and explicitly freezes each payment field calculation source in its component snapshot.';

commit;
