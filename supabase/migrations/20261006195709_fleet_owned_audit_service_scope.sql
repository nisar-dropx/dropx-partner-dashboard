-- Audit and maintenance responsibility belongs only to company-owned vehicles.
-- Preserve historical records. Cancelling an obsolete partner schedule remains possible.
create or replace function public.fleet_require_owned_maintenance_vehicle()
returns trigger language plpgsql security invoker set search_path = public as $$
declare vehicle_ownership text;
begin
  if TG_OP = 'UPDATE' and new.company_id = old.company_id and new.vehicle_id = old.vehicle_id then
    if new.status = 'cancelled' then return new; end if;
    -- Delivery metadata on completed reports does not create new maintenance work.
    if TG_TABLE_NAME = 'fleet_audits' and old.status in ('passed', 'failed')
      and (to_jsonb(new) - array['email_status','email_sent_at','updated_at']) =
          (to_jsonb(old) - array['email_status','email_sent_at','updated_at']) then return new; end if;
  end if;
  select ownership_type into vehicle_ownership from public.fleet_vehicles
    where id = new.vehicle_id and company_id = new.company_id for share;
  if vehicle_ownership is distinct from 'own' then
    raise exception 'Audits and service are only available for DropX-owned vehicles.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.fleet_require_owned_maintenance_vehicle() from public, anon, authenticated;
create trigger fleet_audit_owned_vehicle_guard before insert or update on public.fleet_audits
for each row execute function public.fleet_require_owned_maintenance_vehicle();
create trigger fleet_service_owned_vehicle_guard before insert or update on public.fleet_service_history
for each row execute function public.fleet_require_owned_maintenance_vehicle();
