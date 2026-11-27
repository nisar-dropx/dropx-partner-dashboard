-- =============================================================
-- Roster stale-plan diagnostic & fix
-- Covers: TCD4, TCC3, and any other station with the same bug.
--
-- HOW TO USE:
--   Run each numbered section separately in Supabase SQL editor.
--   Read the output of each before running the next one.
-- =============================================================


-- =============================================================
-- SECTION 1: Platform-wide — all stations with more than one
-- live (approved + not superseded + effective today) plan.
-- These are stations where the app may show stale roster.
-- =============================================================

with live_plans as (
  select
    p.id,
    p.name,
    p.status,
    p.roster_kind,
    p.effective_from,
    p.superseded_at,
    p.revision_no,
    p.location_id,
    s.station_code,
    s.station_name
  from hr_roster_plans p
  join stations s on s.id = p.location_id
  where p.status = 'approved'
    and (p.superseded_at is null or current_date < p.superseded_at::date)
    and p.effective_from::date <= current_date
),
station_counts as (
  select
    station_code,
    station_name,
    location_id,
    count(*) as live_plan_count,
    count(*) filter (where roster_kind = 'recurring_weekly') as live_recurring_count,
    count(*) filter (where roster_kind = 'dated') as live_dated_count,
    max(effective_from) as newest_effective_from,
    min(effective_from) as oldest_effective_from
  from live_plans
  group by station_code, station_name, location_id
)
select
  station_code,
  station_name,
  live_plan_count,
  live_recurring_count,
  live_dated_count,
  newest_effective_from,
  oldest_effective_from,
  case
    when live_recurring_count > 1 then '❌ PROBLEM: multiple live recurring plans — old roster still active'
    when live_recurring_count = 1 and live_dated_count >= 1 then '✅ Normal (recurring baseline + dated override)'
    when live_recurring_count = 1 then '✅ OK'
    when live_recurring_count = 0 and live_dated_count > 0 then '⚠️ Dated-only — no recurring baseline'
    else '⚠️ Check manually'
  end as status
from station_counts
where live_plan_count > 1
order by live_recurring_count desc, station_code;


-- =============================================================
-- SECTION 2: Detailed view for TCD4, TCC3 (and any others).
-- Shows every approved plan — live or superseded — per station.
-- Add more station codes to the IN list as needed.
-- =============================================================

select
  s.station_code,
  s.station_name,
  p.id,
  p.name,
  p.status,
  p.roster_kind,
  p.effective_from,
  p.superseded_at,
  p.revision_no,
  p.period_start,
  p.period_end,
  p.updated_at,
  case
    when p.status = 'approved'
      and (p.superseded_at is null or current_date < p.superseded_at::date)
      and p.effective_from::date <= current_date
    then true else false
  end as is_live_today,
  (
    select count(*) from hr_roster_entries e where e.plan_id = p.id
  ) as entry_count,
  (
    select count(distinct e.worker_type || ':' || e.worker_id)
    from hr_roster_entries e where e.plan_id = p.id
  ) as worker_count,
  (
    select count(*) from hr_roster_entries e
    where e.plan_id = p.id and e.day_type = 'weekly_off'
  ) as weekly_off_count
from hr_roster_plans p
join stations s on s.id = p.location_id
where upper(btrim(s.station_code)) in ('TCD4', 'TCC3')
  and p.status in ('approved', 'pending_approval', 'draft')
order by s.station_code, p.effective_from desc, p.revision_no desc;


-- =============================================================
-- SECTION 3: Per-worker day coverage for TCD4 and TCC3.
-- Workers with < 7 days in the new plan fall back to the old one.
-- =============================================================

with live_plans as (
  select p.id, p.name, p.roster_kind, p.effective_from, p.revision_no, s.station_code
  from hr_roster_plans p
  join stations s on s.id = p.location_id
  where upper(btrim(s.station_code)) in ('TCD4', 'TCC3')
    and p.status = 'approved'
    and (p.superseded_at is null or current_date < p.superseded_at::date)
    and p.effective_from::date <= current_date
)
select
  lp.station_code,
  lp.name as plan_name,
  lp.roster_kind,
  lp.effective_from,
  e.worker_type,
  e.worker_id,
  count(distinct e.roster_date) as day_count,
  count(e.id) filter (where e.day_type = 'weekly_off') as off_days,
  case
    when count(distinct e.roster_date) < 7
    then '⚠️ INCOMPLETE — falls back to older plan for missing days'
    else '✅ full 7-day week covered'
  end as coverage
from live_plans lp
join hr_roster_entries e on e.plan_id = lp.id
group by lp.station_code, lp.name, lp.roster_kind, lp.effective_from, e.worker_type, e.worker_id
order by lp.station_code, lp.effective_from desc, day_count asc;


-- =============================================================
-- SECTION 4A: THE FIX — specific stations (TCD4, TCC3, others)
-- Add or remove station codes from the IN list as needed.
--
-- What it does:
--   For each listed station, finds the newest approved
--   recurring_weekly plan and sets superseded_at on all older
--   ones (same station, also approved, not yet superseded).
--
-- SAFE: only touches recurring_weekly plans, only sets
--   superseded_at on plans OLDER than the newest one,
--   never deletes anything.
-- =============================================================

-- Preview first (no changes made):
select
  s.station_code,
  p.name as new_plan_name,
  p.effective_from as will_set_superseded_at_to,
  old_p.id as old_plan_id,
  old_p.name as old_plan_name,
  old_p.effective_from as old_effective_from
from hr_roster_plans p
join stations s on s.id = p.location_id
join hr_roster_plans old_p on old_p.location_id = p.location_id
  and old_p.status = 'approved'
  and old_p.roster_kind = 'recurring_weekly'
  and old_p.superseded_at is null
  and old_p.id != p.id
  and old_p.effective_from < p.effective_from
where upper(btrim(s.station_code)) in ('TCD4', 'TCC3')
  and p.status = 'approved'
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


-- Apply the fix for specific stations (uncomment after reviewing preview):
/*
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
  where upper(btrim(s.station_code)) in ('TCD4', 'TCC3')
    and p.status = 'approved'
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
*/


-- =============================================================
-- SECTION 4B: PLATFORM-WIDE FIX — all affected stations at once.
-- Run Section 1 first; fix every station shown with ❌ PROBLEM.
--
-- Preview first (no changes):
-- =============================================================

select
  s.station_code,
  s.station_name,
  p.name as new_plan_name,
  p.effective_from as will_set_superseded_at_to,
  old_p.id as old_plan_id,
  old_p.name as old_plan_name,
  old_p.effective_from as old_effective_from
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


-- Platform-wide apply (uncomment after reviewing preview above):
/*
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
*/


-- =============================================================
-- SECTION 5: Verify — run after Section 4A or 4B fix.
-- Should show exactly 1 live recurring plan per station.
-- (Change station codes to match what you just fixed.)
-- =============================================================

select
  s.station_code,
  p.roster_kind,
  p.effective_from,
  p.superseded_at,
  p.revision_no,
  p.name,
  case
    when p.status = 'approved'
      and (p.superseded_at is null or current_date < p.superseded_at::date)
      and p.effective_from::date <= current_date
    then '🟢 NOW LIVE'
    else '⚪ superseded or not yet effective'
  end as state
from hr_roster_plans p
join stations s on s.id = p.location_id
where upper(btrim(s.station_code)) in ('TCD4', 'TCC3')
  and p.status = 'approved'
  and p.roster_kind = 'recurring_weekly'
order by s.station_code, p.effective_from desc;
