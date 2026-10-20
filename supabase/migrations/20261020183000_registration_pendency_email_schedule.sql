-- Prepared disabled. Activate only after production preview verifies manager
-- routing, live field rules, attachment and SMTP readiness. No backdated sends.
insert into public.portal_notification_controls
  (company_id,portal,event_key,state,paused_until,subject_template,body_template,config)
select c.id,'ops',slot.event_key,'disabled',null,
  'DropX | Registration pendency | ' || slot.label || ' | {{month}} {{year}}',null,
  jsonb_build_object('delivery_ready',false,'timezone','Asia/Kolkata',
    'schedule_time',slot.schedule_time,'delivery_window_minutes',30,'day_offset',0,
    'thread_mode','monthly','email_domain','dropxlogistics.com','send_zero_cases',false,
    'first_report_date','2026-10-21')
from public.companies c
cross join (values
  ('registration_pendency_morning','09:30','Morning'),
  ('registration_pendency_afternoon','16:00','Follow-up')
) slot(event_key,schedule_time,label)
where c.id='43866344-b550-4e8a-9a2d-9d23f3d8a997'::uuid
on conflict(company_id,portal,event_key) do nothing;
