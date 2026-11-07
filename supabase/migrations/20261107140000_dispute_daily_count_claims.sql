-- Keep production count/rate requests for an overlapping day in one review.
-- Existing decisions and event history are unchanged.
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
  if exists(select 1 from jsonb_array_elements_text(p_details->'dates') dt where dt!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or dt<coalesce(pub.period_start,(pub.snapshot#>>'{run,period_start}')::date)::text or dt>coalesce(pub.period_end,(pub.snapshot#>>'{run,period_end}')::date)::text) then raise exception 'Dates must be within this payout period.'; end if;
  if issue not in ('deduction','allowance') and jsonb_array_length(p_details->'dates') not between 1 and 31 then raise exception 'Select affected dates.'; end if;
  if p_details ? 'counts' then
    if issue <> 'production' or jsonb_typeof(p_details->'counts') is distinct from 'array' then raise exception 'Daily counts must be a production request.'; end if;
    if jsonb_array_length(p_details->'counts') not between 1 and 124 then raise exception 'Select the affected daily counts.'; end if;
    if exists(select 1 from jsonb_array_elements(p_details->'counts') c
      where coalesce(c->>'component','')='' or not (p_details->'dates' ? (c->>'date'))
        or coalesce(c->>'value','') !~ '^[0-9]+$' or length(c->>'value')>8)
      or exists(select 1 from jsonb_array_elements(p_details->'counts') c group by c->>'date',c->>'component' having count(*)>1)
      or exists(select 1 from jsonb_array_elements_text(p_details->'dates') dt
        where not exists(select 1 from jsonb_array_elements(p_details->'counts') c where c->>'date'=dt))
    then raise exception 'Enter one valid count per selected item and date.'; end if;
  end if;
  if exists(
    select 1 from public.workforce_payout_disputes d join public.workforce_payout_publications p on p.id=d.publication_id
    where d.company_id=p_company and d.workforce_id=p_workforce and d.station_id=pub.station_id
      and coalesce(p.period_start,(p.snapshot#>>'{run,period_start}')::date)=coalesce(pub.period_start,(pub.snapshot#>>'{run,period_start}')::date)
      and coalesce(p.period_end,(p.snapshot#>>'{run,period_end}')::date)=coalesce(pub.period_end,(pub.snapshot#>>'{run,period_end}')::date)
      and d.status in ('open','in_review','pending_final_approval','approved_for_processing','processing','processing_blocked')
      and ((coalesce(d.details->>'schema','')<>'3' and d.category=p_category)
        or ((d.details->>'component'=p_details->>'component' or (d.details->>'issue'='production' and issue='production') or (d.details->>'issue' in ('attendance','salary') and issue in ('attendance','salary')))
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

