begin;
-- Extend the existing service-only, versioned writer. Preserve its payroll gates,
-- source-change revocation guard and append-only before/after history.
do $$
declare d text; original text;
begin
 select pg_get_functiondef('public.nl_redispute_transition(uuid,text,text,integer,text,jsonb,uuid,text)'::regprocedure) into strict d;
 if position('-- Manual Amazon ticket lifecycle' in d) = 0 then
  original := d;
  d := replace(d,
   'w.reviewed_by:=p_actor; w.workflow_status:=case p_action when ''approve'' then ''approved'' else ''returned'' end;',
   $patch$w.reviewed_by:=p_actor; w.workflow_status:=case p_action when 'approve' then 'approved' else 'returned' end;
   -- Manual Amazon ticket lifecycle: station Cloak ID stays in response_details.
   if p_action='approve' then w.tt_reference:=null; w.tt_url:=null; w.followup_on:=null; w.followup_status:='preparing'; end if;$patch$);
  if d=original then raise exception 'Redispute review guard changed; inspect before applying.'; end if;
  original := d;
  d := replace(d,
   'if length(trim(coalesce(p_details->>''tt_reference'','''')))<3 then raise exception ''Enter the post-dispute ticket reference.''; end if;',
   $patch$if p_action in ('won','lost') and w.workflow_status<>'with_vendor' then raise exception 'Record the Amazon ticket before its final outcome.'; end if;
   if length(trim(coalesce(p_details->>'tt_reference','')))<3 or length(trim(coalesce(p_details->>'tt_reference','')))>160 then raise exception 'Enter the Amazon ticket ID (3–160 characters).'; end if;$patch$);
  if d=original then raise exception 'Redispute ticket guard changed; inspect before applying.'; end if;
  original := d;
  d := replace(d,
   'w.workflow_status:=''with_vendor''; w.followup_status:=''with_vendor''; w.followup_on:=(p_details->>''followup_on'')::date;',
   $patch$w.followup_status:=coalesce(p_details->>'followup_status','with_vendor');
    if w.followup_status not in ('filed','with_vendor') then raise exception 'Choose Ticket raised or Awaiting response from Amazon.'; end if;
    w.workflow_status:='with_vendor'; w.followup_on:=(p_details->>'followup_on')::date;$patch$);
  if d=original then raise exception 'Redispute follow-up guard changed; inspect before applying.'; end if;
  execute d;
 end if;
end $$;
revoke all on function public.nl_redispute_transition(uuid,text,text,integer,text,jsonb,uuid,text) from public,anon,authenticated;
grant execute on function public.nl_redispute_transition(uuid,text,text,integer,text,jsonb,uuid,text) to service_role;
commit;
