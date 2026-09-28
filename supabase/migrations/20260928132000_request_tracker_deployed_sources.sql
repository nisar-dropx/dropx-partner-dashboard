-- Production uses the renamed People business-trip tables.
begin;
set local lock_timeout='5s';
update public.request_tracker_sources set source_table='hr_business_trip_requests', history='[{"table":"hr_business_trip_approval_steps","keys":["request_id"]}]'::jsonb where kind='trip';
do $$ begin
 if to_regclass('public.hr_business_trip_requests') is not null then
  create trigger request_tracker_capture after insert or update or delete on public.hr_business_trip_requests for each row execute function public.request_tracker_capture('trip');
 end if;
 if to_regclass('public.hr_business_trip_approval_steps') is not null then
  create trigger request_tracker_child_trip after insert or update or delete on public.hr_business_trip_approval_steps for each row execute function public.request_tracker_capture('trip','request_id');
 end if;
end $$;
create or replace function public.request_tracker_redact(v jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare result jsonb; k text; value jsonb;
begin
 if v is null then return null; end if;
 if jsonb_typeof(v)='object' then
  result='{}';
  for k,value in select * from jsonb_each(v) loop
   if k not in ('bank_status','bank_processing_remarks','beneficiary_verification_status','document_type','document_type_id','document_status') and k ~* '(password|secret|token|credential|authorization|api.?key|private.?key|encrypted|bank|ifsc|beneficiary|phone|mobile|email|aadhaar|aadhar|(^|_)pan($|_)|birth|dob|address|latitude|longitude|gps|photo|document|attachment|file|receipt|account_no|account_number|pin_hash|otp|passport|license_number|licence_number|signature|biometric|image|base64|cookie|access.?key|connection_string)' then
    result=result||jsonb_build_object(k,'[Protected]');
   else result=result||jsonb_build_object(k,public.request_tracker_redact(value)); end if;
  end loop;
  return result;
 elsif jsonb_typeof(v)='array' then
  select coalesce(jsonb_agg(public.request_tracker_redact(e.value)),'[]') into result from jsonb_array_elements(v) e;
  return result;
 end if;
 return v;
end $$;

create or replace function public.request_tracker_detail(p_company uuid,p_kind text,p_id text,p_offset integer default 0)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare s record; h jsonb; key text; predicate text; root jsonb; events jsonb='[]'; batch jsonb; warnings jsonb='[]'; items jsonb; n integer; retired boolean=false;
begin
 if p_company is null or length(p_id)>160 or p_offset<0 or p_offset>10000 then raise exception 'Invalid request'; end if;
 select * into s from public.request_tracker_sources where kind=p_kind;
 if not found then return null; end if;
 begin
  execute format('select public.request_tracker_redact(to_jsonb(t)) from public.%I t where t.company_id=$1 and t.id::text=$2',s.source_table) into root using p_company,p_id;
 exception when undefined_table or undefined_column then return null;
 end;
 if root is null then
  select before_data into root from public.request_tracker_events where company_id=p_company and kind=p_kind and source_id=p_id and operation='delete' and source_table=s.source_table and source_row_id=p_id order by recorded_at desc,id desc limit 1;
  retired=root is not null;
 end if;
 if root is null then return null; end if;
 for h in select * from jsonb_array_elements(s.history) loop
  predicate='false';
  for key in select jsonb_array_elements_text(h->'keys') loop
   predicate=predicate||format(' or to_jsonb(t)->>%L=$2',key);
  end loop;
  begin
   execute format('select coalesce(jsonb_agg(x),''[]'') from (select jsonb_build_object(''source'',%L,''record'',public.request_tracker_redact(to_jsonb(t))) x from public.%I t where to_jsonb(t)->>''company_id''=$1 and (%s) order by coalesce(to_jsonb(t)->>''decided_at'',to_jsonb(t)->>''created_at'','''') desc,to_jsonb(t)->>''id'' desc limit $3) e',h->>'table',h->>'table',predicate)
    into batch using p_company::text,p_id,p_offset+101;
   events=events||batch;
  exception when undefined_table or undefined_column then warnings=warnings||jsonb_build_array('Some legacy history is unavailable.');
  end;
 end loop;
 -- Existing JSON history is evidence, not proof of immutable retention.
 for h in select * from jsonb_array_elements(case when jsonb_typeof(root->'raw_payload'->'lifecycleHistory')='array' then root->'raw_payload'->'lifecycleHistory' when jsonb_typeof(root->'approval_history')='array' then root->'approval_history' else '[]' end) loop
  events=events||jsonb_build_array(jsonb_build_object('source','Embedded legacy history','record',h));
 end loop;
 select coalesce(jsonb_agg(jsonb_build_object('source','Database change','record',to_jsonb(e))),'[]') into batch from (
  select * from public.request_tracker_events where company_id=p_company and kind=p_kind and source_id=p_id order by recorded_at desc,id desc limit p_offset+101
 ) e;
 events=events||batch;
 select count(*) into n from jsonb_array_elements(events);
 select coalesce(jsonb_agg(value order by stamp desc,identity),'[]') into items from (
  select value,coalesce(value->'record'->>'recorded_at',value->'record'->>'decided_at',value->'record'->>'created_at',value->'record'->>'timestamp',value->'record'->>'at','') stamp,
  coalesce(value->>'source','')||coalesce(value->'record'->>'id',value::text) identity from jsonb_array_elements(events)
  order by stamp desc,identity offset p_offset limit 100
 ) page;
 return jsonb_build_object('kind',s.kind,'label',s.label,'portal',s.portal,'record',root,'events',items,'hasMore',n>p_offset+100,'warnings',warnings,'auditSince',s.installed_at,'deleted',retired);
end $$;

notify pgrst,'reload schema';
commit;
