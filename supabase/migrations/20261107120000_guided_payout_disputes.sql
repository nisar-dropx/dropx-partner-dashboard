begin;
alter table public.workforce_payout_disputes add column if not exists details jsonb not null default '{}'::jsonb;
drop index if exists public.workforce_payout_disputes_open_category_uidx;
create unique index workforce_payout_disputes_open_category_uidx on public.workforce_payout_disputes(publication_id,category)
where status in ('open','in_review','pending_final_approval','approved_for_processing','processing','processing_blocked') and coalesce(details->>'schema','')<>'3';

create or replace function public.workforce_dispute_snapshot_value(p_snapshot jsonb, p_item jsonb)
returns numeric language plpgsql immutable set search_path='' as $$
declare result numeric; n integer; selector text := p_item->>'selector';
begin
  if selector='deduction' then
    select sum((d->>'amount')::numeric),count(*) into result,n
    from jsonb_array_elements(coalesce(p_snapshot#>'{worksheet,deduction_breakdown}','[]')) d
    where d->>'code'=p_item->>'code' and (nullif(p_item->>'recovery_key','') is null or d->>'recoveryKey'=p_item->>'recovery_key');
  elsif selector in ('addition','incentive') then
    select sum(case when selector='addition' then (l->>'adjustment_amount')::numeric else (l->>'incentive_amount')::numeric end),count(*) into result,n
    from jsonb_array_elements(coalesce(p_snapshot->'lines','[]')) l
    where l->>'source_type'=case when selector='addition' then 'additional_payment' else 'incentive' end and l#>>'{calculation_snapshot,category}'=p_item->>'code';
  elsif selector='attendance' then
    select sum((l#>>'{calculation_snapshot,workDayUnits}')::numeric),count(*) into result,n
    from jsonb_array_elements(coalesce(p_snapshot->'lines','[]')) l
    where l->>'work_date'=p_item->>'date' and l#>>'{calculation_snapshot,workDayUnits}' is not null;
  elsif selector in ('count','rate','amount') then
    select case when selector='rate' then min((v->>selector)::numeric) else sum((v->>selector)::numeric) end,count(*) into result,n
    from jsonb_array_elements(coalesce(p_snapshot->'lines','[]')) l
    cross join lateral jsonb_array_elements(coalesce(l#>'{calculation_snapshot,paymentLines}','[]')) v
    where l->>'work_date'=p_item->>'date' and v->>'code'=p_item->>'code';
    if selector='rate' and exists(
      select 1 from jsonb_array_elements(coalesce(p_snapshot->'lines','[]')) l
      cross join lateral jsonb_array_elements(coalesce(l#>'{calculation_snapshot,paymentLines}','[]')) v
      where l->>'work_date'=p_item->>'date' and v->>'code'=p_item->>'code' and (v->>'rate')::numeric<>result
    ) then return null; end if;
  else return null;
  end if;
  if n=0 then return null; end if;
  return round(result,2);
end $$;
revoke all on function public.workforce_dispute_snapshot_value(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.workforce_dispute_snapshot_value(jsonb,jsonb) to service_role;

create or replace function public.workforce_raise_guided_payout_dispute(p_company uuid,p_workforce uuid,p_publication uuid,p_category text,p_reason text,p_details jsonb)
returns uuid language plpgsql set search_path='' as $$
declare pub public.workforce_payout_publications; run public.workforce_payroll_runs; result uuid; issue text:=p_details->>'issue';
begin
  if p_category not in ('counts','training','loss','tds','other') or length(trim(p_reason)) not between 10 and 2000 or p_reason is null then raise exception 'Choose an issue and describe the affected item.'; end if;
  if coalesce(p_details->>'schema','')<>'3' or coalesce(issue,'') not in ('attendance','deduction','fuel','production','salary','allowance') or coalesce(p_details->>'component','')='' or coalesce(jsonb_typeof(p_details->'dates'),'')<>'array' or length(p_details::text)>20000 then raise exception 'Select the affected payment item and dates.'; end if;
  perform 1 from public.workforce where id=p_workforce and company_id=p_company for update;
  if not found then raise exception 'Associate unavailable.'; end if;
  select * into pub from public.workforce_payout_publications where id=p_publication and company_id=p_company and workforce_id=p_workforce;
  if not found or pub.review_until is null or pub.review_until<=now() then raise exception 'This payout review window has ended. Existing requests can still be tracked.'; end if;
  if pub.publication_kind is distinct from 'worksheet' then
    select * into run from public.workforce_payroll_runs where id=pub.payroll_run_id and company_id=p_company for update;
    if not found or run.status is distinct from 'review' or run.calculated_at is distinct from pub.source_calculated_at then raise exception 'This payroll is not open for review or needs republication.'; end if;
  end if;
  if exists(select 1 from public.workforce_payout_publications p where p.company_id=p_company and p.workforce_id=p_workforce and p.station_id=pub.station_id and p.period_start=pub.period_start and p.period_end=pub.period_end and p.revision>pub.revision) then raise exception 'A newer payout is available. Refresh before submitting.'; end if;
  if exists(select 1 from jsonb_array_elements_text(p_details->'dates') dt where dt!~'^\d{4}-\d{2}-\d{2}$' or dt<coalesce(pub.period_start,(pub.snapshot#>>'{run,period_start}')::date)::text or dt>coalesce(pub.period_end,(pub.snapshot#>>'{run,period_end}')::date)::text) then raise exception 'Dates must be within this payout period.'; end if;
  if issue not in ('deduction','allowance') and jsonb_array_length(p_details->'dates') not between 1 and 31 then raise exception 'Select affected dates.'; end if;
  if exists(
    select 1 from public.workforce_payout_disputes d join public.workforce_payout_publications p on p.id=d.publication_id
    where d.company_id=p_company and d.workforce_id=p_workforce and d.station_id=pub.station_id
      and coalesce(p.period_start,(p.snapshot#>>'{run,period_start}')::date)=coalesce(pub.period_start,(pub.snapshot#>>'{run,period_start}')::date)
      and coalesce(p.period_end,(p.snapshot#>>'{run,period_end}')::date)=coalesce(pub.period_end,(pub.snapshot#>>'{run,period_end}')::date)
      and d.status in ('open','in_review','pending_final_approval','approved_for_processing','processing','processing_blocked')
      and ((coalesce(d.details->>'schema','')<>'3' and d.category=p_category)
        or ((d.details->>'component'=p_details->>'component' or (d.details->>'issue' in ('attendance','salary') and issue in ('attendance','salary')))
          and (issue in ('deduction','allowance') or exists(select 1 from jsonb_array_elements_text(d.details->'dates') x join jsonb_array_elements_text(p_details->'dates') y on x=y))))
  ) then raise exception 'A request already covers this item. Open Dispute history to track it or reply.'; end if;
  insert into public.workforce_payout_disputes(company_id,publication_id,payroll_run_id,workforce_id,station_id,category,reason,details)
  values(p_company,p_publication,pub.payroll_run_id,p_workforce,pub.station_id,p_category,p_reason,p_details) returning id into result;
  insert into public.workforce_payout_dispute_events(company_id,dispute_id,actor_name,portal,message)
  values(p_company,result,coalesce(pub.snapshot#>>'{item,worker_name}','Associate'),'one',p_reason);
  return result;
end $$;
revoke all on function public.workforce_raise_guided_payout_dispute(uuid,uuid,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.workforce_raise_guided_payout_dispute(uuid,uuid,uuid,text,text,jsonb) to service_role;

create or replace function public.workforce_dispute_transition_v3(p_company uuid,p_dispute uuid,p_actor uuid,p_actor_name text,p_actor_role_ids uuid[],p_action text,p_expected_version integer,p_locations uuid[],p_payload jsonb)
returns public.workforce_payout_disputes language plpgsql set search_path='' as $$
declare d public.workforce_payout_disputes; saved public.workforce_payout_disputes; source jsonb; revised jsonb; item jsonb; expected numeric; actual numeric; stage text; role_id uuid; note text:=trim(p_payload->>'note'); plan jsonb;
begin
  select * into d from public.workforce_payout_disputes where id=p_dispute and company_id=p_company for update;
  if not found or (p_locations is not null and not(d.station_id=any(p_locations))) then raise exception 'Dispute is outside your scope.'; end if;
  if p_expected_version is null or d.version<>p_expected_version then raise exception 'This request changed. Refresh before continuing.'; end if;
  if p_action in ('request_clarification','return_review') then
    stage:=case when d.status='open' then 'initial' when d.status in ('in_review','pending_final_approval') then 'final' when d.status in ('approved_for_processing','processing','processing_blocked') then 'processor' end;
    if stage is null or (p_action='request_clarification' and stage<>'initial') then raise exception 'This request is not at the required review stage.'; end if;
    select r.role_id into role_id from public.workforce_payout_dispute_route_roles(p_company,jsonb_build_array(jsonb_build_object('dispute_id',d.id,'stage',stage))) r;
    if p_actor is null or role_id is null or not coalesce(role_id=any(p_actor_role_ids),false) then raise exception 'Only the configured reviewer can act.'; end if;
    if stage='final' and p_actor=coalesce(d.initial_reviewed_by,d.proposed_by) then raise exception 'A different final reviewer must act.'; end if;
    if stage='processor' and (p_actor in (d.initial_reviewed_by,d.final_approved_by) or (d.status='processing' and d.processor_id is distinct from p_actor)) then raise exception 'Only the independent assigned processor can return this request.'; end if;
    if length(coalesce(note,'')) not between 5 and 1000 then raise exception 'Write a short explanation.'; end if;
    update public.workforce_payout_disputes set status='open',details=details||jsonb_build_object('awaiting_reply',p_action='request_clarification','question',note),
      proposed_decision=null,proposed_note=null,proposed_by=null,proposed_by_name=null,proposed_at=null,correction_plan=null,
      initial_reviewed_by=null,initial_reviewed_by_name=null,initial_reviewed_at=null,final_approved_by=null,final_approved_by_name=null,final_approved_at=null,
      processor_id=null,processor_name=null,processor_claimed_at=null,version=version+1,updated_at=now() where id=d.id returning * into saved;
    insert into public.workforce_payout_dispute_events(company_id,dispute_id,actor_id,actor_name,portal,message,event_type,from_status,to_status,dispute_version)
    values(p_company,d.id,p_actor,p_actor_name,'ops',note,p_action,d.status,'open',saved.version);
    return saved;
  end if;
  if p_action='propose_correction' then
    if d.details->>'awaiting_reply'='true' then raise exception 'Wait for the associate to reply before proposing a correction.'; end if;
    plan:=p_payload->'correction_plan';
    if coalesce(plan->>'schema','')<>'3' or jsonb_array_length(coalesce(plan->'items','[]'))=0 then raise exception 'Open guided review and validate the affected items first.'; end if;
  end if;
  if p_action in ('approve_final','complete_processing') and d.proposed_decision='resolved' and coalesce(d.correction_plan->>'schema','')<>'3' then raise exception 'This older proposal needs guided recalculation. Return it for review; previous approvals remain in history.'; end if;
  if p_action='complete_processing' then
    select snapshot into source from public.workforce_payout_publications where id=d.publication_id and company_id=p_company;
    select snapshot into revised from public.workforce_payout_publications where id=(p_payload->>'processed_publication_id')::uuid and company_id=p_company;
    for item in select value from jsonb_array_elements(d.correction_plan->'items') loop
      expected:=(item->>'proposed_value')::numeric;
      actual:=public.workforce_dispute_snapshot_value(revised,item);
      -- Removing a known deduction/addition is represented by no line in the revised payout.
      if actual is null and expected=0 and item->>'selector' in ('deduction','addition','incentive') then actual:=0; end if;
      if actual is null or abs(actual-expected)>0.005 then raise exception 'The revised payout does not contain the approved correction for %. Correct that source item and republish.',item->>'target_field'; end if;
      actual:=public.workforce_dispute_snapshot_value(source,item);
      if actual is null or abs(actual-(item->>'current_value')::numeric)>0.005 then raise exception 'The approved baseline does not match the disputed source item.'; end if;
    end loop;
  end if;
  saved:=public.workforce_dispute_transition_v2(p_company,p_dispute,p_actor,p_actor_name,p_actor_role_ids,p_action,p_expected_version,p_locations,p_payload);
  if p_action='propose_correction' then
    update public.workforce_payout_disputes set details=details||(p_payload#>'{correction_plan,claim}') where id=d.id returning * into saved;
  end if;
  return saved;
end $$;
revoke all on function public.workforce_dispute_transition_v3(uuid,uuid,uuid,text,uuid[],text,integer,uuid[],jsonb) from public,anon,authenticated;
grant execute on function public.workforce_dispute_transition_v3(uuid,uuid,uuid,text,uuid[],text,integer,uuid[],jsonb) to service_role;

create or replace function public.workforce_reply_guided_dispute(p_company uuid,p_workforce uuid,p_dispute uuid,p_version integer,p_message text)
returns void language plpgsql set search_path='' as $$
declare d public.workforce_payout_disputes;
begin
  select * into d from public.workforce_payout_disputes where id=p_dispute and company_id=p_company and workforce_id=p_workforce for update;
  if not found or p_version is null or d.version<>p_version then raise exception 'This request changed. Refresh to see its latest status.'; end if;
  if d.status<>'open' or d.details->>'awaiting_reply' is distinct from 'true' then raise exception 'This request is not waiting for a reply.'; end if;
  if length(trim(p_message)) not between 3 and 1000 then raise exception 'Add a short reply (3–1000 characters).'; end if;
  update public.workforce_payout_disputes set details=details||jsonb_build_object('awaiting_reply',false,'reply',trim(p_message)),version=version+1,updated_at=now() where id=d.id;
  insert into public.workforce_payout_dispute_events(company_id,dispute_id,actor_name,portal,message,event_type,from_status,to_status,dispute_version)
  values(p_company,d.id,'Associate','one',trim(p_message),'associate_reply','open','open',d.version+1);
end $$;
revoke all on function public.workforce_reply_guided_dispute(uuid,uuid,uuid,integer,text) from public,anon,authenticated;
grant execute on function public.workforce_reply_guided_dispute(uuid,uuid,uuid,integer,text) to service_role;
commit;
