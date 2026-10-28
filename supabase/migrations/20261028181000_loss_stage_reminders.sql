begin;
-- Preserve the existing delivery function and change only our recovery thread period.
do $$
declare definition text; old_expression text := 'to_char(v_delivery.report_date,''YYYY-MM'')';
new_expression text := 'case when v_delivery.event_key in (''loss_reminder_recovery_morning'',''loss_reminder_recovery_afternoon'') and extract(day from v_delivery.report_date)<=5 then to_char(v_delivery.report_date-interval ''1 month'',''YYYY-MM'') else to_char(v_delivery.report_date,''YYYY-MM'') end';
begin
 select pg_get_functiondef('public.portal_finish_digest(uuid,text,text,text)'::regprocedure) into definition;
 if position('loss_reminder_recovery_morning' in definition)>0 then return; end if;
 if position(old_expression in definition)=0 then raise exception 'Unexpected digest receipt function; inspect before changing thread period'; end if;
 execute replace(definition,old_expression,new_expression);
end $$;
insert into public.portal_notification_controls(company_id,portal,event_key,state,paused_until,subject_template,body_template,config)
select '43866344-b550-4e8a-9a2d-9d23f3d8a997'::uuid,'ops','loss_reminder_'||stage||'_'||edition,'disabled',null,
 'OpsPulse · Loss actions · {{date}}','Station-level pending actions with shipment Excel.',
 jsonb_build_object('delivery_ready',true,'timezone','Asia/Kolkata','schedule_time',case edition when 'morning' then '10:00' else '15:00' end,
 'delivery_window_minutes',60,'day_offset',0,'first_report_date','2026-10-28','email_domain','dropxlogistics.com',
 'additional_recipient_emails',jsonb_build_array('jamsheer@dropxlogistics.com'),'reminder_stage',stage)
from unnest(array['recovery','dispute','response']) as s(stage) cross join unnest(array['morning','afternoon']) as e(edition)
on conflict(company_id,portal,event_key) do nothing;
commit;
