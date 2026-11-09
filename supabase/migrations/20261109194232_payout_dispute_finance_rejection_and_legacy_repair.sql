-- Finance can explicitly reject a dispute. Approved corrections continue to
-- use the existing source-application queue; no published payout is edited.
create or replace function public.workforce_dispute_transition_v3(p_company uuid, p_dispute uuid, p_actor uuid, p_actor_name text, p_actor_role_ids uuid[], p_action text, p_expected_version integer, p_locations uuid[], p_payload jsonb)
 returns public.workforce_payout_disputes
 language plpgsql
 set search_path to ''
as $function$
declare d public.workforce_payout_disputes; saved public.workforce_payout_disputes; source jsonb; revised jsonb; item jsonb; expected numeric; actual numeric; stage text; role_id uuid; note text:=trim(p_payload->>'note'); plan jsonb;
begin
  select * into d from public.workforce_payout_disputes where id=p_dispute and company_id=p_company for update;
  if not found or (p_locations is not null and not(d.station_id=any(p_locations))) then raise exception 'Dispute is outside your scope.'; end if;
  if p_expected_version is null or d.version<>p_expected_version then raise exception 'This request changed. Refresh before continuing.'; end if;

  if p_action='reject_final' then
    if d.status not in ('in_review','pending_final_approval') then raise exception 'This request is not waiting for final review.'; end if;
    select r.role_id into role_id from public.workforce_payout_dispute_route_roles(p_company,jsonb_build_array(jsonb_build_object('dispute_id',d.id,'stage','final'))) r;
    if p_actor is null or (not coalesce(role_id=any(p_actor_role_ids),false) and not public.workforce_dispute_manager_can_review(p_company,p_actor,p_actor_role_ids,d.station_id)) then raise exception 'Only the configured final reviewer can reject this dispute.'; end if;
    if p_actor=coalesce(d.initial_reviewed_by,d.proposed_by) then raise exception 'A different final reviewer must decide.'; end if;
    if length(coalesce(note,'')) not between 10 and 1000 then raise exception 'Give a clear rejection reason of at least 10 characters.'; end if;
    update public.workforce_payout_disputes set status='rejected',resolution=note,resolved_by=p_actor,resolved_at=now(),
      final_approved_by=p_actor,final_approved_by_name=p_actor_name,final_approved_at=now(),approved_by_name=p_actor_name,
      processor_id=null,processor_name=null,processor_claimed_at=null,processing_note=null,processing_result=null,processed_publication_id=null,processed_at=null,
      version=version+1,updated_at=now() where id=d.id returning * into saved;
    insert into public.workforce_payout_dispute_events(company_id,dispute_id,actor_id,actor_name,portal,message,event_type,from_status,to_status,metadata,dispute_version)
    values(p_company,d.id,p_actor,p_actor_name,'ops',note,'reject_final',d.status,'rejected',jsonb_build_object('proposed_decision',d.proposed_decision),saved.version);
    return saved;
  end if;

  if p_action='return_review' and exists(select 1 from public.workforce_dispute_application_jobs j where j.dispute_id=d.id and j.applied_at is not null) then raise exception 'Source correction is already applied. Use processing to verify the revised payout.'; end if;
  if p_action in ('request_clarification','return_review') then
    stage:=case when d.status='open' then 'initial' when d.status in ('in_review','pending_final_approval') then 'final' when d.status in ('approved_for_processing','processing','processing_blocked') then 'processor' end;
    if stage is null or (p_action='request_clarification' and stage<>'initial') then raise exception 'This request is not at the required review stage.'; end if;
    select r.role_id into role_id from public.workforce_payout_dispute_route_roles(p_company,jsonb_build_array(jsonb_build_object('dispute_id',d.id,'stage',stage))) r;
    if p_actor is null or (not coalesce(role_id=any(p_actor_role_ids),false) and not (stage in ('initial','final') and public.workforce_dispute_manager_can_review(p_company,p_actor,p_actor_role_ids,d.station_id))) then raise exception 'Only the configured reviewer can act.'; end if;
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
  if p_action='approve_final' and saved.status='approved_for_processing' then
    perform public.workforce_queue_dispute_application(p_company,saved.id,p_payload->'loss_balance');
    select * into saved from public.workforce_payout_disputes where id=saved.id;
  end if;
  if p_action='claim_processing' then perform public.workforce_pause_dispute_application(p_company,d.id,'Claimed by the independent payout processor.'); end if;
  return saved;
end
$function$;

revoke all on function public.workforce_dispute_transition_v3(uuid,uuid,uuid,text,uuid[],text,integer,uuid[],jsonb) from public,anon,authenticated;
grant execute on function public.workforce_dispute_transition_v3(uuid,uuid,uuid,text,uuid[],text,integer,uuid[],jsonb) to service_role;

-- Older free-form correction proposals do not identify the exact source row.
-- Return only those unresolved correction cases for guided validation instead
-- of silently changing a published snapshot or manufacturing a payroll row.
do $repair$
declare item public.workforce_payout_disputes; new_version integer;
begin
  for item in
    select d.* from public.workforce_payout_disputes d
    where d.status in ('pending_final_approval','approved_for_processing')
      and d.proposed_decision='resolved'
      and coalesce(d.correction_plan->>'schema','')<>'3'
      and not exists(select 1 from public.workforce_dispute_application_jobs j where j.dispute_id=d.id)
    for update
  loop
    new_version:=item.version+1;
    update public.workforce_payout_disputes set
      status='open',
      details=coalesce(details,'{}'::jsonb)||jsonb_build_object(
        'awaiting_reply',false,
        'legacy_recalculation_required',true,
        'legacy_approved_plan',item.correction_plan,
        'legacy_final_approver',jsonb_build_object('id',item.final_approved_by,'name',item.final_approved_by_name,'at',item.final_approved_at),
        'legacy_repair_reason','Exact payout item, source selector and verified net effect are required before approval.'
      ),
      proposed_decision=null,proposed_note=null,proposed_by=null,proposed_by_name=null,proposed_at=null,correction_plan=null,
      initial_reviewed_by=null,initial_reviewed_by_name=null,initial_reviewed_at=null,
      final_approved_by=null,final_approved_by_name=null,final_approved_at=null,approved_by_name=null,
      resolution=null,resolved_by=null,resolved_at=null,legacy_resolution_unverified=false,
      processor_id=null,processor_name=null,processor_claimed_at=null,processing_note=null,processing_result=null,processed_publication_id=null,processed_at=null,
      version=new_version,updated_at=now()
    where id=item.id and version=item.version;
    insert into public.workforce_payout_dispute_events(company_id,dispute_id,actor_id,actor_name,portal,message,event_type,from_status,to_status,metadata,dispute_version)
    values(item.company_id,item.id,null,'System','ops',
      'Returned for guided recalculation. Prior review is preserved; no payout was changed.',
      'legacy_approval_returned',item.status,'open',
      jsonb_build_object('previous_plan',item.correction_plan,'previous_final_approver',item.final_approved_by_name,'previous_final_approved_at',item.final_approved_at),new_version);
  end loop;
end
$repair$;
