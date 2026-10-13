-- Backend-owned ID-mapping reminders. Vercel invokes the existing OpsPulse
-- notification worker; no desktop, browser session or ChatGPT task is involved.
insert into public.portal_notification_controls(
  company_id,portal,event_key,state,paused_until,subject_template,body_template,config
)
select
  c.id,'ops',slot.event_key,'enabled',null,
  'OpsPulse | Amazon EDSP + XPT ID mapping | {{month}} {{year}}',null,
  jsonb_build_object(
    'delivery_ready',true,
    'timezone','Asia/Kolkata',
    'schedule_time',slot.schedule_time,
    'delivery_window_minutes',20,
    'day_offset',0,
    'first_report_date','2026-10-14',
    'thread_mode','monthly',
    'email_domain','dropxlogistics.com',
    'included_models',jsonb_build_array('EDSP','XPT'),
    'additional_recipient_emails',jsonb_build_array('abdul@dropxlogistics.com','jamsheer@dropxlogistics.com')
  )
from public.companies c
cross join (values ('id_mapping_morning','11:00'),('id_mapping_afternoon','15:00')) slot(event_key,schedule_time)
where c.id='43866344-b550-4e8a-9a2d-9d23f3d8a997'::uuid
on conflict(company_id,portal,event_key) do update set
  state=excluded.state,
  paused_until=null,
  subject_template=excluded.subject_template,
  body_template=null,
  config=excluded.config,
  updated_at=now();

