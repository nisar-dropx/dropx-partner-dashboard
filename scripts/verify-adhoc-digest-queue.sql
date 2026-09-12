-- Transaction-only verification: no delivery rows or configuration changes survive.
begin;
do $test$
declare c uuid := '43866344-b550-4e8a-9a2d-9d23f3d8a997'; d date := (now() at time zone 'Asia/Kolkata')::date-1; first_run uuid; duplicate_run uuid;
begin
  if not exists(select 1 from public.portal_notification_controls where company_id=c and portal='ops' and event_key='adhoc_usage_digest') then
    raise exception 'Configure the disabled ad hoc digest before verification';
  end if;
  update public.portal_notification_controls set state='enabled',paused_until=null,
    config=config||jsonb_build_object('delivery_ready',true,'schedule_time','00:00','first_report_date',d)
  where company_id=c and portal='ops' and event_key='adhoc_usage_digest';
  first_run:=public.portal_enqueue_digest(c,'ops','adhoc_usage_digest',d,now(),'[]'::jsonb);
  duplicate_run:=public.portal_enqueue_digest(c,'ops','adhoc_usage_digest',d,now(),'[]'::jsonb);
  if first_run is null or duplicate_run is not null then raise exception 'Daily idempotency failed'; end if;
  if exists(select 1 from public.portal_digest_deliveries where run_id=first_run) then raise exception 'Empty report unexpectedly created email'; end if;
end;
$test$;
rollback;
select 'Daily idempotency and zero-email suppression passed; all changes rolled back.' result;
