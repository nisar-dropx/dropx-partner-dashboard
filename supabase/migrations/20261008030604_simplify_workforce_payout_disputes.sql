create or replace function public.workforce_decide_payout_dispute(
  p_company uuid,
  p_dispute uuid,
  p_actor uuid,
  p_actor_name text,
  p_decision text,
  p_locations uuid[]
)
returns void
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  dispute public.workforce_payout_disputes;
  audit_message text;
begin
  select * into dispute
  from public.workforce_payout_disputes
  where id = p_dispute and company_id = p_company;

  if not found
    or p_actor is null
    or (p_locations is not null and not coalesce(dispute.station_id = any(p_locations), false))
  then
    raise exception 'Dispute is outside your scope';
  end if;
  if p_decision not in ('resolved', 'rejected') then
    raise exception 'Choose Resolve or Reject';
  end if;

  if dispute.payroll_run_id is not null then
    perform 1
    from public.workforce_payroll_runs
    where id = dispute.payroll_run_id
    for update;
  else
    perform 1
    from public.workforce_payout_publications
    where id = dispute.publication_id
    for update;
  end if;

  select * into dispute
  from public.workforce_payout_disputes
  where id = p_dispute and company_id = p_company
  for update;
  if not found
    or (p_locations is not null and not coalesce(dispute.station_id = any(p_locations), false))
  then
    raise exception 'Dispute is outside your scope';
  end if;
  if dispute.status not in ('open', 'in_review') then
    raise exception 'This dispute is already closed';
  end if;

  audit_message := case p_decision
    when 'resolved' then 'Dispute resolved in Dashboard.'
    else 'Dispute rejected in Dashboard.'
  end;

  update public.workforce_payout_disputes
  set status = p_decision,
      resolution = audit_message,
      resolved_by = p_actor,
      resolved_at = now(),
      updated_at = now()
  where id = dispute.id;

  insert into public.workforce_payout_dispute_events (
    company_id,
    dispute_id,
    actor_id,
    actor_name,
    portal,
    message
  ) values (
    p_company,
    dispute.id,
    p_actor,
    coalesce(nullif(btrim(p_actor_name), ''), 'Authorised reviewer'),
    'workforce',
    audit_message
  );
end
$function$;

comment on function public.workforce_decide_payout_dispute(uuid, uuid, uuid, text, text, uuid[]) is
  'Records an audit-safe terminal Resolve or Reject decision from the Dashboard payout-dispute desk.';

revoke all on function public.workforce_decide_payout_dispute(uuid, uuid, uuid, text, text, uuid[])
  from public, anon, authenticated;
grant execute on function public.workforce_decide_payout_dispute(uuid, uuid, uuid, text, text, uuid[])
  to service_role;

-- The temporary dispute workflow deliberately exposes only terminal Dashboard
-- decisions. Keep the legacy reply, in-review and correction RPCs unavailable
-- until the fuller workflow is reintroduced.
do $block$
begin
  if pg_catalog.to_regprocedure('public.workforce_reply_payout_dispute(uuid,uuid,uuid,text)') is not null then
    execute 'revoke execute on function public.workforce_reply_payout_dispute(uuid, uuid, uuid, text) from public, anon, authenticated, service_role';
  end if;
  if pg_catalog.to_regprocedure('public.workforce_update_payout_dispute(uuid,uuid,uuid,text,text,text,text,uuid,uuid[])') is not null then
    execute 'revoke execute on function public.workforce_update_payout_dispute(uuid, uuid, uuid, text, text, text, text, uuid, uuid[]) from public, anon, authenticated, service_role';
  end if;
  if pg_catalog.to_regprocedure('public.workforce_propose_payout_correction(uuid,uuid,uuid,uuid,text,uuid,text,jsonb,text,uuid,uuid[])') is not null then
    execute 'revoke execute on function public.workforce_propose_payout_correction(uuid, uuid, uuid, uuid, text, uuid, text, jsonb, text, uuid, uuid[]) from public, anon, authenticated, service_role';
  end if;
  if pg_catalog.to_regprocedure('public.workforce_review_payout_correction(uuid,uuid,uuid,text,text,uuid[])') is not null then
    execute 'revoke execute on function public.workforce_review_payout_correction(uuid, uuid, uuid, text, text, uuid[]) from public, anon, authenticated, service_role';
  end if;
end
$block$;

notify pgrst, 'reload schema';
