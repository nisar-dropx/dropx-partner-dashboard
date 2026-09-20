begin;

-- Reimbursement claim approvals: L1 immediate reporting manager, L2 finance head.
update public.hr_approval_workflow_catalog
set description = 'Employee and contractor expense claims. Level 1 is the immediate reporting manager. Level 2 is Finance head / Finance Manager.',
    no_route_fallback_name = 'Reporting manager then Finance head',
    updated_at = now()
where workflow_code = 'reimbursement';

with companies as (
  select distinct company_id from public.designations where is_active
),
finance_designations as (
  select distinct on (company_id)
    company_id,
    id as finance_designation_id
  from public.designations
  where is_active
    and (
      upper(replace(coalesce(code, ''), '-', '_')) in ('FINMGR', 'FINANCE_MANAGER', 'FINANCE_HEAD', 'FIN_HEAD')
      or lower(name) like '%finance manager%'
      or lower(name) like '%finance head%'
    )
  order by company_id,
    case
      when upper(replace(coalesce(code, ''), '-', '_')) = 'FINMGR' then 1
      when lower(name) like '%finance manager%' then 2
      else 3
    end,
    name
),
manager_designations as (
  select distinct on (company_id)
    company_id,
    id as manager_designation_id
  from public.designations
  where is_active
    and not (
      lower(name) like '%team lead%'
      or lower(name) like '%team-lead%'
      or upper(replace(coalesce(code, ''), '-', '_')) in ('TL', 'ATL', 'TEAM_LEAD', 'ASST_TEAM_LEAD', 'ASSISTANT_TEAM_LEAD')
    )
  order by company_id,
    case
      when lower(name) like '%national%head%' or upper(code) in ('NH', 'NATHD') then 1
      when lower(name) like '%manager%' then 2
      else 3
    end,
    name
),
finance_people as (
  select distinct on (assignment.company_id)
    assignment.company_id,
    engagement.person_id as finance_person_id
  from public.hr_work_assignments assignment
  join public.hr_engagements engagement
    on engagement.company_id = assignment.company_id
   and engagement.id = assignment.engagement_id
   and engagement.status = 'active'
  join finance_designations finance
    on finance.company_id = assignment.company_id
   and finance.finance_designation_id = assignment.designation_id
  where assignment.is_primary
    and assignment.effective_to is null
  order by assignment.company_id, assignment.effective_from
),
targets as (
  select
    designation.company_id,
    designation.id as requester_designation_id,
    designation.name as requester_designation_name,
    coalesce(manager.manager_designation_id, designation.id) as level_1_designation_id,
    finance.finance_designation_id,
    finance_people.finance_person_id
  from public.designations designation
  join public.designation_categories category
    on category.company_id = designation.company_id
   and category.id = designation.designation_category_id
   and category.is_active
   and category.people_module = 'people_hr'
  join manager_designations manager on manager.company_id = designation.company_id
  join finance_designations finance on finance.company_id = designation.company_id
  left join finance_people on finance_people.company_id = designation.company_id
  where designation.is_active
),
upserted as (
  insert into public.hr_approval_workflow_routes (
    company_id, workflow_code, requester_designation_id, location_id, route_name,
    level_1_designation_id, level_1_search_scope, level_1_fallback_mode, level_1_fallback_person_id,
    level_2_required, level_2_designation_id, level_2_search_scope, level_2_fallback_mode, level_2_fallback_person_id,
    hr_final_required, hr_final_designation_id, hr_final_search_scope, hr_final_fallback_mode, hr_final_fallback_person_id,
    priority, is_active
  )
  select
    target.company_id,
    'reimbursement',
    target.requester_designation_id,
    null,
    target.requester_designation_name || ' · Reimbursement',
    target.level_1_designation_id,
    'immediate_reporting_manager',
    'next_reporting_manager',
    null,
    true,
    target.finance_designation_id,
    'same_region',
    case when target.finance_person_id is null then 'next_reporting_manager' else 'specific_person' end,
    target.finance_person_id,
    false,
    null,
    'same_location',
    'next_reporting_manager',
    null,
    100,
    true
  from targets target
  where not exists (
    select 1
    from public.hr_approval_workflow_routes route
    where route.company_id = target.company_id
      and route.workflow_code = 'reimbursement'
      and route.requester_designation_id = target.requester_designation_id
      and route.requester_person_id is null
      and route.location_id is null
      and route.is_active
  )
  returning id
)
update public.hr_approval_workflow_routes route
set
  level_1_search_scope = 'immediate_reporting_manager',
  level_1_fallback_mode = 'next_reporting_manager',
  level_2_required = true,
  level_2_designation_id = coalesce(route.level_2_designation_id, finance.finance_designation_id),
  level_2_search_scope = 'same_region',
  level_2_fallback_mode = case when finance_people.finance_person_id is null then route.level_2_fallback_mode else 'specific_person' end,
  level_2_fallback_person_id = coalesce(finance_people.finance_person_id, route.level_2_fallback_person_id),
  hr_final_required = false,
  updated_at = now()
from finance_designations finance
left join finance_people on finance_people.company_id = finance.company_id
where route.company_id = finance.company_id
  and route.workflow_code = 'reimbursement'
  and route.is_active
  and route.requester_person_id is null;

commit;
