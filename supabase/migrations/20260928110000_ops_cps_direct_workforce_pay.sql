begin;

-- Feed designation policy, direct allocations and canonical attendance into the
-- server-side CPS rebuild. Source records remain immutable; the TypeScript
-- engine applies effective dates and exposes configuration gaps.
create or replace function public.ops_cps_source_facts(p_company uuid,p_from date,p_through date,p_stations text[])
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare
 v_station_ids uuid[] := '{}'::uuid[];
 v_workforce_ids uuid[] := '{}'::uuid[];
 v_employee_ids uuid[] := '{}'::uuid[];
 v_fact_station_ids uuid[] := '{}'::uuid[];
begin
 if p_company is null or p_stations is null or cardinality(p_stations)>150 or p_from is null or p_through is null
   or p_through<p_from or p_through-p_from>30 or date_trunc('month',p_from)<>date_trunc('month',p_through)
   or p_through>(now() at time zone 'Asia/Kolkata')::date then raise exception 'Invalid CPS scope'; end if;

 -- Start with the caller's authorized/filter-selected station scope. Historical
 -- allocation and mapping stations are expanded only for workers that can affect
 -- that scope, so fixed pay keeps its cross-station denominator without loading
 -- every workforce, attendance and shipment row in the company.
 select coalesce(array_agg(station.id), '{}'::uuid[])
 into v_station_ids
 from public.stations station
 where station.company_id=p_company
   and station.station_code=any(p_stations);

 select coalesce(array_agg(distinct workforce.id), '{}'::uuid[])
 into v_workforce_ids
 from public.workforce workforce
 where workforce.company_id=p_company
   and (
     (
       workforce.location_id=any(v_station_ids)
       and not exists (
         select 1
         from public.workforce_payment_policy_history policy
         where policy.company_id=p_company
           and policy.workforce_id=workforce.id
           and policy.effective_from<=p_through
           and coalesce(policy.effective_to,p_through)>=p_from
       )
     )
     or exists (
       select 1
       from public.workforce_payment_policy_history policy
       where policy.company_id=p_company
         and policy.workforce_id=workforce.id
         and policy.effective_from<=p_through
         and coalesce(policy.effective_to,p_through)>=p_from
         and policy.station_id=any(v_station_ids)
     )
     or exists (
       select 1
       from public.workforce_payment_allocations allocation
       where allocation.company_id=p_company
         and allocation.workforce_id=workforce.id
         and allocation.status in ('active','closed')
         and allocation.effective_from<=p_through
         and coalesce(allocation.effective_to,p_through)>=p_from
         and (
           allocation.station_id=any(v_station_ids)
           or (allocation.station_id is null and workforce.location_id=any(v_station_ids))
         )
     )
     or exists (
       select 1
       from public.field_executive_provider_mappings mapping
       where mapping.company_id=p_company
         and mapping.status in ('active','closed')
         and mapping.effective_from<=p_through
         and coalesce(mapping.effective_to,p_through)>=p_from
         and (
           mapping.workforce_id=workforce.id
           or mapping.field_executive_id=workforce.id
           or (workforce.source_profile_type='employee' and mapping.employee_id=workforce.source_profile_id)
           or (workforce.source_profile_type='contractor' and mapping.contractor_id=workforce.source_profile_id)
           or (workforce.source_profile_type='field_executive' and mapping.field_executive_id=workforce.source_profile_id)
         )
         and (
           mapping.station_id=any(v_station_ids)
           or (
             mapping.station_id is null
             and exists (
               select 1
               from public.cps_shipment_daily shipment
               where shipment.company_id=p_company
                 and shipment.work_date between p_from and p_through
                 and shipment.station_code=any(p_stations)
                 and upper(btrim(shipment.provider_employee_id))=upper(btrim(mapping.provider_member_id))
             )
           )
         )
     )
   );

 -- Include only People rows that can allocate into the requested scope. Rules,
 -- org scopes, manager ownership and regional/HO fallback mirror the engine's
 -- allocation paths; employee-backed workforce rows are included for CTC de-dupe.
 select coalesce(array_agg(distinct employee.id), '{}'::uuid[])
 into v_employee_ids
 from public.employees employee
 left join public.stations home
   on home.id=employee.location_id and home.company_id=p_company
 left join public.org_positions position
   on position.id=employee.org_position_id and position.company_id=p_company
  where employee.company_id=p_company
    and (
      exists (
        select 1 from public.workforce workforce
        where workforce.id=any(v_workforce_ids)
          and workforce.source_profile_type='employee'
         and workforce.source_profile_id=employee.id
     )
     or exists (
       select 1 from public.ops_cps_cost_inputs input
       where input.company_id=p_company
         and input.employee_id=employee.id
         and input.is_active
         and input.effective_from<=p_through
         and coalesce(input.effective_to,p_through)>=p_from
          and input.station_codes&&p_stations
      )
      or (
        -- Once a field-operations employee has an honest dated Workforce
        -- assignment, current People location/region is no longer evidence for
        -- historical station ownership. The linked scoped Workforce branch above
        -- or an explicit People rule remains authoritative.
        not exists (
          select 1
          from public.workforce linked_workforce
          join public.workforce_payment_policy_history policy
            on policy.company_id=linked_workforce.company_id
           and policy.workforce_id=linked_workforce.id
           and policy.effective_from<=p_through
           and coalesce(policy.effective_to,p_through)>=p_from
           and policy.designation_is_active
           and policy.is_field_operations
          where linked_workforce.company_id=p_company
            and linked_workforce.source_profile_type='employee'
            and linked_workforce.source_profile_id=employee.id
        )
        and (
          employee.location_id=any(v_station_ids)
          or position.location_scope_ids&&v_station_ids
          or exists (
            select 1 from public.stations selected_station
            where selected_station.id=any(v_station_ids)
              and (
                upper(btrim(selected_station.cluster_manager_email))=upper(btrim(employee.email))
                or upper(btrim(selected_station.ops_manager_email))=upper(btrim(employee.email))
              )
          )
          or (cardinality(v_station_ids)>0 and home.station_code~*'^HO(_|$)')
          or exists (
            select 1 from public.stations selected_station
            where selected_station.id=any(v_station_ids)
              and (
                (nullif(btrim(home.region),'') is not null and upper(btrim(selected_station.region))=upper(btrim(home.region)))
                or (nullif(btrim(home.region),'') is null and nullif(btrim(home.state),'') is not null and upper(btrim(selected_station.state))=upper(btrim(home.state)))
              )
          )
        )
      )
    );

 -- The engine needs station masters and aggregated volumes for the complete
 -- allocation universe of only those scoped workers/employees. This prevents a
 -- one-station view from receiving an inflated share of a multi-station salary.
 select coalesce(array_agg(distinct station.id), '{}'::uuid[])
 into v_fact_station_ids
 from public.stations station
 where station.company_id=p_company
   and (
     station.id=any(v_station_ids)
     or exists (
       select 1 from public.field_executive_provider_mappings mapping
       where mapping.company_id=p_company
         and mapping.status in ('active','closed')
         and mapping.effective_from<=p_through
         and coalesce(mapping.effective_to,p_through)>=p_from
         and mapping.station_id=station.id
         and exists (
           select 1 from public.workforce workforce
           where workforce.id=any(v_workforce_ids)
             and (
               mapping.workforce_id=workforce.id
               or mapping.field_executive_id=workforce.id
               or (workforce.source_profile_type='employee' and mapping.employee_id=workforce.source_profile_id)
               or (workforce.source_profile_type='contractor' and mapping.contractor_id=workforce.source_profile_id)
               or (workforce.source_profile_type='field_executive' and mapping.field_executive_id=workforce.source_profile_id)
             )
         )
     )
      or exists (
        select 1 from public.workforce_payment_allocations allocation
       where allocation.company_id=p_company
         and allocation.workforce_id=any(v_workforce_ids)
         and allocation.status in ('active','closed')
         and allocation.effective_from<=p_through
         and coalesce(allocation.effective_to,p_through)>=p_from
          and allocation.station_id=station.id
      )
      or exists (
        select 1 from public.workforce_payment_policy_history policy
        where policy.company_id=p_company
          and policy.workforce_id=any(v_workforce_ids)
          and policy.effective_from<=p_through
          and coalesce(policy.effective_to,p_through)>=p_from
          and policy.station_id=station.id
      )
      or exists (select 1 from public.employees employee where employee.id=any(v_employee_ids) and employee.location_id=station.id)
     or exists (
       select 1 from public.ops_cps_cost_inputs input
       where input.company_id=p_company
         and input.employee_id=any(v_employee_ids)
         and input.is_active
         and input.effective_from<=p_through
         and coalesce(input.effective_to,p_through)>=p_from
         and station.station_code=any(input.station_codes)
     )
     or exists (
       select 1 from public.employees employee
       join public.org_positions position on position.id=employee.org_position_id and position.company_id=p_company
       where employee.id=any(v_employee_ids) and station.id=any(position.location_scope_ids)
     )
     or exists (
       select 1 from public.employees employee
       where employee.id=any(v_employee_ids)
         and employee.email is not null
         and (
           upper(btrim(station.cluster_manager_email))=upper(btrim(employee.email))
           or upper(btrim(station.ops_manager_email))=upper(btrim(employee.email))
         )
     )
     or exists (
       select 1
       from public.employees employee
       join public.stations home on home.id=employee.location_id and home.company_id=p_company
       where employee.id=any(v_employee_ids)
         and station.is_active
         and not coalesce(station.hide_from_location_list,false)
         and (
           home.station_code~*'^HO(_|$)'
           or (nullif(btrim(home.region),'') is not null and upper(btrim(station.region))=upper(btrim(home.region)))
           or (nullif(btrim(home.region),'') is null and nullif(btrim(home.state),'') is not null and upper(btrim(station.state))=upper(btrim(home.state)))
         )
     )
   );

 return jsonb_build_object(
 'shipments',coalesce((select jsonb_agg(t) from (
   select shipment.id,shipment.client,shipment.work_date,shipment.station_code,shipment.provider_employee_id,shipment.provider_employee_name,shipment.amazon_delivery,shipment.swa_delivery,shipment.total_delivery,shipment.total_activity,shipment.c_return,shipment.mfn,shipment.mfn_return
   from public.cps_shipment_daily shipment
   where shipment.company_id=p_company
     and shipment.work_date between p_from and p_through
     and (
       shipment.station_code=any(p_stations)
       or exists (
         select 1
         from public.field_executive_provider_mappings mapping
         join public.providers provider on provider.id=mapping.provider_id and provider.company_id=p_company
         where mapping.company_id=p_company
           and mapping.status in ('active','closed')
           and mapping.effective_from<=shipment.work_date
           and coalesce(mapping.effective_to,shipment.work_date)>=shipment.work_date
           and upper(btrim(mapping.provider_member_id))=upper(btrim(shipment.provider_employee_id))
           and (mapping.station_id is null or mapping.station_id in (
             select fact_station.id from public.stations fact_station where fact_station.company_id=p_company and fact_station.station_code=shipment.station_code
           ))
           and position(regexp_replace(upper(coalesce(shipment.client,'')),'[^A-Z0-9]','','g') in regexp_replace(upper(coalesce(provider.code,'')||coalesce(provider.name,'')),'[^A-Z0-9]','','g'))>0
           and exists (
             select 1 from public.workforce workforce
             where workforce.id=any(v_workforce_ids)
               and (
                 mapping.workforce_id=workforce.id
                 or mapping.field_executive_id=workforce.id
                 or (workforce.source_profile_type='employee' and mapping.employee_id=workforce.source_profile_id)
                 or (workforce.source_profile_type='contractor' and mapping.contractor_id=workforce.source_profile_id)
                 or (workforce.source_profile_type='field_executive' and mapping.field_executive_id=workforce.source_profile_id)
               )
           )
       )
     )
 )t),'[]'::jsonb),
 'volumes',coalesce((select jsonb_agg(t) from (
   select shipment.station_code,shipment.work_date,sum(shipment.total_delivery) deliveries
   from public.cps_shipment_daily shipment
   where shipment.company_id=p_company
     and shipment.work_date between p_from and p_through
     and exists (
       select 1 from public.stations station
       where station.id=any(v_fact_station_ids) and station.station_code=shipment.station_code
     )
   group by shipment.station_code,shipment.work_date
 )t),'[]'::jsonb),
 'mappings',coalesce((select jsonb_agg(t) from (
   select mapping.id,mapping.workforce_id,mapping.employee_id,mapping.contractor_id,mapping.field_executive_id,mapping.provider_id,mapping.provider_member_id,mapping.station_id,mapping.effective_from,mapping.effective_to,mapping.status,mapping.pay_type,mapping.payment_method_id,mapping.payment_values,mapping.delivery_rate,mapping.pickup_rate,mapping.mfn_rate,mapping.mfn_return_rate,mapping.guarantee_amount,mapping.guarantee_schedule,mapping.fuel_rate
   from public.field_executive_provider_mappings mapping
   where mapping.company_id=p_company
     and mapping.status in ('active','closed')
     and mapping.effective_from<=p_through
     and coalesce(mapping.effective_to,p_through)>=p_from
     and (
       mapping.station_id=any(v_station_ids)
       or (mapping.station_id is null and exists (
         select 1 from public.cps_shipment_daily shipment
         where shipment.company_id=p_company
           and shipment.work_date between p_from and p_through
           and shipment.station_code=any(p_stations)
           and upper(btrim(shipment.provider_employee_id))=upper(btrim(mapping.provider_member_id))
       ))
       or exists (
         select 1 from public.workforce workforce
         where workforce.id=any(v_workforce_ids)
           and (
             mapping.workforce_id=workforce.id
             or mapping.field_executive_id=workforce.id
             or (workforce.source_profile_type='employee' and mapping.employee_id=workforce.source_profile_id)
             or (workforce.source_profile_type='contractor' and mapping.contractor_id=workforce.source_profile_id)
             or (workforce.source_profile_type='field_executive' and mapping.field_executive_id=workforce.source_profile_id)
           )
       )
     )
 )t),'[]'::jsonb),
 'allocations',coalesce((select jsonb_agg(t) from (
   select allocation.id,allocation.workforce_id,allocation.station_id,allocation.designation_id,allocation.payment_method_id,allocation.payment_values,allocation.payment_components,allocation.effective_from,allocation.effective_to,allocation.status
   from public.workforce_payment_allocations allocation
   where allocation.company_id=p_company
     and allocation.status in ('active','closed')
     and allocation.effective_from<=p_through
     and coalesce(allocation.effective_to,p_through)>=p_from
     and allocation.workforce_id=any(v_workforce_ids)
 )t),'[]'::jsonb),
 'attendance',coalesce((select jsonb_agg(t) from (
   select attendance.workforce_id,attendance.punch_date,attendance.status,attendance.in_time,attendance.out_time,attendance.work_minutes
   from public.attendance_daily attendance
   where attendance.company_id=p_company
     and attendance.workforce_id is not null
     and attendance.punch_date between p_from and p_through
     and attendance.workforce_id=any(v_workforce_ids)
 )t),'[]'::jsonb),
 'workforce',coalesce((select jsonb_agg(t) from (
    select workforce.id,workforce.dropx_id,workforce.full_name,workforce.location_id,workforce.date_of_join,workforce.last_working_date,workforce.is_active,workforce.deleted_at,workforce.source_profile_type,workforce.source_profile_id,workforce.designation_id,
      coalesce(designation.is_active,false) as designation_is_active,
      (coalesce(designation.is_active,false) and coalesce(designation.is_field_operations,false)) as is_field_operations,
      (coalesce(designation.is_active,false) and coalesce(designation.is_field_operations,false) and coalesce(designation.provider_mapping_required,true)) as provider_mapping_required
   from public.workforce workforce
   left join lateral (
     select candidate.* from public.designations candidate
     where candidate.company_id=workforce.company_id
       and (candidate.id=workforce.designation_id or (workforce.designation_id is null and lower(btrim(workforce.designation)) in (lower(btrim(candidate.code)),lower(btrim(candidate.name)))))
     order by (candidate.id=workforce.designation_id) desc,candidate.id limit 1
   ) designation on true
   where workforce.company_id=p_company and workforce.id=any(v_workforce_ids)
 )t),'[]'::jsonb),
 'policy_history',coalesce((select jsonb_agg(t) from (
    select policy.id,policy.workforce_id,policy.station_id,policy.station_code_snapshot,
      policy.designation_id,policy.designation_code_snapshot,policy.designation_name_snapshot,
      policy.designation_is_active,policy.is_field_operations,policy.provider_mapping_required,
      policy.effective_from,policy.effective_to
   from public.workforce_payment_policy_history policy
   where policy.company_id=p_company
     and policy.workforce_id=any(v_workforce_ids)
     and policy.effective_from<=p_through
     and coalesce(policy.effective_to,p_through)>=p_from
 )t),'[]'::jsonb),
 'components',coalesce((select jsonb_agg(t) from (
   select component.payment_method_id,component.component_code,component.component_type,coalesce(field.label,component.label) label,coalesce(field.pay_schedule,component.pay_schedule) pay_schedule,field.calculation_type,field.calculation_source,field.provider_calculation_sources
   from public.payment_method_components component
   left join public.payment_fields field on field.id=component.payment_field_id and field.company_id=p_company
   where component.company_id=p_company and component.is_active
     and (
       exists (
         select 1 from public.field_executive_provider_mappings mapping
         where mapping.company_id=p_company and mapping.payment_method_id=component.payment_method_id
           and mapping.status in ('active','closed') and mapping.effective_from<=p_through and coalesce(mapping.effective_to,p_through)>=p_from
           and exists (
             select 1 from public.workforce workforce
             where workforce.id=any(v_workforce_ids)
               and (
                 mapping.workforce_id=workforce.id
                 or mapping.field_executive_id=workforce.id
                 or (workforce.source_profile_type='employee' and mapping.employee_id=workforce.source_profile_id)
                 or (workforce.source_profile_type='contractor' and mapping.contractor_id=workforce.source_profile_id)
                 or (workforce.source_profile_type='field_executive' and mapping.field_executive_id=workforce.source_profile_id)
               )
           )
       )
       or exists (
         select 1 from public.workforce_payment_allocations allocation
         where allocation.company_id=p_company and allocation.payment_method_id=component.payment_method_id
           and allocation.status in ('active','closed') and allocation.effective_from<=p_through and coalesce(allocation.effective_to,p_through)>=p_from
           and allocation.workforce_id=any(v_workforce_ids)
       )
     )
 )t),'[]'::jsonb),
 'providers',coalesce((select jsonb_agg(t) from (
   select provider.id,provider.code,provider.name
   from public.providers provider
   where provider.company_id=p_company
     and exists (
       select 1 from public.field_executive_provider_mappings mapping
       where mapping.company_id=p_company and mapping.provider_id=provider.id
         and mapping.status in ('active','closed') and mapping.effective_from<=p_through and coalesce(mapping.effective_to,p_through)>=p_from
         and (
           mapping.station_id=any(v_station_ids)
           or (mapping.station_id is null and exists (
             select 1 from public.cps_shipment_daily shipment
             where shipment.company_id=p_company
               and shipment.work_date between p_from and p_through
               and shipment.station_code=any(p_stations)
               and upper(btrim(shipment.provider_employee_id))=upper(btrim(mapping.provider_member_id))
           ))
           or exists (
             select 1 from public.workforce workforce
             where workforce.id=any(v_workforce_ids)
               and (
                 mapping.workforce_id=workforce.id
                 or mapping.field_executive_id=workforce.id
                 or (workforce.source_profile_type='employee' and mapping.employee_id=workforce.source_profile_id)
                 or (workforce.source_profile_type='contractor' and mapping.contractor_id=workforce.source_profile_id)
                 or (workforce.source_profile_type='field_executive' and mapping.field_executive_id=workforce.source_profile_id)
               )
           )
         )
     )
 )t),'[]'::jsonb),
 'stations',coalesce((select jsonb_agg(t) from (
   select station.id,station.station_code,station.region,station.state,station.cluster,station.cluster_name,station.cluster_manager_email,station.ops_manager_email,station.is_active,station.hide_from_location_list
   from public.stations station where station.company_id=p_company and station.id=any(v_fact_station_ids)
 )t),'[]'::jsonb),
 'employees',coalesce((select jsonb_agg(t) from (
   select employee.id,employee.employee_code,employee.full_name,employee.email,employee.location_id,employee.date_of_join,employee.last_working_date,employee.is_active,employee.deleted_at,designation.code designation,position.location_access_mode,position.location_scope_ids
   from public.employees employee
   left join public.designations designation on designation.id=employee.designation_id
   left join public.org_positions position on position.id=employee.org_position_id and position.company_id=p_company
   where employee.company_id=p_company and employee.id=any(v_employee_ids)
 )t),'[]'::jsonb),
 'salaries',coalesce((select jsonb_agg(t) from (
   select assignment.id,assignment.employee_id,assignment.effective_from,assignment.effective_to,max(value.amount) filter(where head.head_type='ctc') monthly_ctc
   from public.hr_employee_salary_assignments assignment
   left join public.hr_employee_salary_values value on value.assignment_id=assignment.id and value.company_id=p_company
   left join public.hr_payroll_heads head on head.id=value.payroll_head_id and head.company_id=p_company
   where assignment.company_id=p_company and assignment.employee_id=any(v_employee_ids)
     and assignment.effective_from<=p_through and coalesce(assignment.effective_to,p_through)>=p_from
   group by assignment.id,assignment.employee_id,assignment.effective_from,assignment.effective_to
 )t),'[]'::jsonb),
 'rent_coverage',coalesce((select jsonb_agg(t) from (
   select rent.allocation_station_code station_code,rent.effective_from,rent.effective_to
   from public.finance_rent_master rent
   where rent.company_id=p_company and rent.deleted_at is null
     and rent.allocation_station_code=any(p_stations)
     and rent.effective_from<=p_through and coalesce(rent.effective_to,p_through)>=p_from
 )t),'[]'::jsonb),
 'manual_inputs',coalesce((select jsonb_agg(input) from public.ops_cps_cost_inputs input
   where input.company_id=p_company and input.employee_id is null and input.is_active
     and input.station_codes&&p_stations
     and input.effective_from<=p_through and coalesce(input.effective_to,p_through)>=p_from
 ),'[]'::jsonb),
 'people_rules',coalesce((select jsonb_agg(input) from public.ops_cps_cost_inputs input
   where input.company_id=p_company and input.employee_id=any(v_employee_ids) and input.is_active
     and input.effective_from<=p_through and coalesce(input.effective_to,p_through)>=p_from
 ),'[]'::jsonb),
 'generated_at',now());
end; $$;

revoke all on function public.ops_cps_source_facts(uuid,date,date,text[]) from public,anon,authenticated;
grant execute on function public.ops_cps_source_facts(uuid,date,date,text[]) to service_role;

notify pgrst, 'reload schema';

commit;
