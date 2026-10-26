-- Inherit recipient selection at read/send time from the existing Dark Store reports.
-- Seed disabled; enable only after the live preview and deployment are verified.
insert into public.portal_notification_controls(company_id,portal,event_key,state,subject_template,config)
select c.company_id,'ops',e.event_key,'disabled','DropX · Dark Store insights | {{month}} {{year}}',
 jsonb_build_object('schedule_time',e.at_time,'timezone','Asia/Kolkata','day_offset',0,
 'thread_mode','monthly','delivery_window_minutes',90,'delivery_ready',false,
 'email_domain',c.config->>'email_domain','editorial_brief','Crisp store-level evidence, a supported win, the biggest operational risk and a practical next move. Rotate focus while following up unresolved issues.',
 'accent','#e65124','character_enabled',true,'topics',jsonb_build_array('health','activities','attendance'))
from public.portal_notification_controls c
cross join (values ('now_insight_morning','09:00'),('now_insight_evening','18:00')) as e(event_key,at_time)
where c.portal='ops' and c.event_key='now_review_digest'
on conflict(company_id,portal,event_key) do nothing;
