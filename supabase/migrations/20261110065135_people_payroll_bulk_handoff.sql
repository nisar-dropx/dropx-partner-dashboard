-- Additive, service-only handoff and atomic multi-location People bank exports.
-- Existing salary approvals, loss fingerprints and immutable bank references remain authoritative.
create table if not exists public.people_finance_combined_batches (
 id uuid primary key, company_id uuid not null, actor_id uuid not null,
 request_ids uuid[] not null, bank_id uuid not null, value_date date not null,
 line_count integer not null, amount_paise bigint not null,
 created_at timestamptz not null default clock_timestamp()
);
create index if not exists people_finance_combined_company on public.people_finance_combined_batches(company_id,created_at desc);
alter table public.people_finance_combined_batches enable row level security;
revoke all on public.people_finance_combined_batches from public,anon,authenticated,service_role;
grant select on public.people_finance_combined_batches to service_role;

create or replace function public.people_finance_payment_preview(p_company uuid,p_run uuid,p_station uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare payload jsonb; person jsonb; people jsonb:='[]'; issues jsonb:='[]'; r public.people_finance_requests;
 paid numeric; processing integer; hold numeric; inside boolean; full_hold boolean; balance numeric; payable numeric;
 account text; ifsc text; blocked text; run_approved boolean;
begin
 payload:=public.payment_release_payroll_snapshot(p_company,p_run,p_station);
 select * into r from public.people_finance_requests where company_id=p_company and run_id=p_run and station_id=p_station;
 select exists(select 1 from public.hr_payroll_station_releases where company_id=p_company and run_id=p_run and location_id=p_station)
 or exists(select 1 from public.hr_payroll_runs where company_id=p_company and id=p_run and status in ('approved','locked')
   and not coalesce(station_payments_explicit,false) and not exists(select 1 from public.hr_payroll_station_releases where company_id=p_company and run_id=p_run)) into run_approved;
 for person in select value from jsonb_array_elements(payload) loop
  select coalesce(sum(amount) filter(where status='paid'),0),count(*) filter(where status in ('processing','issued'))
   into paid,processing from public.hr_payroll_bank_lines where company_id=p_company and run_id=p_run
    and worker_type=split_part(person->>'worker',':',1) and worker_id=split_part(person->>'worker',':',2)::uuid;
  select coalesce(sum((i->>'amount')::numeric),0),coalesce(bool_or(i->>'type'='deduction' and (i->>'amount')::numeric>0),false),
   coalesce(bool_or(i#>>'{metadata,full_month}'='true'),false)
   into hold,inside,full_hold from jsonb_array_elements(person->'items') i where upper(i->>'code')='SALARY_HOLD';
  balance:=round(greatest(0,coalesce((person->>'adjusted')::numeric,(person->>'net')::numeric)-case when inside then 0 else hold end-paid),2);
  blocked:=case when person->>'status'='blocked' then 'Blocked in People' when full_hold then 'Salary on hold' when processing>0 then 'Bank processing' when balance<=0 then 'No unpaid balance' else null end;
  account:=regexp_replace(coalesce(person->>'account',''),'\s','','g'); ifsc:=upper(trim(coalesce(person->>'ifsc','')));
  if blocked is null and (account !~ '^[0-9]{6,30}$' or ifsc !~ '^[A-Z]{4}0[A-Z0-9]{6}$' or nullif(trim(person->>'name'),'') is null) then
   blocked:='Correct bank details in People'; issues:=issues||jsonb_build_array(jsonb_build_object('name',person->>'name','reason',blocked));
  end if;
  if blocked is null and exists(select 1 from public.hr_payroll_bank_lines b join public.hr_payroll_runs other_run on other_run.id=b.run_id and other_run.company_id=b.company_id
   join public.hr_payroll_runs this_run on this_run.id=p_run and this_run.company_id=p_company
   where b.company_id=p_company and b.run_id<>p_run and b.worker_type=split_part(person->>'worker',':',1) and b.worker_id=split_part(person->>'worker',':',2)::uuid
   and b.status in ('paid','issued','processing') and other_run.period_start<=this_run.period_end and other_run.period_end>=this_run.period_start) then
   blocked:='Payment exists in an overlapping payroll'; issues:=issues||jsonb_build_array(jsonb_build_object('name',person->>'name','reason',blocked));
  end if;
  payable:=case when blocked is null then balance else 0 end;
  people:=people||jsonb_build_array(jsonb_build_object('worker',person->>'worker','name',person->>'name','status',person->>'status',
   'net',coalesce((person->>'adjusted')::numeric,(person->>'net')::numeric),'items',person->'items','bankLast4',right(account,4),
   'paid',paid,'processing',processing,'remaining',balance,'payable',payable,'exclusion',blocked));
 end loop;
 return jsonb_build_object('hash',md5(payload::text),'peopleCount',jsonb_array_length(payload),'changed',r.id is not null and r.payroll_hash<>md5(payload::text),
  'runApproved',run_approved,'request',case when r.id is null then null else jsonb_build_object('status',r.status,'review_note',r.review_note) end,'people',people,'issues',issues,
  'readyCount',(select count(*) from jsonb_array_elements(people) p where (p->>'payable')::numeric>0),
  'amountPaise',(select coalesce(sum(round((p->>'payable')::numeric*100)),0) from jsonb_array_elements(people) p),
  'excludedCount',(select count(*) from jsonb_array_elements(people) p where p->>'exclusion' is not null));
end $$;

-- In-flight workers are held out of the next file, alongside blocked and held people.
-- Never create a second instruction while an earlier one is in flight.
do $$ declare definition text; old_text text; new_text text; begin
 definition:=pg_get_functiondef('public.people_finance_issue(uuid,uuid,uuid,uuid,uuid,date)'::regprocedure);
 old_text:='then raise exception ''A selected person already has an issued or processing payment. Reconcile or cancel that instruction first.''; end if;';
 new_text:='then continue; end if; -- exclude in-flight people from new bank files';
 if position(old_text in definition)>0 then definition:=replace(definition,old_text,new_text);
 elsif position(new_text in definition)=0 then raise exception 'Unexpected People bank issuer; review before applying.'; end if;
 -- Identity always includes worker type, just like the submitted payroll snapshot.
 definition:=replace(definition,'worker_id=v_person.worker_id and status', 'worker_id=v_person.worker_id and worker_type=v_person.worker_type and status');
 definition:=replace(definition,'worker_id=v_person.worker_id;', 'worker_id=v_person.worker_id and worker_type=v_person.worker_type;');
 definition:=replace(definition, 'nullif(trim(v_bank.account_no),'''') is null', 'regexp_replace(coalesce(v_bank.account_no,''''),''\s'','''',''g'') !~ ''^[A-Za-z0-9]{4,30}$''');
 -- Only positive eligible instructions participate in the overlapping-payroll check.
 old_text:=$overlap$  if exists(select 1 from public.hr_payroll_bank_lines b join public.hr_payroll_runs other_run on other_run.company_id=b.company_id and other_run.id=b.run_id
    join public.hr_payroll_runs this_run on this_run.company_id=p_company and this_run.id=r.run_id
    where b.company_id=p_company and b.run_id<>r.run_id and b.worker_id=v_person.worker_id and b.worker_type=v_person.worker_type
      and b.status in ('issued','processing','paid') and other_run.period_start<=this_run.period_end and other_run.period_end>=this_run.period_start)
  then raise exception 'This person has payment history in another overlapping payroll run. Reconcile and revise the original payroll instead of paying a second run.'; end if;
$overlap$;
 if position(old_text in definition)>0 and position('  if v_amount<=0 then continue; end if;'||E'\n'||old_text in definition)=0 then
  definition:=replace(definition,old_text,'');
  definition:=replace(definition,'  if v_amount<=0 then continue; end if;'||E'\n','  if v_amount<=0 then continue; end if;'||E'\n'||old_text);
 end if;
 execute definition;
end $$;

create or replace function public.people_finance_issue_many(p_company uuid,p_requests uuid[],p_actor uuid,p_operation uuid,p_bank uuid,p_value_date date,p_expected jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare ids uuid[]; old_batch public.people_finance_combined_batches; request_row public.people_finance_requests;
 request_id uuid; child uuid; result jsonb; preview jsonb; instructions jsonb:='[]'; station_code text; expected jsonb; error_text text;
begin
 if p_operation is null or p_bank is null or p_value_date is null or coalesce(cardinality(p_requests),0) not between 1 and 100
 or array_position(p_requests,null) is not null then raise exception 'Select 1 to 100 locations, a debit bank and value date.'; end if;
 select array_agg(distinct x order by x) into ids from unnest(p_requests) x;
 if cardinality(ids)<>cardinality(p_requests) then raise exception 'A location submission was selected more than once.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('nl-recovery:'||p_company::text,0));
 select * into old_batch from public.people_finance_combined_batches where id=p_operation;
 if old_batch.id is not null and (old_batch.company_id<>p_company or old_batch.request_ids<>ids or old_batch.bank_id<>p_bank or old_batch.value_date<>p_value_date)
 then raise exception 'This download operation belongs to a different selection or bank.'; end if;
 -- Validate the complete scope and the exact reviewed figures before creating any instructions.
 foreach request_id in array ids loop
  select * into request_row from public.people_finance_requests where id=request_id and company_id=p_company for update;
  if request_row.id is null then raise exception 'A payroll submission is unavailable.'; end if;
  perform public.payment_release_actor(p_company,p_actor,request_row.station_id);
  if old_batch.id is null then
   select s.station_code into station_code from public.stations s where s.id=request_row.station_id and s.company_id=p_company;
   preview:=public.people_finance_payment_preview(p_company,request_row.run_id,request_row.station_id);
   expected:=p_expected->request_id::text;
   if expected is null or (expected->>'version')::int is distinct from request_row.version
     or expected->>'hash' is distinct from preview->>'hash' or expected->>'amountPaise' is distinct from preview->>'amountPaise'
     or expected->>'readyCount' is distinct from preview->>'readyCount'
   then raise exception '%: figures changed. Refresh and review the selection again.',station_code; end if;
   if request_row.status<>'approved' or (preview->>'changed')::boolean or not (preview->>'runApproved')::boolean
    then raise exception '%: current People and Finance approval is required.',station_code; end if;
   if jsonb_array_length(preview->'issues')>0 then raise exception '%: % — %.',station_code,preview#>>'{issues,0,name}',preview#>>'{issues,0,reason}'; end if;
   if (preview->>'readyCount')::int=0 then raise exception '%: no unpaid people are ready for a new file.',station_code; end if;
  end if;
 end loop;
 if old_batch.id is null and exists(
  select 1 from public.hr_payroll_run_people p join public.people_finance_requests r on r.company_id=p.company_id and r.run_id=p.run_id and r.station_id=p.location_id
  where r.company_id=p_company and r.id=any(ids) and p.calculation_status<>'blocked'
  group by p.worker_type,p.worker_id having count(distinct r.id)>1
 ) then raise exception 'A person appears in more than one selected payroll. Review the locations separately to avoid duplicate payment.'; end if;
 foreach request_id in array ids loop
  child:=md5(p_operation::text||':'||request_id::text)::uuid;
  begin
   result:=public.people_finance_issue(p_company,request_id,p_actor,child,p_bank,p_value_date);
  exception when others then
   get stacked diagnostics error_text=message_text;
   select s.station_code into station_code from public.people_finance_requests r join public.stations s on s.id=r.station_id and s.company_id=r.company_id where r.company_id=p_company and r.id=request_id;
   raise exception '%: %',station_code,error_text;
  end;
  instructions:=instructions||(result->'instructions');
 end loop;
 if old_batch.id is null then
  insert into public.people_finance_combined_batches(id,company_id,actor_id,request_ids,bank_id,value_date,line_count,amount_paise)
   values(p_operation,p_company,p_actor,ids,p_bank,p_value_date,jsonb_array_length(instructions),
    (select sum((i->>'amountPaise')::bigint) from jsonb_array_elements(instructions) i));
 end if;
 return jsonb_build_object('instructions',instructions,'replayed',old_batch.id is not null,'operationId',p_operation);
end $$;

create table if not exists public.loss_payment_handoffs (
 id uuid primary key default gen_random_uuid(),company_id uuid not null,station_id uuid not null,salary_month text not null,scope_key text not null,
 assigned_to uuid not null,requested_by uuid not null,requested_at timestamptz not null default clock_timestamp(),due_date date not null,
 status text not null check(status in ('pending','returned','resolved','follow_up')),note text not null,fingerprint text not null,version integer not null default 1,
 unique(company_id,station_id,salary_month,scope_key)
);
create table if not exists public.loss_payment_handoff_events (
 id uuid primary key default gen_random_uuid(),company_id uuid not null,handoff_id uuid not null,actor_id uuid not null,
 action text not null,reason text not null,snapshot jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create index if not exists loss_payment_handoff_queue on public.loss_payment_handoffs(company_id,assigned_to,status,due_date);
create index if not exists loss_payment_handoff_history on public.loss_payment_handoff_events(company_id,handoff_id,created_at desc);
do $$ declare tab text; begin foreach tab in array array['loss_payment_handoffs','loss_payment_handoff_events'] loop
 execute format('alter table public.%I enable row level security',tab);
 execute format('revoke all on public.%I from public,anon,authenticated,service_role',tab);
 execute format('grant select on public.%I to service_role',tab);
end loop; end $$;

create or replace function public.loss_payment_handoff(p_company uuid,p_station uuid,p_month text,p_scope text,p_actor uuid,p_action text,p_assignee uuid,p_due date,p_reason text,p_fingerprint text,p_version integer default 0)
returns uuid language plpgsql security definer set search_path='' as $$
declare task public.loss_payment_handoffs; review jsonb; task_id uuid;
begin
 perform public.payment_release_actor(p_company,p_actor,p_station,p_action='return');
 perform pg_advisory_xact_lock(hashtextextended('nl-recovery:'||p_company::text,0));
 review:=public.loss_payment_release_review(p_company,p_station,p_month,p_scope);
 if p_fingerprint is distinct from review->>'fingerprint' then raise exception 'Loss or payroll changed. Refresh before handing off.'; end if;
 if p_action not in ('request','return') or p_action is null or length(trim(coalesce(p_reason,''))) not between 10 and 2000 then raise exception 'Record a handoff note of 10 to 2000 characters.'; end if;
 select * into task from public.loss_payment_handoffs where company_id=p_company and station_id=p_station and salary_month=p_month and scope_key=p_scope for update;
 if coalesce(task.version,0) is distinct from p_version then raise exception 'The handoff changed. Refresh before continuing.'; end if;
 if p_action='request' then
  perform public.payment_release_actor(p_company,p_assignee,p_station,true);
  if p_due is null or p_due<(now() at time zone 'Asia/Kolkata')::date or p_due>(now() at time zone 'Asia/Kolkata')::date+90 then raise exception 'Choose a follow-up date within 90 days.'; end if;
  insert into public.loss_payment_handoffs(company_id,station_id,salary_month,scope_key,assigned_to,requested_by,due_date,status,note,fingerprint)
   values(p_company,p_station,p_month,p_scope,p_assignee,p_actor,p_due,'pending',trim(p_reason),p_fingerprint)
  on conflict(company_id,station_id,salary_month,scope_key) do update set assigned_to=excluded.assigned_to,requested_by=excluded.requested_by,
    requested_at=clock_timestamp(),due_date=excluded.due_date,status='pending',note=excluded.note,fingerprint=excluded.fingerprint,version=loss_payment_handoffs.version+1
  returning id into task_id;
 else
  if task.id is null or task.status not in ('pending','follow_up') then raise exception 'There is no pending handoff to return.'; end if;
  update public.loss_payment_handoffs set status='returned',note=trim(p_reason),version=version+1 where id=task.id returning id into task_id;
 end if;
 insert into public.loss_payment_handoff_events(company_id,handoff_id,actor_id,action,reason,snapshot)
 values(p_company,task_id,p_actor,p_action,trim(p_reason),jsonb_build_object('previous',to_jsonb(task),'review',review,'assigned_to',p_assignee,'due_date',p_due));
 return task_id;
end $$;

-- A recorded release decision closes the corresponding task; it never writes off a loss.
create or replace function public.complete_loss_payment_handoff()
returns trigger language plpgsql security definer set search_path='' as $$
declare task public.loss_payment_handoffs;
begin
 select * into task from public.loss_payment_handoffs where company_id=new.company_id and station_id=new.station_id and salary_month=new.salary_month and scope_key=new.scope_key for update;
 if task.id is not null then
  update public.loss_payment_handoffs set status=case when new.action='revoke' then 'pending' when new.action='exception' then 'follow_up' else 'resolved' end,version=version+1 where id=task.id;
  insert into public.loss_payment_handoff_events(company_id,handoff_id,actor_id,action,reason,snapshot)
   values(new.company_id,task.id,new.actor_id,new.action,new.reason,jsonb_build_object('release_event',new.id,'review',new.review,'previous',to_jsonb(task)));
 end if;
 return new;
end $$;
drop trigger if exists complete_loss_payment_handoff on public.loss_payment_release_events;
create trigger complete_loss_payment_handoff after insert on public.loss_payment_release_events for each row execute function public.complete_loss_payment_handoff();

do $$ declare f regprocedure; begin
 foreach f in array array[
 'public.people_finance_payment_preview(uuid,uuid,uuid)'::regprocedure,
 'public.people_finance_issue_many(uuid,uuid[],uuid,uuid,uuid,date,jsonb)'::regprocedure,
 'public.loss_payment_handoff(uuid,uuid,text,text,uuid,text,uuid,date,text,text,integer)'::regprocedure,
 'public.complete_loss_payment_handoff()'::regprocedure] loop
 execute format('revoke all on function %s from public,anon,authenticated',f);
 execute format('grant execute on function %s to service_role',f);
 end loop;
end $$;

create or replace function public.payment_release_reviewers(p_company uuid,p_station uuid)
returns table(id uuid,name text) language sql stable security definer set search_path='' as $$
 select distinct p.id,coalesce(nullif(p.full_name,''),p.email) from public.profiles p
 join public.company_product_memberships m on m.user_id=p.id and m.company_id=p.company_id and m.is_active
 join public.user_roles r on r.id=m.role_id and r.is_active
 where p.company_id=p_company and p.is_active and m.product_code in ('operations','ops','finance','people','dashboard','workforce')
 and (m.has_all_location_access or r.location_access_mode='all_locations' or p_station=any(m.location_scope_ids))
 and regexp_replace(upper(r.code),'^(OPERATIONS|FINANCE|PEOPLE|WORKFORCE)_','') in ('SLPM','SLP_MANAGER','NH','NATIONAL_HEAD','FINMGR','FINANCE_MANAGER','MP','MANAGING_PARTNER','SALES_MANAGER')
 order by 2;
$$;
revoke all on function public.payment_release_reviewers(uuid,uuid) from public,anon,authenticated;
grant execute on function public.payment_release_reviewers(uuid,uuid) to service_role;

-- A recorded override owns an actionable follow-up; assigning and deciding are atomic.
create or replace function public.loss_payment_release_with_handoff(p_company uuid,p_station uuid,p_month text,p_scope text,p_actor uuid,p_fingerprint text,p_reason text,p_assignee uuid,p_due date,p_version integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare owner_name text;
begin
 perform public.payment_release_actor(p_company,p_actor,p_station,true);
 perform public.loss_payment_handoff(p_company,p_station,p_month,p_scope,p_actor,'request',p_assignee,p_due,p_reason,p_fingerprint,p_version);
 select coalesce(nullif(full_name,''),email) into owner_name from public.profiles where id=p_assignee and company_id=p_company;
 return public.loss_payment_release_decide(p_company,p_station,p_month,p_scope,p_actor,'exception',p_fingerprint,p_reason,owner_name,p_due);
end $$;
revoke all on function public.loss_payment_release_with_handoff(uuid,uuid,text,text,uuid,text,text,uuid,date,integer) from public,anon,authenticated;
grant execute on function public.loss_payment_release_with_handoff(uuid,uuid,text,text,uuid,text,text,uuid,date,integer) to service_role;

-- Resolved handoffs reappear when source/payroll changes invalidate clearance.
create or replace function public.loss_payment_handoff_queue(p_company uuid,p_stations uuid[] default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare task public.loss_payment_handoffs; review jsonb; result jsonb:='[]';
begin
 for task in select * from public.loss_payment_handoffs where company_id=p_company and (p_stations is null or station_id=any(p_stations)) order by due_date,id loop
  if task.status='resolved' then
   review:=public.loss_payment_release_review(p_company,task.station_id,task.salary_month,task.scope_key);
   if review->'approval' is not null and review->'approval'<>'null'::jsonb then continue; end if;
   result:=result||jsonb_build_array(to_jsonb(task)||jsonb_build_object('status','review_again'));
  else result:=result||jsonb_build_array(to_jsonb(task)); end if;
 end loop;
 return result;
end $$;
revoke all on function public.loss_payment_handoff_queue(uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.loss_payment_handoff_queue(uuid,uuid[]) to service_role;
