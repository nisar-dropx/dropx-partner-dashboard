-- Fix: supersede stale recurring_weekly roster plans platform-wide
-- Date: 2026-11-27
-- Reason: retireFullyReplacedRosterPlans (Ops publish path) only retired plans
-- when the new plan had all 7 days per worker. Plans with missing weekly-off
-- entries stayed live alongside newer plans, showing old shifts in the app.
-- 24 stations affected. Code fix already deployed; this cleans up existing data.
--
-- Safe: only sets superseded_at on recurring_weekly plans that have a newer
-- approved sibling at the same station. Never deletes anything.
--
-- Run the SELECT first to confirm, then the UPDATE.

-- PREVIEW (no changes):
select
  s.station_code,
  s.station_name,
  old_p.id as old_plan_id,
  old_p.name as old_plan_name,
  old_p.effective_from as old_effective_from,
  p.effective_from as new_superseded_at
from hr_roster_plans p
join stations s on s.id = p.location_id
join hr_roster_plans old_p on old_p.location_id = p.location_id
  and old_p.status = 'approved'
  and old_p.roster_kind = 'recurring_weekly'
  and old_p.superseded_at is null
  and old_p.id != p.id
  and old_p.effective_from < p.effective_from
where p.status = 'approved'
  and p.roster_kind = 'recurring_weekly'
  and p.superseded_at is null
  and not exists (
    select 1 from hr_roster_plans newer
    where newer.location_id = p.location_id
      and newer.status = 'approved'
      and newer.roster_kind = 'recurring_weekly'
      and newer.superseded_at is null
      and (newer.effective_from > p.effective_from
        or (newer.effective_from = p.effective_from and newer.revision_no > p.revision_no))
  )
order by s.station_code, old_p.effective_from;

-- APPLY:
update hr_roster_plans
set superseded_at = newest.effective_from
from (
  select p.effective_from, old_p.id as old_id
  from hr_roster_plans p
  join stations s on s.id = p.location_id
  join hr_roster_plans old_p on old_p.location_id = p.location_id
    and old_p.status = 'approved'
    and old_p.roster_kind = 'recurring_weekly'
    and old_p.superseded_at is null
    and old_p.id != p.id
    and old_p.effective_from < p.effective_from
  where p.status = 'approved'
    and p.roster_kind = 'recurring_weekly'
    and p.superseded_at is null
    and not exists (
      select 1 from hr_roster_plans newer
      where newer.location_id = p.location_id
        and newer.status = 'approved'
        and newer.roster_kind = 'recurring_weekly'
        and newer.superseded_at is null
        and (newer.effective_from > p.effective_from
          or (newer.effective_from = p.effective_from and newer.revision_no > p.revision_no))
    )
) newest
where hr_roster_plans.id = newest.old_id;

-- EXTRA: TCD4 has two plans with the same effective_from=2026-11-23 and revision_no=6.
-- The app picks the one with the later updated_at (see compareRosterPlanPreference).
-- Supersede the older one by its updated_at to leave exactly one live plan.
-- Preview:
select id, name, effective_from, revision_no, superseded_at, updated_at
from hr_roster_plans
where location_id = (select id from stations where station_code = 'TCD4')
  and status = 'approved'
  and roster_kind = 'recurring_weekly'
  and effective_from = '2026-11-23'
  and superseded_at is null
order by updated_at desc;

-- Apply (supersedes the older of the two 2026-11-23 plans — the one with the earlier updated_at):
update hr_roster_plans
set superseded_at = '2026-11-23'
where id = (
  select id from hr_roster_plans
  where location_id = (select id from stations where station_code = 'TCD4')
    and status = 'approved'
    and roster_kind = 'recurring_weekly'
    and effective_from = '2026-11-23'
    and superseded_at is null
  order by updated_at asc   -- oldest updated_at = less recent publish = supersede this one
  limit 1
);

-- VERIFY (run after UPDATE — each station should show exactly 1 NOW LIVE plan):
select
  s.station_code,
  count(*) filter (
    where p.status = 'approved'
      and (p.superseded_at is null or current_date < p.superseded_at::date)
      and p.effective_from::date <= current_date
  ) as live_recurring_count
from hr_roster_plans p
join stations s on s.id = p.location_id
where p.status = 'approved'
  and p.roster_kind = 'recurring_weekly'
group by s.station_code
having count(*) filter (
    where p.status = 'approved'
      and (p.superseded_at is null or current_date < p.superseded_at::date)
      and p.effective_from::date <= current_date
  ) > 1
order by s.station_code;
-- Should return 0 rows.
