-- Publication deadlines are fixed when published; settings affect new publications only.
alter table public.workforce_payout_dispute_workflows
  add column if not exists review_window_days integer not null default 2;
alter table public.workforce_payout_dispute_workflows
  drop constraint if exists workforce_dispute_review_window_check;
alter table public.workforce_payout_dispute_workflows
  add constraint workforce_dispute_review_window_check check (review_window_days between 1 and 30);

create or replace function public.workforce_upsert_dispute_workflow_v2(
 p_company uuid, p_station uuid, p_initial_role_ids uuid[], p_final_role_ids uuid[],
 p_processor_role_ids uuid[], p_actor uuid, p_expected_version integer,
 p_is_active boolean, p_review_window_days integer
) returns public.workforce_payout_dispute_workflows
language plpgsql set search_path = '' as $$
declare saved public.workforce_payout_dispute_workflows;
begin
 if p_review_window_days is null or p_review_window_days not between 1 and 30 then
   raise exception 'Dispute window must be between 1 and 30 days.';
 end if;
 saved := public.workforce_upsert_dispute_workflow(p_company,p_station,p_initial_role_ids,
   p_final_role_ids,p_processor_role_ids,p_actor,p_expected_version,p_is_active);
 -- A single company deadline policy; station overrides only change review routing.
 if p_station is null then
   update public.workforce_payout_dispute_workflows set review_window_days=p_review_window_days
   where id=saved.id returning * into saved;
 end if;
 return saved;
end $$;
revoke all on function public.workforce_upsert_dispute_workflow_v2(uuid,uuid,uuid[],uuid[],uuid[],uuid,integer,boolean,integer) from public,anon,authenticated;
grant execute on function public.workforce_upsert_dispute_workflow_v2(uuid,uuid,uuid[],uuid[],uuid[],uuid,integer,boolean,integer) to service_role;

CREATE OR REPLACE FUNCTION public.workforce_raise_payout_dispute(p_company uuid, p_workforce uuid, p_publication uuid, p_category text, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  pub public.workforce_payout_publications;
  run public.workforce_payroll_runs;
  dispute_id uuid;
begin
  if p_category not in ('counts','training','loss','tds','other') or p_category is null then
    raise exception 'Select a valid dispute category';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 10 or length(btrim(p_reason)) > 2000 then
    raise exception 'Enter between 10 and 2000 characters';
  end if;
  perform 1
  from public.workforce workforce
  where workforce.company_id = p_company and workforce.id = p_workforce
  for update;

  select * into pub
  from public.workforce_payout_publications
  where id = p_publication
    and company_id = p_company
    and workforce_id = p_workforce;
  if not found then raise exception 'Payout is not available for this associate'; end if;

  if pub.publication_kind = 'worksheet' then
    if exists (
      select 1 from public.workforce_payout_publications newer
      where newer.company_id = pub.company_id
        and newer.workforce_id = pub.workforce_id
        and newer.publication_kind = 'worksheet'
        and newer.period_start = pub.period_start
        and newer.period_end = pub.period_end
        and newer.station_id = pub.station_id
        and newer.revision > pub.revision
    ) then
      raise exception 'Open the latest payout version before raising a dispute';
    end if;
  else
    select * into run
    from public.workforce_payroll_runs
    where id = pub.payroll_run_id and company_id = p_company
    for update;
    if run.status not in ('draft', 'review') then
      raise exception 'This payout is already confirmed. Contact support for a correction in the next open period';
    end if;
    if exists (
      select 1 from public.workforce_payout_publications newer
      where newer.payroll_run_id = pub.payroll_run_id
        and newer.workforce_id = p_workforce
        and newer.revision > pub.revision
    ) then
      raise exception 'Open the latest payout version before raising a dispute';
    end if;
  end if;

  if pub.review_until is null or pub.review_until <= now() then
    raise exception 'The review window for this payout has ended';
  end if;
  if exists (
    select 1
    from public.workforce_payout_disputes dispute
    join public.workforce_payout_publications disputed_publication
      on disputed_publication.id = dispute.publication_id
    where dispute.category = p_category
      and dispute.status in ('open', 'in_review', 'pending_final_approval', 'approved_for_processing', 'processing', 'processing_blocked')
      and (
        (pub.publication_kind = 'worksheet'
          and disputed_publication.company_id = pub.company_id
          and disputed_publication.workforce_id = pub.workforce_id
          and disputed_publication.publication_kind = 'worksheet'
          and disputed_publication.station_id = pub.station_id
          and disputed_publication.period_start = pub.period_start
          and disputed_publication.period_end = pub.period_end)
        or (pub.publication_kind <> 'worksheet' and dispute.publication_id = p_publication)
      )
  ) then
    raise exception 'An open dispute already exists for this category. Add a reply to it';
  end if;

  insert into public.workforce_payout_disputes (
    company_id, publication_id, payroll_run_id, workforce_id,
    station_id, category, reason
  ) values (
    p_company, p_publication, pub.payroll_run_id, p_workforce,
    pub.station_id, p_category, btrim(p_reason)
  ) returning id into dispute_id;

  insert into public.workforce_payout_dispute_events (
    company_id, dispute_id, actor_name, portal, message
  ) values (
    p_company, dispute_id,
    coalesce(pub.snapshot -> 'item' ->> 'worker_name', 'Associate'),
    'one', btrim(p_reason)
  );
  return dispute_id;
end
$function$


