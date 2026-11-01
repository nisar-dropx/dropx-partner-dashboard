-- Apply only after the matching OpsPulse release is verified. Idempotent;
-- preserves delivery receipts, owner subscriptions and existing monthly roots.
begin;
update public.portal_notification_controls
set state = 'enabled', paused_until = null,
    subject_template = 'DropX | Registration pendency | {{month}} {{year}}',
    config = config || jsonb_build_object(
      'schedule_time', case event_key when 'registration_pendency_morning' then '09:30' else '15:30' end,
      'timezone', 'Asia/Kolkata', 'day_offset', 0, 'thread_mode', 'monthly',
      'team_recipients_enabled', true, 'send_zero_cases', false,
      'delivery_ready', true, 'delivery_window_minutes', 30),
    updated_at = now()
where company_id = '43866344-b550-4e8a-9a2d-9d23f3d8a997' and portal = 'ops'
  and event_key in ('registration_pendency_morning','registration_pendency_afternoon');
commit;
