insert into public.portal_notification_controls(
  company_id, portal, event_key, state, paused_until, subject_template,
  body_template, config, updated_by, updated_at
)
select
  company_id,
  portal,
  'cod_pending_current',
  state,
  paused_until,
  subject_template,
  body_template,
  config || jsonb_build_object(
    'slot', 'evening',
    'schedule_time', '00:00',
    'delivery_window_minutes', 1440
  ),
  updated_by,
  now()
from public.portal_notification_controls
where portal = 'ops'
  and event_key = 'cod_pending_evening'
on conflict (company_id, portal, event_key) do update
set subject_template = excluded.subject_template,
    body_template = excluded.body_template,
    config = excluded.config,
    updated_at = now();
