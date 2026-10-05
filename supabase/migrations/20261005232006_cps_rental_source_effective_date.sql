-- Start the source handover when Fleet rental coverage begins. Preserve costs
-- in earlier months and any source rule that a user has already edited.
with fleet_start as (
 select p.company_id,min(greatest(p.effective_from,r.effective_from)) as starts_on
 from public.fleet_vehicle_cost_placements p
 join public.fleet_vehicle_rent_rates r on r.company_id=p.company_id and r.vehicle_id=p.vehicle_id
  and coalesce(p.effective_to,'infinity'::date)>=r.effective_from
  and coalesce(r.effective_to,'infinity'::date)>=p.effective_from
 where p.deployed
 group by p.company_id
)
update public.ops_cps_component_policies c set effective_from=f.starts_on,updated_at=now()
from fleet_start f
where c.company_id=f.company_id and c.mode='fleet' and c.updated_by is null
 and c.effective_from<f.starts_on
 and not exists(select 1 from public.ops_cps_component_policies other where other.company_id=c.company_id and other.component_code=c.component_code and other.effective_from=f.starts_on);
