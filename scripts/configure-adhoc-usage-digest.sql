-- Existing outbox schema and five-minute OpsPulse worker; activation is a separate step.
insert into public.portal_notification_controls(company_id,portal,event_key,state,subject_template,body_template,config)
select c.id,'ops','adhoc_usage_digest','disabled',
 'OpsPulse | Ad hoc usage | {{month}} {{year}}',
 'Previous-day ad hoc usage and MTD instances and amount for mapped operations stations.',
 jsonb_build_object('delivery_ready',false,'schedule_time','08:00','timezone','Asia/Kolkata',
 'day_offset',-1,'first_report_date',(now() at time zone 'Asia/Kolkata')::date,
 'email_domain','dropxlogistics.com','thread_mode','monthly','send_zero_cases',false,
 'requires_previous_day_van',true,'included_programs',jsonb_build_array('AMAZON:EDSP','AMAZON:XPT','FLIPKART:ODH','FLIPKART:MDH'))
from public.companies c
where c.id='43866344-b550-4e8a-9a2d-9d23f3d8a997' and c.is_active
on conflict(company_id,portal,event_key) do nothing;
