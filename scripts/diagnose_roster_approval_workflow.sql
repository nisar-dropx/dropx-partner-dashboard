-- Trace roster approval queue for a station or approver.
-- Replace station_code and/or approver email before running.

with target_station as (
  select upper(btrim('BLR01')) as station_code
),
target_approver as (
  select lower(btrim('nisar@example.com')) as email
)
select
  plan.id::text as plan_id,
  station.station_code,
  plan.name,
  plan.status,
  plan.roster_kind,
  plan.effective_from,
  plan.period_end,
  plan.revision_no,
  plan.submitted_at,
  count(entry.id) as entry_count
from public.hr_roster_plans plan
join public.stations station on station.id = plan.location_id
cross join target_station
where upper(btrim(station.station_code)) = target_station.station_code
group by plan.id, station.station_code, plan.name, plan.status, plan.roster_kind, plan.effective_from, plan.period_end, plan.revision_no, plan.submitted_at
order by plan.submitted_at desc nulls last, plan.created_at desc
limit 10;

with target_approver as (
  select lower(btrim('nisar@example.com')) as email
)
select
  step.id::text as step_id,
  step.plan_id::text,
  step.stage_no,
  step.stage_type,
  step.status,
  profile.full_name as approver_name,
  profile.email as approver_email
from public.hr_roster_approval_steps step
left join public.profiles profile on profile.id = step.approver_user_id
cross join target_approver
where step.status in ('pending', 'waiting')
  and (
    target_approver.email = ''
    or lower(btrim(profile.email)) = target_approver.email
    or step.approver_user_id is null
  )
order by step.created_at desc
limit 20;
