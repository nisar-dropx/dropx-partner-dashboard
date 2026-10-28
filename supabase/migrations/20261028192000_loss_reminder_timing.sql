begin;
-- Keep each stage's existing thread and recipients; change only edition time.
update public.portal_notification_controls
set config=jsonb_set(config,'{schedule_time}',to_jsonb(case when event_key like '%_morning' then '11:00'::text else '16:00'::text end))
where company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997' and portal='ops'
  and event_key in ('loss_reminder_recovery_morning','loss_reminder_recovery_afternoon','loss_reminder_dispute_morning','loss_reminder_dispute_afternoon','loss_reminder_response_morning','loss_reminder_response_afternoon');
commit;
