begin;

with recursive untouched_reviews as (
  select
    reviews.company_id,
    reviews.id as review_id,
    first_step.reviewer_user_id as start_profile_id
  from public.ops_performance_reviews reviews
  join public.ops_performance_review_steps first_step
    on first_step.review_id = reviews.id
   and first_step.step_order = 1
  where reviews.status = 'in_review'
    and first_step.reviewer_user_id is not null
    and not exists (
      select 1
      from public.ops_performance_review_steps completed_step
      where completed_step.review_id = reviews.id
        and completed_step.status <> 'pending'
    )
), review_chain as (
  select
    untouched_reviews.company_id,
    untouched_reviews.review_id,
    profiles.id as reviewer_user_id,
    profiles.full_name as reviewer_name,
    profiles.reports_to_user_id,
    coalesce(roles.name, roles.code, 'Reviewer') as reviewer_role,
    upper(coalesce(roles.code, roles.name, '')) as reviewer_role_key,
    profiles.is_active as reviewer_active,
    1 as step_order
  from untouched_reviews
  join public.profiles profiles
    on profiles.id = untouched_reviews.start_profile_id
   and profiles.company_id = untouched_reviews.company_id
   and profiles.is_active = true
  left join public.user_roles roles on roles.id = profiles.role_id

  union all

  select
    review_chain.company_id,
    review_chain.review_id,
    manager.id,
    manager.full_name,
    manager.reports_to_user_id,
    coalesce(manager_role.name, manager_role.code, 'Reviewer'),
    upper(coalesce(manager_role.code, manager_role.name, '')),
    manager.is_active,
    review_chain.step_order + 1
  from review_chain
  join public.profiles manager
    on manager.id = review_chain.reports_to_user_id
   and manager.company_id = review_chain.company_id
  left join public.user_roles manager_role on manager_role.id = manager.role_id
  where review_chain.step_order < 7
    and review_chain.reviewer_role_key not like '%NATIONAL%HEAD%'
    and review_chain.reviewer_role_key not like '%OWNER%'
), active_review_chain as (
  select
    review_chain.company_id,
    review_chain.review_id,
    review_chain.reviewer_user_id,
    review_chain.reviewer_name,
    review_chain.reviewer_role,
    row_number() over (
      partition by review_chain.review_id
      order by review_chain.step_order
    )::integer as step_order
  from review_chain
  where review_chain.reviewer_active = true
    and review_chain.reviewer_role_key not like '%OWNER%'
)
insert into public.ops_performance_review_steps (
  company_id,
  review_id,
  step_order,
  reviewer_user_id,
  reviewer_name,
  reviewer_role,
  status,
  created_at,
  updated_at
)
select
  active_review_chain.company_id,
  active_review_chain.review_id,
  active_review_chain.step_order,
  active_review_chain.reviewer_user_id,
  coalesce(nullif(active_review_chain.reviewer_name, ''), 'Assigned reviewer'),
  active_review_chain.reviewer_role,
  'pending',
  now(),
  now()
from active_review_chain
on conflict (review_id, step_order) do update set
  reviewer_user_id = excluded.reviewer_user_id,
  reviewer_name = excluded.reviewer_name,
  reviewer_role = excluded.reviewer_role,
  updated_at = now()
where ops_performance_review_steps.status = 'pending';

commit;
