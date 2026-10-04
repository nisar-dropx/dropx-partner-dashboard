-- Transaction-only verification. No business email is sent or left queued.
begin;
do $test$
declare
 c uuid; d date := (now() at time zone 'Asia/Kolkata')::date;
 first_run uuid; duplicate_run uuid; legacy_run uuid; saved jsonb;
 files jsonb := '[{"filename":"COD_pendency_2plus.csv","contentType":"text/csv; charset=utf-8","encoding":"base64","content":"c3RhdGlvbixhbW91bnQNCktPWkEsMTAw"}]';
 message jsonb;
begin
 select company_id into strict c from public.portal_notification_controls
 where portal='ops' and event_key='cod_pending_evening' limit 1;
 insert into public.portal_notification_controls(company_id,portal,event_key,state,subject_template,body_template,config)
 values(c,'ops','cod_attachment_verification','enabled','Verification only','Verification only',
   jsonb_build_object('delivery_ready',true,'timezone','Asia/Kolkata','schedule_time','00:00','day_offset',0));
 message:=jsonb_build_array(jsonb_build_object('email','qa@example.test','name','Verification','subject','Verification only',
   'html','Verification only','text','Verification only','scope',jsonb_build_object('stationIds',jsonb_build_array('scoped-station')),'attachments',files));
 first_run:=public.portal_enqueue_digest(c,'ops','cod_attachment_verification',d,now(),message);
 if first_run is null then raise exception 'Did not enqueue verification'; end if;
 select attachments into strict saved from public.portal_digest_deliveries where run_id=first_run;
 if saved<>files then raise exception 'Attachment bytes changed during enqueue'; end if;
 duplicate_run:=public.portal_enqueue_digest(c,'ops','cod_attachment_verification',d,now(),message);
 if duplicate_run is not null then raise exception 'Duplicate email was queued'; end if;
 if (select count(*) from public.portal_digest_deliveries where run_id=first_run)<>1 then raise exception 'Unexpected delivery count'; end if;
 update public.portal_notification_controls set config=config||'{"day_offset":-1}'::jsonb
 where company_id=c and portal='ops' and event_key='cod_attachment_verification';
 legacy_run:=public.portal_enqueue_digest(c,'ops','cod_attachment_verification',d-1,now(),jsonb_build_array((message->0)-'attachments'));
 select attachments into strict saved from public.portal_digest_deliveries where run_id=legacy_run;
 if saved<>'[]'::jsonb then raise exception 'Legacy digest compatibility failed'; end if;
 if has_function_privilege('anon','public.portal_enqueue_digest(uuid,text,text,date,timestamptz,jsonb)','EXECUTE')
 or has_function_privilege('authenticated','public.portal_enqueue_digest(uuid,text,text,date,timestamptz,jsonb)','EXECUTE')
 then raise exception 'Queue must remain service-only'; end if;
end;$test$;
rollback;
select 'PASS: attachment persistence, daily deduplication, legacy compatibility and service-only access. All verification rows rolled back; no email sent.' as result;
