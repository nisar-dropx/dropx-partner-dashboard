-- Dashboard's read-only cross-portal tracker. Domain tables remain authoritative.
begin;
set local lock_timeout = '5s';
create table public.request_tracker_sources (
 kind text primary key, label text not null, portal text not null,
 source_table text not null unique, aliases jsonb not null default '[]', history jsonb not null default '[]',
 installed_at timestamptz not null default clock_timestamp()
);
create table public.request_tracker_events (
 id uuid primary key default gen_random_uuid(), company_id uuid not null,
 kind text not null, source_id text not null, source_table text not null, source_row_id text, operation text not null,
 actor_id uuid, recorded_actor_id text, executor text not null,
 before_data jsonb, after_data jsonb, changed_fields text[] not null,
 recorded_at timestamptz not null default clock_timestamp(), transaction_id bigint not null
);
create index request_tracker_events_entity_idx on public.request_tracker_events(company_id,kind,source_id,recorded_at,id);
alter table public.request_tracker_sources enable row level security;
alter table public.request_tracker_events enable row level security;
revoke all on public.request_tracker_sources, public.request_tracker_events from public, anon, authenticated, service_role;
grant select on public.request_tracker_sources, public.request_tracker_events to service_role;

-- Recursive redaction before persistence or API output; no raw row snapshots.
create function public.request_tracker_redact(v jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare result jsonb; k text; value jsonb;
begin
 if v is null then return null; end if;
 if jsonb_typeof(v)='object' then
  result='{}';
  for k,value in select * from jsonb_each(v) loop
   if k ~* '(password|secret|token|credential|authorization|api.?key|private.?key|encrypted|bank|ifsc|beneficiary|phone|mobile|email|aadhaar|aadhar|(^|_)pan($|_)|birth|dob|address|latitude|longitude|gps|photo|document|attachment|file|receipt|account_no|account_number|pin_hash|otp|passport|license_number|licence_number|signature|biometric|image|base64)' then
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

create function public.request_tracker_capture() returns trigger
language plpgsql security definer set search_path='' as $$
declare old_row jsonb; new_row jsonb; subject jsonb; changed text[]; tenant uuid; hint text; parent_id text;
begin
 old_row=case when tg_op<>'INSERT' then to_jsonb(old) end;
 new_row=case when tg_op<>'DELETE' then to_jsonb(new) end;
 subject=coalesce(new_row,old_row);
 tenant=nullif(subject->>'company_id','')::uuid;
 select subject->>k into parent_id from unnest(string_to_array(coalesce(nullif(tg_argv[1],''),'id'),',')) with ordinality keys(k,n) where nullif(subject->>k,'') is not null order by n limit 1;
 if tenant is null or parent_id is null then return coalesce(new,old); end if;
 select array_agg(key order by key) into changed from (
  select key from jsonb_object_keys(coalesce(old_row,'{}')||coalesce(new_row,'{}')) as keys(key)
  where old_row->key is distinct from new_row->key
 ) d;
 if coalesce(array_length(changed,1),0)=0 then return coalesce(new,old); end if;
 -- A row's actor field is a hint, not authenticated execution identity.
 if tg_op='INSERT' then hint=coalesce(new_row->>'created_by',new_row->>'requested_by',new_row->>'actor_user_id');
 elsif tg_op='UPDATE' then
  if new_row->'updated_by' is distinct from old_row->'updated_by' then hint=new_row->>'updated_by'; end if;
 end if;
 insert into public.request_tracker_events(company_id,kind,source_id,source_table,source_row_id,operation,actor_id,recorded_actor_id,executor,before_data,after_data,changed_fields,transaction_id)
 values(tenant,tg_argv[0],parent_id,tg_table_name,subject->>'id',lower(tg_op),auth.uid(),hint,
 coalesce(nullif(current_setting('request.jwt.claim.role',true),''),nullif(current_setting('role',true),'none'),session_user),
 public.request_tracker_redact(old_row),public.request_tracker_redact(new_row),changed,txid_current());
 return coalesce(new,old);
end $$;
insert into public.request_tracker_sources(kind,label,portal,source_table,aliases,history) values
('payment','Payment request','Finance','payment_requests','["request_no", "payment_reference", "utr_cin", "utr"]'::jsonb,'[{"table": "payment_request_approvals", "keys": ["payment_request_id", "request_id"]}]'::jsonb),
('expense_request','Reimbursement estimate / pre-request','People','hr_expense_claim_requests','["request_no"]'::jsonb,'[{"table": "hr_expense_claim_request_assignees", "keys": ["request_id", "claim_request_id"]}]'::jsonb),
('expense_claim','Reimbursement bill claim','People','hr_expense_claims','["claim_no"]'::jsonb,'[{"table": "hr_expense_events", "keys": ["claim_id"]}]'::jsonb),
('pay_advance','People pay advance','People','hr_pay_advance_requests','["request_number"]'::jsonb,'[{"table": "hr_pay_advance_steps", "keys": ["request_id"]}]'::jsonb),
('legacy_advance','Ops / DropX One advance request','OpsPulse','payment_advance_requests','[]'::jsonb,'[]'::jsonb),
('field_travel','Recruiter field travel reimbursement','Recruit','field_travel_reimbursements','[]'::jsonb,'[]'::jsonb),
('workforce_payroll','Workforce payroll run and Finance handoff','Workforce','workforce_payroll_runs','["run_number"]'::jsonb,'[{"table": "workforce_payroll_events", "keys": ["payroll_run_id", "run_id"]}]'::jsonb),
('people_payroll','People payroll run / adjustments','People','hr_payroll_runs','[]'::jsonb,'[]'::jsonb),
('payout_publication','Workforce payout publication','Workforce','workforce_payout_publications','[]'::jsonb,'[]'::jsonb),
('payout_dispute','Workforce payout dispute','Workforce','workforce_payout_disputes','[]'::jsonb,'[{"table": "workforce_payout_dispute_events", "keys": ["dispute_id"]}]'::jsonb),
('payout_correction','Workforce payout correction','Workforce','workforce_payout_corrections','[]'::jsonb,'[]'::jsonb),
('adjustment','Workforce earning / deduction adjustment','Workforce','workforce_adjustments','["external_reference"]'::jsonb,'[]'::jsonb),
('loss','Station loss claim','Workforce','workforce_station_loss_claims','[]'::jsonb,'[]'::jsonb),
('mileage','Mileage claim','Workforce','workforce_mileage_claims','[]'::jsonb,'[]'::jsonb),
('workforce_hold','Workforce payment hold / release','Workforce','workforce_payment_holds','["reference"]'::jsonb,'[]'::jsonb),
('salary_hold','People salary hold / cancellation','People','ops_salary_holds','[]'::jsonb,'[]'::jsonb),
('leave','Leave request','People','hr_leave_requests','[]'::jsonb,'[{"table": "hr_leave_approval_steps", "keys": ["request_id", "leave_request_id"]}]'::jsonb),
('attendance','Attendance regularization / manual punch','People','attendance_regularization_requests','[]'::jsonb,'[{"table": "attendance_regularization_approval_steps", "keys": ["request_id", "regularization_request_id"]}]'::jsonb),
('wfh','Work-from-home request','People','hr_wfh_requests','["request_no"]'::jsonb,'[{"table": "hr_wfh_approval_steps", "keys": ["request_id"]}]'::jsonb),
('trip','Business trip / site visit request','People','hr_site_visit_requests','["request_no"]'::jsonb,'[{"table": "hr_site_visit_approval_steps", "keys": ["request_id"]}]'::jsonb),
('roster','Weekly roster plan / recall / resubmission','People','hr_roster_plans','[]'::jsonb,'[{"table": "hr_roster_approval_steps", "keys": ["plan_id"]}]'::jsonb),
('roster_swap','Shift swap request','People','hr_roster_swap_requests','[]'::jsonb,'[{"table": "hr_roster_swap_approval_steps", "keys": ["request_id", "swap_request_id"]}]'::jsonb),
('document','Employee document request','People','hr_document_requests','["request_number"]'::jsonb,'[{"table": "hr_document_request_events", "keys": ["request_id"]}, {"table": "hr_document_request_messages", "keys": ["request_id"]}]'::jsonb),
('exit','Exit / resignation / withdrawal','People','hr_exit_cases','["case_number"]'::jsonb,'[{"table": "hr_exit_events", "keys": ["exit_case_id", "case_id"]}]'::jsonb),
('people_lifecycle','Suspension / restoration / access reconciliation','People','hr_worker_lifecycle_events','[]'::jsonb,'[]'::jsonb),
('people_case','Connect Centre case / protected report','People','communication_cases','["case_number"]'::jsonb,'[{"table": "communication_case_events", "keys": ["case_id"]}]'::jsonb),
('unplanned_leave','Unplanned leave case','People','hr_unplanned_leave_cases','[]'::jsonb,'[{"table": "hr_unplanned_leave_case_history", "keys": ["case_id"]}]'::jsonb),
('workforce_onboarding','Associate registration and joining','Workforce','workforce','["dropx_id"]'::jsonb,'[{"table": "workforce_onboarding_events", "keys": ["workforce_id"]}, {"table": "workforce_joining_events", "keys": ["workforce_id"]}]'::jsonb),
('workforce_exit','Associate exit / lifecycle case','Workforce','workforce_lifecycle_cases','[]'::jsonb,'[{"table": "workforce_lifecycle_events", "keys": ["case_id"]}]'::jsonb),
('amazon_invite','Provider / Amazon invitation request','Workforce','workforce_amazon_invitation_requests','["external_reference"]'::jsonb,'[]'::jsonb),
('referral','Refer-and-earn referral','Workforce','workforce_referrals','[]'::jsonb,'[]'::jsonb),
('workforce_connect','Associate Connect support request','Workforce','workforce_connect_requests','[]'::jsonb,'[]'::jsonb),
('lead','Recruitment lead / candidate','Recruit','recruitment_leads','["meta_lead_id", "canonical_key"]'::jsonb,'[{"table": "recruitment_lead_history", "keys": ["lead_id"]}]'::jsonb),
('application','Job application and People handoff','Recruit','recruitment_applications','["external_application_id"]'::jsonb,'[]'::jsonb),
('requisition','Hiring requisition','Recruit','recruitment_job_requisitions','["requisition_code"]'::jsonb,'[{"table": "recruitment_requisition_events", "keys": ["requisition_id"]}]'::jsonb),
('ad_request','Advertising request / external publication','Recruit','recruitment_ad_requests','["request_id"]'::jsonb,'[]'::jsonb),
('profile_change','Workforce profile change request','Recruit','workforce_profile_change_requests','[]'::jsonb,'[]'::jsonb),
('ops_review','Operational performance review','OpsPulse','ops_performance_reviews','[]'::jsonb,'[{"table": "ops_performance_review_updates", "keys": ["review_id"]}]'::jsonb),
('ops_followup','Operational follow-up action','OpsPulse','ops_performance_followups','[]'::jsonb,'[]'::jsonb),
('cod','COD proof / exception / reconciliation','OpsPulse','cod_submissions','[]'::jsonb,'[{"table": "cod_proof_history", "keys": ["submission_id"]}, {"table": "cod_reconciliation_audit_log", "keys": ["submission_id"]}]'::jsonb),
('asset_audit','Company asset audit','Fleet','asset_audit_sessions','["audit_number"]'::jsonb,'[{"table": "asset_events", "keys": ["audit_session_id"]}]'::jsonb),
('fleet_audit','Vehicle audit and findings','Fleet','fleet_audits','[]'::jsonb,'[]'::jsonb),
('fleet_service','Vehicle service / maintenance record','Fleet','fleet_service_history','[]'::jsonb,'[]'::jsonb),
('workspace_job','Mailbox / identity job','Dashboard','google_workspace_jobs','[]'::jsonb,'[{"table": "google_workspace_audit_log", "keys": ["job_id"]}]'::jsonb),
('import','Report import batch','Dashboard','report_import_batches','[]'::jsonb,'[]'::jsonb),
('connector','External connector run','Dashboard','amazon_connector_runs','[]'::jsonb,'[{"table": "amazon_connector_run_events", "keys": ["run_id"]}]'::jsonb),
('edd_refresh','EDD / review-source refresh job','Dashboard','ops_review_edd_refresh_jobs','[]'::jsonb,'[]'::jsonb),
('finance_master','Finance policy / rent changes','Dashboard','finance_rent_audit','[]'::jsonb,'[]'::jsonb),
('access_change','Designation / access / routing changes','Dashboard','position_access_events','[]'::jsonb,'[]'::jsonb)
on conflict (kind) do update set label=excluded.label,portal=excluded.portal,source_table=excluded.source_table,aliases=excluded.aliases,history=excluded.history;

-- Only verified tenant-bearing root tables get triggers. Legacy/composite queues
-- remain visibly unavailable until their tenant mapping has a dedicated adapter.
do $$ declare s record; begin
 for s in select * from public.request_tracker_sources loop
  if exists(select 1 from information_schema.columns where table_schema='public' and table_name=s.source_table and column_name='company_id')
     and exists(select 1 from information_schema.columns where table_schema='public' and table_name=s.source_table and column_name='id')
     and exists(select 1 from pg_class c join pg_namespace n on c.relnamespace=n.oid where n.nspname='public' and c.relname=s.source_table and c.relkind in ('r','p')) then
   execute format('create trigger request_tracker_capture after insert or update or delete on public.%I for each row execute function public.request_tracker_capture(%L)',s.source_table,s.kind);
  end if;
 end loop;
end $$;

-- Track edits to line items and history rows as well as their request headers.
-- Existing history inserts appear as workflow evidence and separately as a
-- database mutation; each is explicitly labelled by provenance in the UI.
do $$ declare s record; h jsonb; parent_key text; begin
 for s in select kind,history from public.request_tracker_sources loop
  for h in select * from jsonb_array_elements(s.history || case s.kind
   when 'expense_claim' then '[{"table":"hr_expense_items","keys":["claim_id"]},{"table":"hr_expense_attachments","keys":["claim_id"]},{"table":"hr_expense_approval_steps","keys":["claim_id"]}]'::jsonb
   when 'workforce_payroll' then '[{"table":"workforce_payroll_items","keys":["payroll_run_id"]},{"table":"workforce_payroll_finance_links","keys":["payroll_run_id"]}]'::jsonb
   when 'asset_audit' then '[{"table":"asset_audit_items","keys":["session_id"]}]'::jsonb
   else '[]'::jsonb end) loop
   select string_agg(c.column_name,',' order by k.ord) into parent_key from jsonb_array_elements_text(h->'keys') with ordinality k(name,ord)
   join information_schema.columns c on c.table_schema='public' and c.table_name=h->>'table' and c.column_name=k.name;
   if parent_key is not null and exists(select 1 from information_schema.columns where table_schema='public' and table_name=h->>'table' and column_name='company_id')
    and exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=h->>'table' and c.relkind in ('r','p')) then
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.request_tracker_capture(%L,%L)','request_tracker_child_'||s.kind,h->>'table',s.kind,parent_key);
   end if;
  end loop;
 end loop;
end $$;

create function public.request_tracker_search(p_company uuid,p_kind text default 'payment',p_query text default '',p_status text default '',p_offset integer default 0)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare s record; collection jsonb='[]'; batch jsonb; warnings jsonb='[]'; predicate text; alias text; ordering text; n integer; items jsonb;
begin
 if p_company is null then raise exception 'Company is required'; end if;
 if length(p_query)>160 or p_offset<0 or p_offset>10000 then raise exception 'Invalid search'; end if;
 for s in select * from public.request_tracker_sources where p_kind='' or kind=p_kind order by kind loop
  begin
   predicate='';
   for alias in select jsonb_array_elements_text(s.aliases) loop
    predicate=predicate||format(' or to_jsonb(t)->>%L = $2',alias);
   end loop;
   ordering='coalesce(to_jsonb(t)->>''updated_at'',to_jsonb(t)->>''created_at'',to_jsonb(t)->>''requested_at'',to_jsonb(t)->>''submitted_at'','''')';
   execute format('select coalesce(jsonb_agg(x),''[]'') from (select jsonb_build_object(''kind'',%L,''portal'',%L,''label'',%L,''record'',public.request_tracker_redact(to_jsonb(t))) as x from public.%I t where t.company_id=$1 and ($2='''' or t.id::text=$2 %s) and ($3='''' or coalesce(to_jsonb(t)->>''status'',to_jsonb(t)->>''state'','''')=$3) order by %s desc,t.id limit $4) matches',s.kind,s.portal,s.label,s.source_table,predicate,ordering)
    into batch using p_company,btrim(p_query),p_status,p_offset+51;
   collection=collection||batch;
   -- Deleted roots remain discoverable by UUID or their retained aliases.
   if btrim(p_query)<>'' and p_status in ('','deleted') then
    execute format('select coalesce(jsonb_agg(x),''[]'') from (select distinct on (e.source_id) jsonb_build_object(''kind'',%L,''portal'',%L,''label'',%L,''record'',e.before_data||jsonb_build_object(''status'',''deleted'',''approval_status'',''deleted'')) x from public.request_tracker_events e where e.company_id=$1 and e.kind=$3 and e.source_table=%L and e.operation=''delete'' and e.source_row_id=e.source_id and (e.source_id=$2 or exists(select 1 from jsonb_array_elements_text($4) a where e.before_data->>a=$2)) and not exists(select 1 from public.%I t where t.company_id=$1 and t.id::text=e.source_id) order by e.source_id,e.recorded_at desc,e.id desc limit 51) deleted_roots',s.kind,s.portal,s.label,s.source_table,s.source_table)
    into batch using p_company,btrim(p_query),s.kind,s.aliases;
    collection=collection||batch;
   end if;
  exception when undefined_table or undefined_column then
   warnings=warnings||jsonb_build_array(jsonb_build_object('kind',s.kind,'label',s.label,'message','Source is not available in the deployed schema.'));
  end;
 end loop;
 select count(*) into n from jsonb_array_elements(collection);
 select coalesce(jsonb_agg(value order by stamp desc,identity),'[]') into items from (
  select value,coalesce(value->'record'->>'updated_at',value->'record'->>'created_at',value->'record'->>'requested_at',value->'record'->>'submitted_at','') stamp,
  (value->>'kind')||':'||(value->'record'->>'id') identity from jsonb_array_elements(collection)
  order by stamp desc,identity offset p_offset limit 50
 ) page;
 return jsonb_build_object('rows',items,'hasMore',n>p_offset+50,'warnings',warnings,'checkedAt',clock_timestamp());
end $$;

create function public.request_tracker_detail(p_company uuid,p_kind text,p_id text,p_offset integer default 0)
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
   execute format('select coalesce(jsonb_agg(x),''[]'') from (select jsonb_build_object(''source'',%L,''record'',public.request_tracker_redact(to_jsonb(t))) x from public.%I t where to_jsonb(t)->>''company_id''=$1 and (%s) order by coalesce(to_jsonb(t)->>''created_at'',to_jsonb(t)->>''decided_at'','''') desc,to_jsonb(t)->>''id'' desc limit $3) e',h->>'table',h->>'table',predicate)
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
  select value,coalesce(value->'record'->>'recorded_at',value->'record'->>'created_at',value->'record'->>'timestamp',value->'record'->>'at',value->'record'->>'decided_at','') stamp,
  coalesce(value->>'source','')||coalesce(value->'record'->>'id',value::text) identity from jsonb_array_elements(events)
  order by stamp desc,identity offset p_offset limit 100
 ) page;
 return jsonb_build_object('kind',s.kind,'label',s.label,'portal',s.portal,'record',root,'events',items,'hasMore',n>p_offset+100,'warnings',warnings,'auditSince',s.installed_at,'deleted',retired);
end $$;

-- Reverse relationships are derived from explicit foreign-reference fields only.
create function public.request_tracker_related(p_company uuid,p_kind text,p_id text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare s record; col text; pred text; batch jsonb; result jsonb='[]'; keys text[];
begin
 keys=case p_kind when 'payment' then array['payment_request_id'] when 'expense_request' then array['claim_request_id'] when 'expense_claim' then array['claim_id','consumed_claim_id'] when 'workforce_payroll' then array['payroll_run_id'] when 'payout_publication' then array['publication_id'] when 'payout_dispute' then array['dispute_id'] when 'payout_correction' then array['correction_id'] when 'adjustment' then array['adjustment_id'] when 'lead' then array['lead_id'] when 'requisition' then array['requisition_id'] when 'exit' then array['exit_case_id'] when 'ops_review' then array['review_id'] else array[]::text[] end;
 for s in select * from public.request_tracker_sources loop
  pred='';
  for col in select column_name from information_schema.columns where table_schema='public' and table_name=s.source_table and column_name=any(keys) loop
   pred=pred||case when pred='' then '' else ' or ' end||format('t.%I::text=$2',col);
  end loop;
  if pred='' then continue; end if;
  begin
   execute format('select coalesce(jsonb_agg(x),''[]'') from (select jsonb_build_object(''kind'',%L,''label'',%L,''id'',t.id,''reference'',coalesce(to_jsonb(t)->>''request_no'',to_jsonb(t)->>''claim_no'',to_jsonb(t)->>''run_number'',t.id::text),''status'',to_jsonb(t)->>''status'') x from public.%I t where t.company_id=$1 and (%s) order by t.id limit 21) r',s.kind,s.label,s.source_table,pred) into batch using p_company,p_id;
   result=result||batch;
  exception when undefined_table or undefined_column then null;
  end;
 end loop;
 -- Payroll finance links are a join entity, not a second payment request.
 begin
  select result||coalesce(jsonb_agg(jsonb_build_object('kind',case when p_kind='payment' then 'workforce_payroll' else 'payment' end,'label','Payroll / Finance handoff','id',case when p_kind='payment' then payroll_run_id::text else payment_request_id::text end,'reference',case when p_kind='payment' then payroll_run_id::text else payment_request_id::text end)),'[]') into result
  from (select * from public.workforce_payroll_finance_links where company_id=p_company and ((p_kind='payment' and payment_request_id::text=p_id) or (p_kind='workforce_payroll' and payroll_run_id::text=p_id)) limit 21) l;
 exception when undefined_table or undefined_column then null;
 end;
 return result;
end $$;

revoke all on function public.request_tracker_capture() from public,anon,authenticated,service_role;
revoke all on function public.request_tracker_redact(jsonb) from public,anon,authenticated;
revoke all on function public.request_tracker_search(uuid,text,text,text,integer) from public,anon,authenticated;
revoke all on function public.request_tracker_detail(uuid,text,text,integer) from public,anon,authenticated;
revoke all on function public.request_tracker_related(uuid,text,text) from public,anon,authenticated;
grant execute on function public.request_tracker_redact(jsonb),public.request_tracker_search(uuid,text,text,text,integer),public.request_tracker_detail(uuid,text,text,integer),public.request_tracker_related(uuid,text,text) to service_role;
notify pgrst,'reload schema';
commit;
