begin;
-- Daily loss-recovery action digest control (disabled until SMTP + recipients verified).
-- Idempotent: on conflict do nothing.

insert into public.portal_notification_controls
  (company_id, portal, event_key, state, paused_until, subject_template, body_template, config)
select c.id, 'ops', 'loss_recovery_action_digest', 'disabled', null,
  'DropX · Loss recovery actions · {{date}}',
  'Unresolved NL/SLP loss recovery actions for your stations.',
  jsonb_build_object(
    'delivery_ready', false,
    'timezone', 'Asia/Kolkata',
    'schedule_time', '09:00',
    'delivery_window_minutes', 90,
    'day_offset', 0,
    'first_report_date', '2026-10-22',
    'email_domain', 'dropxlogistics.com'
  )
from public.companies c
on conflict (company_id, portal, event_key) do nothing;

commit;
