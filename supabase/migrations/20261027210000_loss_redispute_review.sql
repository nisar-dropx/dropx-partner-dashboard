begin;
alter table nl_case_response_windows add column if not exists workflow_status text not null default 'legacy';
alter table nl_case_response_windows add column if not exists activated_by uuid;
alter table nl_case_response_windows add column if not exists submitted_by uuid;
alter table nl_case_response_windows add column if not exists reviewed_by uuid;
alter table nl_case_response_windows add column if not exists response_details jsonb not null default '{}';
alter table nl_case_response_windows add column if not exists recovery_month text;
alter table nl_case_response_events drop constraint if exists nl_case_response_events_action_check;
alter table nl_case_response_events add constraint nl_case_response_events_action_check check(action in ('activate','revoke','response','vendor_response','tracking','approve','return','won','lost'));
create or replace function nl_redispute_transition(p_company uuid,p_month text,p_case text,p_version int,p_action text,p_details jsonb,p_actor uuid,p_name text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare w nl_case_response_windows; c nl_loss_month_cases; note text:=trim(coalesce(p_details->>'note','')); before_state jsonb; target text; policy jsonb;
begin
 if p_actor is null or nullif(trim(p_name),'') is null then raise exception 'An authenticated actor is required.'; end if;
 if p_action not in ('activate','response','approve','return','tracking','won','lost','revoke') then raise exception 'Unknown redispute action.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('nl-recovery:'||p_company::text,0));
 select * into strict c from nl_loss_month_cases where company_id=p_company and month=p_month and case_key=p_case for update;
 if not nl_case_recoverable(p_company,c.report,c.source_status) or (c.report='slp' and c.final_seen_at is null) then raise exception 'Only final recoverable shipments can enter redispute.'; end if;
 insert into nl_case_response_windows(company_id,month,case_key) values(p_company,p_month,p_case) on conflict do nothing;
 select * into strict w from nl_case_response_windows where company_id=p_company and month=p_month and case_key=p_case for update;
 if w.version<>p_version then raise exception 'This shipment changed. Reload before continuing.'; end if;
 before_state:=to_jsonb(w);
 if p_action='activate' then
  if w.enabled then raise exception 'Redispute is already active for this shipment.'; end if;
  w.enabled:=true; w.workflow_status:='awaiting_station'; w.activated_by:=p_actor; w.submitted_by:=null; w.reviewed_by:=null; w.response_details:='{}'; w.followup_status:='preparing'; w.tt_reference:=null; w.tt_url:=null; w.followup_on:=null;
  note:=coalesce(nullif(note,''),'Redispute enabled. Station evidence required.');
 else
  if not w.enabled then raise exception 'Redispute is not active for this shipment.'; end if;
  if length(note)<10 or length(note)>4000 then raise exception 'Add a clear update (10–4000 characters).'; end if;
  if p_action='response' then
   if w.workflow_status not in ('awaiting_station','returned','legacy') then raise exception 'This response is already awaiting review or approved.'; end if;
   if length(trim(coalesce(p_details->>'reason','')))<5 or length(trim(coalesce(p_details->>'tt_reference','')))<3 then raise exception 'Add the redispute reason and ticket reference.'; end if;
   if coalesce(p_details->>'evidence_url','') !~ '^https://' or length(p_details->>'evidence_url')>2000 then raise exception 'Add an HTTPS footage/evidence link.'; end if;
   w.response_details:=p_details; w.submitted_by:=p_actor; w.reviewed_by:=null; w.workflow_status:='awaiting_review'; w.tt_reference:=trim(p_details->>'tt_reference');
  elsif p_action in ('approve','return') then
   if w.workflow_status<>'awaiting_review' then raise exception 'A station response must be submitted first.'; end if;
   if w.submitted_by=p_actor then raise exception 'Another authorised reviewer must decide this response.'; end if;
   w.reviewed_by:=p_actor; w.workflow_status:=case p_action when 'approve' then 'approved' else 'returned' end;
  elsif p_action in ('tracking','won','lost') then
   if w.workflow_status not in ('approved','with_vendor') then raise exception 'Approve the station evidence before recording post-dispute follow-up.'; end if;
   if length(trim(coalesce(p_details->>'tt_reference','')))<3 then raise exception 'Enter the post-dispute ticket reference.'; end if;
   if coalesce(p_details->>'tt_url','')<>'' and (p_details->>'tt_url' !~ '^https://' or length(p_details->>'tt_url')>2000) then raise exception 'Use an HTTPS ticket link.'; end if;
   w.tt_reference:=trim(p_details->>'tt_reference'); w.tt_url:=nullif(p_details->>'tt_url','');
   if p_action='tracking' then
    w.workflow_status:='with_vendor'; w.followup_status:='with_vendor'; w.followup_on:=(p_details->>'followup_on')::date;
    if w.followup_on is null then raise exception 'Set the next follow-up date.'; end if;
   else
    w.workflow_status:=p_action; w.followup_status:=p_action; w.enabled:=false; w.followup_on:=null;
    if p_action='lost' then
     -- A failed redispute joins the next payroll, never its historical loss month.
     select recovery_policy into policy from nl_loss_sources where company_id=p_company limit 1;
     target:=coalesce(nullif(p_details->>'recovery_month',''),to_char(date_trunc('month',now() at time zone 'Asia/Kolkata')+interval '1 month','YYYY-MM'));
     if target !~ '^\d{4}-(0[1-9]|1[0-2])$' or target<nl_recovery_deduction_month(c.report,c.month,now(),c.final_seen_at,'current_month',coalesce((policy->>'payroll_cutoff_day')::int,5)) then raise exception 'Select an open recovery payroll month.'; end if;
     if target>to_char(date_trunc('month',now() at time zone 'Asia/Kolkata')+interval '12 months','YYYY-MM') then raise exception 'Choose a payroll month within the next 12 months.'; end if;
     w.recovery_month:=target;
    end if;
   end if;
  elsif p_action='revoke' then
   w.enabled:=false; w.workflow_status:='cancelled'; w.followup_status:='closed';
  end if;
 end if;
 update nl_case_response_windows set enabled=w.enabled,workflow_status=w.workflow_status,activated_by=w.activated_by,submitted_by=w.submitted_by,reviewed_by=w.reviewed_by,response_details=w.response_details,tt_reference=w.tt_reference,tt_url=w.tt_url,followup_status=w.followup_status,followup_on=w.followup_on,recovery_month=w.recovery_month,version=version+1,updated_by=p_actor,updated_by_name=p_name,updated_at=now() where company_id=p_company and month=p_month and case_key=p_case returning * into w;
 insert into nl_case_response_events(company_id,month,case_key,action,note,evidence_url,actor_id,actor_name,tracking) values(p_company,p_month,p_case,p_action,note,nullif(p_details->>'evidence_url',''),p_actor,p_name,jsonb_build_object('before',before_state,'after',to_jsonb(w),'details',p_details));
 -- Invalidate cached draft payouts; confirmed deductions are immutable and stay visible.
 perform workforce_bump_payout_period_dependency_revision(p_company,(date_trunc('month',now() at time zone 'Asia/Kolkata')-interval '1 month')::date);
 perform workforce_bump_payout_period_dependency_revision(p_company,date_trunc('month',now() at time zone 'Asia/Kolkata')::date);
 perform workforce_bump_payout_period_dependency_revision(p_company,(date_trunc('month',now())+interval '1 month')::date);
 if w.recovery_month is not null then perform workforce_bump_payout_period_dependency_revision(p_company,to_date(w.recovery_month,'YYYY-MM')); end if;
 return to_jsonb(w);
end $$;
revoke all on function nl_redispute_transition(uuid,text,text,int,text,jsonb,uuid,text) from public,anon,authenticated;
grant execute on function nl_redispute_transition(uuid,text,text,int,text,jsonb,uuid,text) to service_role;
revoke execute on function nl_case_response_transition(uuid,text,text,integer,text,text,text,boolean,uuid,text),nl_redispute_track(uuid,text,text,integer,text,text,text,date,text,uuid,text) from service_role;
-- A single financial guard applies to both payroll engines. Keep original schedules and keys.
do $$ declare d text; begin
 select pg_get_functiondef(oid) into d from pg_proc where pronamespace='public'::regnamespace and proname='nl_loss_recovery_due';
 if position('-- Redispute payroll gate' in d)=0 then
  d:=replace(d,'and r.company_id=p_company',E'and r.company_id=p_company\n -- Redispute payroll gate\n and not exists(select 1 from nl_case_response_windows rw where rw.company_id=r.company_id and rw.month=r.month and rw.case_key=r.case_key and (rw.enabled or rw.workflow_status=''won'' or rw.recovery_month>p_salary_month))');
  if position('-- Redispute payroll gate' in d)=0 then raise exception 'Redispute payroll guard patch failed'; end if;
  execute d;
 end if;
end $$;
-- Keep edits in the recovery form from bypassing the redispute decision or its resume month.
do $$ declare d text; begin
 select pg_get_functiondef(oid) into d from pg_proc where pronamespace='public'::regnamespace and proname='save_nl_recovery';
 if position('-- Redispute plan gate' in d)=0 then
  d:=replace(d,'  -- Explicit payroll month', $patch$  -- Redispute plan gate
  if exists(select 1 from nl_case_response_windows rw where rw.company_id=p_company and rw.month=p_month and rw.case_key=p_case and (rw.enabled or rw.workflow_status='won')) then
   raise exception 'Recovery is paused or stopped by redispute. Use the redispute desk for this shipment.';
  end if;
  -- Explicit payroll month$patch$);
  d:=replace(d,'if p_remarks is null', $patch$  if o.allocation_required and exists(select 1 from nl_case_response_windows rw where rw.company_id=p_company and rw.month=p_month and rw.case_key=p_case and rw.recovery_month>pay_month) then
   raise exception 'Select the redispute recovery month or a later open payroll month.';
  end if;
  if p_remarks is null$patch$);
  if position('-- Redispute plan gate' in d)=0 then raise exception 'Redispute plan guard patch failed'; end if;
  execute d;
 end if;
end $$;
-- Report the same hold / final outcome everywhere, including the own-person ledger in One.
do $$ declare d text; begin
 select pg_get_functiondef(oid) into d from pg_proc where pronamespace='public'::regnamespace and proname='nl_recovery_ledger';
 if position('-- Redispute ledger state' in d)=0 then
  d:=replace(d,'greatest(0,l.total-s.deducted-coalesce(w.amount,0))', 'case when rw.workflow_status=''won'' then 0 else greatest(0,l.total-s.deducted-coalesce(w.amount,0)) end');
  d:=replace(d,'s.deducted_count,l.deduction_month,s.last_in','s.deducted_count,greatest(l.deduction_month,rw.recovery_month),s.last_in');
  d:=replace(d,'case when w.amount is not null then',E'case when rw.workflow_status=''won'' then ''redispute_won'' when rw.enabled then ''redispute_pending''\n   when w.amount is not null then');
  d:=replace(d,'left join nl_recovery_waivers w',E'-- Redispute ledger state\n left join nl_case_response_windows rw on rw.company_id=p_company and rw.month=l.month and rw.case_key=l.case_key\n left join nl_recovery_waivers w');
  if position('-- Redispute ledger state' in d)=0 or position('''redispute_won''' in d)=0 then raise exception 'Redispute ledger patch failed'; end if;
  execute d;
 end if;
end $$;
commit;
