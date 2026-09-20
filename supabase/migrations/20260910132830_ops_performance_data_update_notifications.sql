-- Uses the existing private portal outbox and monthly thread receipts.
-- Activation is separate from deployment so validation never broadcasts test mail.
insert into public.portal_notification_controls(company_id,portal,event_key,state,subject_template,body_template,config)
select company_id,'ops','performance_data_updated','disabled',
 'Ops Pulse | Performance data updated | {{month}} {{year}}',
 'Performance data for {{date}} has been updated. Please review your locations in Ops Pulse.',
 jsonb_build_object('delivery_ready',false,'trigger','data_updated','timezone','Asia/Kolkata',
 'thread_mode','monthly','email_domain',config->>'email_domain',
 'included_models',config->'included_models','source_types',jsonb_build_array('amazon_hawkeye_daily'),
 'activated_at',now(),'first_report_date',(now() at time zone 'Asia/Kolkata')::date-1,
 'recipient_role_codes',jsonb_build_array('OPERATIONS_CLM','OPERATIONS_AOM','OPERATIONS_CM',
 'OPERATIONS_RM','OPERATIONS_NH','OPERATIONS_PGM','OPERATIONS_BH','OPERATIONS_SM',
 'OPERATIONS_SRSM','OPERATIONS_STM','OPERATIONS_LOCATION','OWNER'))
from public.portal_notification_controls where portal='ops' and event_key='review_digest'
on conflict(company_id,portal,event_key) do nothing;

create index if not exists report_completed_data_update_lookup
 on public.report_import_batches(company_id,source_type,completed_at,report_from)
 where status='Completed' and imported_row_count>0;

create function public.portal_ops_data_update_dates(p_company_id uuid)
returns table(report_date date) language sql stable security invoker set search_path='' as $$
 select distinct b.report_from
 from public.portal_notification_controls c
 join public.report_import_batches b on b.company_id=c.company_id
 where c.company_id=p_company_id and c.portal='ops' and c.event_key='performance_data_updated'
 and (c.state='enabled' or (c.state='paused' and c.paused_until<=now()))
 and coalesce((c.config->>'delivery_ready')::boolean,false)
 and b.status='Completed' and b.imported_row_count>0
 and c.config->'source_types' ? b.source_type
 and b.completed_at >= (c.config->>'activated_at')::timestamptz
 and b.report_from=b.report_to
 and b.report_from >= (c.config->>'first_report_date')::date
 and b.report_from < (now() at time zone 'Asia/Kolkata')::date
 and exists(select 1 from public.report_metric_facts f where f.company_id=b.company_id
   and f.batch_id=b.id and f.source_type=b.source_type and f.report_date=b.report_from)
 and not exists(select 1 from public.portal_digest_runs r where r.company_id=c.company_id
   and r.portal=c.portal and r.event_key=c.event_key and r.report_date=b.report_from)
 order by b.report_from limit 7;
$$;

create function public.portal_ops_data_update_recipients(p_company_id uuid,p_report_date date)
returns table(email text,name text,stations jsonb) language sql stable security invoker set search_path='' as $$
 with control as (
  select config from public.portal_notification_controls
  where company_id=p_company_id and portal='ops' and event_key='performance_data_updated'
 ), updated_stations as (
  select s.id,s.station_code,s.station_name,lower(trim(s.station_email)) station_email
  from public.stations s
  join public.location_models lm on lm.id=s.location_model_id and lm.company_id=s.company_id
  cross join control c
  where s.company_id=p_company_id and s.is_active and not coalesce(s.hide_from_location_list,false)
  and c.config->'included_models' ? upper(lm.code)
  and exists(select 1 from public.report_metric_facts f
    join public.report_import_batches b on b.id=f.batch_id and b.company_id=f.company_id
    where f.company_id=s.company_id and f.station_code=s.station_code and f.report_date=p_report_date
    and c.config->'source_types' ? f.source_type and b.source_type=f.source_type
    and b.status='Completed' and b.completed_at is not null and b.imported_row_count>0
    and b.report_from=p_report_date and b.report_to=p_report_date)
 ), scoped as (
  select lower(trim(p.email)) email,coalesce(nullif(p.full_name,''),p.email) name,s.id,s.station_code,s.station_name
  from public.profiles p
  join public.company_product_memberships m on m.company_id=p.company_id and m.user_id=p.id
    and m.product_code='operations' and m.is_active
  join public.user_roles r on r.company_id=m.company_id and r.id=m.role_id and r.is_active
  cross join control c
  join updated_stations s on m.has_all_location_access or r.location_access_mode='all_locations'
    or s.id=any(m.location_scope_ids)
    or (r.code='OPERATIONS_LOCATION' and s.station_email=lower(trim(p.email)))
  where p.company_id=p_company_id and p.is_active and c.config->'recipient_role_codes' ? r.code
    and split_part(lower(trim(p.email)),'@',2)=lower(c.config->>'email_domain')
    and p.email !~ '[\s<>]' and length(split_part(p.email,'@',1))>0
 )
 select email,min(name),jsonb_agg(distinct jsonb_build_object('id',id,'station_code',station_code,'station_name',station_name))
 from scoped group by email order by email;
$$;

create function public.portal_enqueue_ops_data_update(p_company_id uuid,p_report_date date,p_messages jsonb)
returns uuid language plpgsql security invoker set search_path='' as $$
declare v_run uuid;
begin
 if not exists(select 1 from public.portal_ops_data_update_dates(p_company_id) d where d.report_date=p_report_date)
 then return null; end if;
 if jsonb_typeof(p_messages)<>'array' or jsonb_array_length(p_messages)=0 then return null; end if;
 -- Validate recipients and saved scope against current authorized locations, not a caller-supplied list.
 if exists(select 1 from jsonb_array_elements(p_messages) m
   left join public.portal_ops_data_update_recipients(p_company_id,p_report_date) r on r.email=m->>'email'
   where r.email is null or jsonb_typeof(m->'scope'->'stationIds') is distinct from 'array'
   or jsonb_array_length(m->'scope'->'stationIds')=0
   or exists(select 1 from jsonb_array_elements_text(m->'scope'->'stationIds') i(value)
     where not exists(select 1 from jsonb_array_elements(r.stations) s where s->>'id'=i.value)))
 then raise exception 'Recipient or location is outside the current performance scope'; end if;
 insert into public.portal_digest_runs(company_id,portal,event_key,report_date,snapshot_at,recipient_count)
 values(p_company_id,'ops','performance_data_updated',p_report_date,now(),jsonb_array_length(p_messages))
 on conflict(company_id,portal,event_key,report_date) do nothing returning id into v_run;
 if v_run is null then return null; end if;
 insert into public.portal_digest_deliveries(run_id,company_id,portal,event_key,report_date,recipient_email,recipient_name,subject,html,body,scope_summary)
 select v_run,p_company_id,'ops','performance_data_updated',p_report_date,m->>'email',m->>'name',m->>'subject',m->>'html',m->>'text',m->'scope'
 from jsonb_array_elements(p_messages) m;
 return v_run;
end;$$;

create function public.portal_claim_ops_data_updates(p_limit integer default 80)
returns setof public.portal_digest_deliveries language sql security invoker set search_path='' as $$
 with selected as (
  select d.id from public.portal_digest_deliveries d
  join public.portal_notification_controls c using(company_id,portal,event_key)
  where d.portal='ops' and d.event_key='performance_data_updated' and d.status='pending'
   and (c.state='enabled' or (c.state='paused' and c.paused_until<=now()))
   and coalesce((c.config->>'delivery_ready')::boolean,false)
   -- Serialize a recipient's days so monthly replies always have the correct parent.
   and not exists(select 1 from public.portal_digest_deliveries earlier
     where earlier.company_id=d.company_id and earlier.portal=d.portal and earlier.event_key=d.event_key
      and earlier.recipient_email=d.recipient_email and earlier.report_date<d.report_date
      and earlier.status in ('pending','sending'))
  order by d.report_date,d.recipient_email for update of d skip locked limit least(greatest(p_limit,1),80)
 )
 update public.portal_digest_deliveries d set status='sending',started_at=now()
 from selected s where d.id=s.id returning d.*;
$$;

revoke all on function public.portal_ops_data_update_dates(uuid),public.portal_ops_data_update_recipients(uuid,date),
 public.portal_enqueue_ops_data_update(uuid,date,jsonb),public.portal_claim_ops_data_updates(integer) from public,anon,authenticated;
grant execute on function public.portal_ops_data_update_dates(uuid),public.portal_ops_data_update_recipients(uuid,date),
 public.portal_enqueue_ops_data_update(uuid,date,jsonb),public.portal_claim_ops_data_updates(integer) to service_role;
