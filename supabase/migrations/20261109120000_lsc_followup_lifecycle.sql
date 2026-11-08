CREATE OR REPLACE FUNCTION public.nl_redispute_transition(p_company uuid, p_month text, p_case text, p_version integer, p_action text, p_details jsonb, p_actor uuid, p_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare w nl_case_response_windows; c nl_loss_month_cases; note text:=trim(coalesce(p_details->>'note','')); before_state jsonb; target text;
begin
 perform public.nl_loss_assert_period_open(p_company,p_month,p_case);
 if p_actor is null or nullif(trim(p_name),'') is null then raise exception 'An authenticated actor is required.'; end if;
 if p_action not in ('activate','response','approve','return','tracking','won','lost','revoke') then raise exception 'Unknown redispute action.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('nl-recovery:'||p_company::text,0));
 select * into strict c from nl_loss_month_cases where company_id=p_company and month=p_month and case_key=p_case for update;
 -- PID revoke after source change
 if p_action<>'revoke' and (not nl_case_recoverable(p_company,c.report,c.source_status) or (c.report='slp' and c.final_seen_at is null)) then raise exception 'Only final recoverable shipments can enter redispute.'; end if;
 insert into nl_case_response_windows(company_id,month,case_key) values(p_company,p_month,p_case) on conflict do nothing;
 select * into strict w from nl_case_response_windows where company_id=p_company and month=p_month and case_key=p_case for update;
 if w.version<>p_version then raise exception 'This shipment changed. Reload before continuing.'; end if;
 before_state:=to_jsonb(w);
 if p_action='activate' then
  if w.enabled then raise exception 'Redispute is already active for this shipment.'; end if;
  w.enabled:=true; w.workflow_status:='awaiting_station'; w.activated_by:=p_actor; w.submitted_by:=null; w.reviewed_by:=null; w.response_details:='{}'; w.followup_status:='preparing'; w.tt_reference:=null; w.tt_url:=null; w.followup_on:=null; w.recovery_month:=null;
  note:=coalesce(nullif(note,''),'Redispute enabled. Station evidence required.');
 else
  if not w.enabled then raise exception 'Redispute is not active for this shipment.'; end if;
  if length(note)<10 or length(note)>4000 then raise exception 'Add a clear update (10–4000 characters).'; end if;
  if p_action='response' then
   if w.workflow_status not in ('awaiting_station','returned','legacy') then raise exception 'This response is already awaiting review or approved.'; end if;
   if length(trim(coalesce(p_details->>'reason','')))<5 or length(trim(coalesce(p_details->>'tt_reference','')))<3 then raise exception 'Add the redispute reason and ticket reference.'; end if;
   if coalesce(p_details->>'evidence_url','') !~ '^https://' or length(p_details->>'evidence_url')>2000 then raise exception 'Add an HTTPS footage/evidence link.'; end if;
   w.response_details:=p_details; w.submitted_by:=p_actor; w.reviewed_by:=null; w.workflow_status:='awaiting_review'; w.tt_reference:=null; w.tt_url:=null;
  elsif p_action in ('approve','return') then
   if w.workflow_status<>'awaiting_review' then raise exception 'A station response must be submitted first.'; end if;
   if w.submitted_by=p_actor then raise exception 'Another authorised reviewer must decide this response.'; end if;
   w.tt_reference:=null; w.tt_url:=null;
   w.reviewed_by:=p_actor; w.workflow_status:=case p_action when 'approve' then 'approved' else 'returned' end;
  elsif p_action in ('tracking','won','lost') then
   if w.workflow_status not in ('approved','with_vendor') then raise exception 'Approve the station evidence before recording post-dispute follow-up.'; end if;
   if p_action in ('won','lost') and (w.workflow_status<>'with_vendor' or length(trim(coalesce(w.tt_reference,'')))<3) then raise exception 'Record the LSC ticket before its final outcome.'; end if;
   if length(trim(coalesce(p_details->>'tt_reference','')))<3 or length(trim(p_details->>'tt_reference'))>160 then raise exception 'Enter the LSC ticket ID (3–160 characters).'; end if;
   if p_action in ('won','lost') and trim(p_details->>'tt_reference') is distinct from w.tt_reference then raise exception 'Use the recorded LSC ticket ID for its final outcome.'; end if;
   if coalesce(p_details->>'tt_url','')<>'' and (p_details->>'tt_url' !~ '^https://' or length(p_details->>'tt_url')>2000) then raise exception 'Use an HTTPS ticket link.'; end if;
   w.tt_reference:=trim(p_details->>'tt_reference'); w.tt_url:=nullif(p_details->>'tt_url','');
   if p_action='tracking' then
    w.workflow_status:='with_vendor'; w.followup_status:='with_vendor'; w.followup_on:=(p_details->>'followup_on')::date;
    if w.followup_on is null then raise exception 'Set the next follow-up date.'; end if;
   else
    w.workflow_status:=p_action; w.followup_status:=p_action; w.enabled:=false; w.followup_on:=null; w.recovery_month:=null;
    if p_action='lost' then
     -- A failed redispute joins the next payroll, never its historical loss month.
     target:=coalesce(nullif(p_details->>'recovery_month',''),to_char(date_trunc('month',now() at time zone 'Asia/Kolkata')+interval '1 month','YYYY-MM'));
     if target !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' or target<to_char(date_trunc('month',now() at time zone 'Asia/Kolkata')+interval '1 month','YYYY-MM') then raise exception 'Select an upcoming recovery payroll month.'; end if;
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
 
 -- Refresh every original allocation payroll, including open prior-month salaries.
 perform public.nl_recovery_bump_payout_months(p_company, array(
  select distinct payroll_month from (
   select r.deduction_month payroll_month from public.nl_loss_recoveries r
    where r.company_id=p_company and r.month=p_month and r.case_key=p_case and not r.is_deleted
   union all
   select coalesce(nullif(a->>'salary_month',''),r.deduction_month) from public.nl_loss_recoveries r
    cross join lateral jsonb_array_elements(r.allocations) a
    where r.company_id=p_company and r.month=p_month and r.case_key=p_case and not r.is_deleted
   union all select before_state->>'recovery_month'
   union all select w.recovery_month
  ) months where payroll_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
 ));
 return to_jsonb(w);
end $function$;

REVOKE ALL ON FUNCTION public.nl_redispute_transition(uuid,text,text,integer,text,jsonb,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.nl_redispute_transition(uuid,text,text,integer,text,jsonb,uuid,text) TO service_role;
