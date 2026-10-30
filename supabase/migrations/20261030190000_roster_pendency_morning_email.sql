-- Daily morning roster pendency for station managers and cluster managers.
-- Uses the portal digest worker (IST schedule_time + 5-minute cron window).
insert into public.portal_notification_controls
  (company_id, portal, event_key, state, paused_until, subject_template, body_template, config)
select
  c.id,
  'ops',
  'roster_pendency_morning',
  'enabled',
  null,
  'DropX | Roster pending at your stations | Morning | {{date}}',
  null,
  jsonb_build_object(
    'delivery_ready', true,
    'timezone', 'Asia/Kolkata',
    'schedule_time', '08:00',
    'delivery_window_minutes', 30,
    'day_offset', 0,
    'thread_mode', 'daily',
    'email_domain', 'dropxlogistics.com',
    'send_zero_cases', false,
    'first_report_date', '2026-10-31'
  )
from public.companies c
where c.id = '43866344-b550-4e8a-9a2d-9d23f3d8a997'::uuid
on conflict (company_id, portal, event_key) do update
set
  state = excluded.state,
  subject_template = excluded.subject_template,
  config = public.portal_notification_controls.config || excluded.config,
  updated_at = now();
