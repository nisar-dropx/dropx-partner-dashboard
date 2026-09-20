-- Entire verification is rolled back. No SMTP calls; fixtures are never visible to workers.
begin;
set local statement_timeout='30s';
do $$
declare
 c uuid; d date:=(now() at time zone 'Asia/Kolkata')::date-1;
 b public.report_import_batches; f public.report_metric_facts;
 bid uuid:=gen_random_uuid(); fid uuid:=gen_random_uuid(); v_run_id uuid; delivery_id uuid;
 msgs jsonb; n integer; snapshot_count integer; blocked boolean:=false;
begin
 select company_id into strict c from public.portal_notification_controls
 where portal='ops' and event_key='review_digest' and state='enabled' order by company_id limit 1;
 update public.portal_notification_controls set state='enabled',paused_until=null,
 config=config||jsonb_build_object('delivery_ready',true,'activated_at',now(),'first_report_date',d)
 where company_id=c and portal='ops' and event_key='performance_data_updated';
 if exists(select 1 from public.portal_ops_data_update_dates(c)) then raise exception 'Historical batches must not trigger'; end if;
 select facts.* into strict f from public.report_metric_facts facts
 join public.stations s on s.company_id=facts.company_id and s.station_code=facts.station_code
 join public.location_models lm on lm.company_id=s.company_id and lm.id=s.location_model_id
 where facts.company_id=c and facts.source_type='amazon_hawkeye_daily' and lm.code='EDSP' and s.is_active
 order by facts.created_at desc limit 1;
 select * into strict b from public.report_import_batches where id=f.batch_id;
 insert into public.report_import_batches select (jsonb_populate_record(null::public.report_import_batches,
 to_jsonb(b)||jsonb_build_object('id',bid,'status','Processing','report_from',d,'report_to',d,'imported_row_count',1,'created_at',now(),'completed_at',null))).*;
 insert into public.report_metric_facts select (jsonb_populate_record(null::public.report_metric_facts,
 to_jsonb(f)||jsonb_build_object('id',fid,'batch_id',bid,'report_date',d,'row_hash',fid::text,'created_at',now()))).*;
 if exists(select 1 from public.portal_ops_data_update_dates(c)) then raise exception 'Incomplete import triggered'; end if;
 update public.report_import_batches set status='Failed',completed_at=now() where id=bid;
 if exists(select 1 from public.portal_ops_data_update_dates(c)) then raise exception 'Failed import triggered'; end if;
 update public.report_import_batches set status='Completed',imported_row_count=0 where id=bid;
 if exists(select 1 from public.portal_ops_data_update_dates(c)) then raise exception 'Duplicate-only import triggered'; end if;
 update public.report_import_batches set imported_row_count=1 where id=bid;
 select count(*) into n from public.portal_ops_data_update_dates(c) where report_date=d;
 if n<>1 then raise exception 'Completed import should trigger once, got %',n; end if;
 update public.portal_notification_controls set state='disabled' where company_id=c and portal='ops' and event_key='performance_data_updated';
 if exists(select 1 from public.portal_ops_data_update_dates(c)) then raise exception 'Disabled control triggered'; end if;
 update public.portal_notification_controls set state='paused',paused_until=now()+interval '1 day' where company_id=c and portal='ops' and event_key='performance_data_updated';
 if exists(select 1 from public.portal_ops_data_update_dates(c)) then raise exception 'Paused control triggered'; end if;
 update public.portal_notification_controls set paused_until=now()-interval '1 minute' where company_id=c and portal='ops' and event_key='performance_data_updated';
 if not exists(select 1 from public.portal_ops_data_update_dates(c)) then raise exception 'Timed resume failed'; end if;
 update public.portal_notification_controls set state='enabled',paused_until=null where company_id=c and portal='ops' and event_key='performance_data_updated';
 select count(*) into snapshot_count from public.portal_ops_data_update_recipients(c,d);
 if snapshot_count=0 then raise exception 'No scoped recipients for updated station'; end if;
 if exists(select 1 from public.portal_ops_data_update_recipients(c,d) r cross join jsonb_array_elements(r.stations) st
 where not exists(select 1 from public.profiles p join public.company_product_memberships m on m.user_id=p.id and m.company_id=p.company_id
 join public.user_roles ur on ur.id=m.role_id and ur.company_id=m.company_id
 join public.stations s on s.id=(st->>'id')::uuid and s.company_id=m.company_id
 where p.company_id=c and lower(trim(p.email))=r.email and p.is_active and m.is_active and ur.is_active and m.product_code='operations'
 and (m.has_all_location_access or ur.location_access_mode='all_locations' or s.id=any(m.location_scope_ids)
 or (ur.code='OPERATIONS_LOCATION' and lower(trim(s.station_email))=r.email)))) then raise exception 'Out-of-scope recipient'; end if;
 select jsonb_agg(jsonb_build_object('email',email,'name',name,'subject','TEST | September 2026','html','ROLLBACK ONLY','text','ROLLBACK ONLY',
 'scope',jsonb_build_object('stationIds',(select jsonb_agg(s->>'id') from jsonb_array_elements(stations) s)))) into msgs
 from public.portal_ops_data_update_recipients(c,d);
 begin
  perform public.portal_enqueue_ops_data_update(c,d,jsonb_set(msgs,'{0,scope,stationIds}',jsonb_build_array(gen_random_uuid())));
 exception when others then blocked:=true;
 end;
 if not blocked then raise exception 'Invalid scope must be rejected'; end if;
 v_run_id:=public.portal_enqueue_ops_data_update(c,d,msgs);
 if v_run_id is null then raise exception 'Valid enqueue failed'; end if;
 if public.portal_enqueue_ops_data_update(c,d,msgs) is not null then raise exception 'Duplicate enqueue allowed'; end if;
 select count(*) into n from public.portal_claim_ops_data_updates(80) where company_id=c and report_date=d;
 if n<>snapshot_count then raise exception 'Expected % claims, got %',snapshot_count,n; end if;
 if exists(select 1 from public.portal_claim_ops_data_updates(80) where company_id=c and report_date=d) then raise exception 'Repeated claim allowed'; end if;
 select id into delivery_id from public.portal_digest_deliveries where run_id=v_run_id limit 1;
 if not public.portal_finish_digest(delivery_id,'<test-message@dropxlogistics.com>','<test-root@dropxlogistics.com>','TEST ONLY') then raise exception 'Receipt write failed'; end if;
 if not exists(select 1 from public.portal_digest_threads where company_id=c and event_key='performance_data_updated' and root_message_id='<test-root@dropxlogistics.com>') then raise exception 'Monthly thread root missing'; end if;
 if has_function_privilege('anon','public.portal_ops_data_update_recipients(uuid,date)','execute') or has_function_privilege('authenticated','public.portal_enqueue_ops_data_update(uuid,date,jsonb)','execute') then raise exception 'Public RPC access'; end if;
end;$$;
rollback;
select 'PASS: completed-only, no historical/failed/duplicate sends, pause/resume, scoped recipients, invalid-scope denial, duplicate enqueue/claim protection and monthly receipt. All fixtures rolled back.' as result;
