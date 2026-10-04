-- Persist the exact recipient-scoped report bytes with the queued email.
-- Old queued emails and other digest builders keep their existing behaviour.
alter table public.portal_digest_deliveries
  add column attachments jsonb not null default '[]'::jsonb
  constraint portal_digest_attachments_array check (
    case when jsonb_typeof(attachments) = 'array'
      then jsonb_array_length(attachments) <= 2 else false end
  );

create or replace function public.portal_enqueue_digest(
  p_company_id uuid, p_portal text, p_event_key text, p_report_date date,
  p_snapshot_at timestamptz, p_messages jsonb
) returns uuid language plpgsql set search_path to '' as $function$
declare v_run uuid; v_control public.portal_notification_controls; v_local timestamp;
begin
 select * into strict v_control from public.portal_notification_controls
 where company_id=p_company_id and portal=p_portal and event_key=p_event_key;
 v_local:=now() at time zone coalesce(v_control.config->>'timezone','Asia/Kolkata');
 if not (v_control.state='enabled' or (v_control.state='paused' and v_control.paused_until<=now()))
 or coalesce((v_control.config->>'delivery_ready')::boolean,false)=false
 or v_local::time<(v_control.config->>'schedule_time')::time
 or p_report_date<>v_local::date+coalesce((v_control.config->>'day_offset')::integer,-1)
 or p_report_date<coalesce((v_control.config->>'first_report_date')::date,p_report_date)
 then return null; end if;
 if p_snapshot_at<now()-interval '15 minutes' or p_snapshot_at>now()+interval '1 minute'
 then raise exception 'Fresh report data is required'; end if;
 insert into public.portal_digest_runs(company_id,portal,event_key,report_date,snapshot_at,recipient_count)
 values(p_company_id,p_portal,p_event_key,p_report_date,p_snapshot_at,jsonb_array_length(p_messages))
 on conflict(company_id,portal,event_key,report_date) do nothing returning id into v_run;
 if v_run is null then return null; end if;
 insert into public.portal_digest_deliveries(run_id,company_id,portal,event_key,report_date,recipient_email,recipient_name,subject,html,body,scope_summary,attachments)
 select v_run,p_company_id,p_portal,p_event_key,p_report_date,lower(m->>'email'),m->>'name',m->>'subject',m->>'html',m->>'text',coalesce(m->'scope','{}'),coalesce(m->'attachments','[]'::jsonb)
 from jsonb_array_elements(p_messages)m;
 return v_run;
end;$function$;

-- Preserve the existing service-only execution boundary.
revoke all on function public.portal_enqueue_digest(uuid,text,text,date,timestamptz,jsonb) from public, anon, authenticated;
grant execute on function public.portal_enqueue_digest(uuid,text,text,date,timestamptz,jsonb) to service_role;
