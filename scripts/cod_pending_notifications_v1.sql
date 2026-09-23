-- Configure the two user-requested COD reminders. Activation is a separate rollout step.
-- Re-running preserves existing delivery preferences and first report date.
insert into public.portal_notification_controls
(company_id,portal,event_key,state,subject_template,config)
select company_id,'ops','cod_pending_'||slot,'disabled',
 'OpsPulse | COD report | {{month}} {{year}}',
 jsonb_build_object('timezone','Asia/Kolkata','slot',slot,'schedule_time',send_time,
 'day_offset',day_offset,'thread_mode','monthly','email_domain',config->>'email_domain',
 'delivery_ready',false,'delivery_window_minutes',30,'send_zero_cases',false,
 'first_report_date',(now() at time zone 'Asia/Kolkata')::date::text)
from public.portal_notification_controls
cross join (values ('evening','20:30',0),('morning','09:00',-1)) slots(slot,send_time,day_offset)
where portal='ops' and event_key='review_digest' and state='enabled'
on conflict(company_id,portal,event_key) do nothing;
