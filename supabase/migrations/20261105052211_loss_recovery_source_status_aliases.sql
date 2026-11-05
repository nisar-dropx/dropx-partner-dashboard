-- Live/historic exports label the same recoverable SLA outcome eDSP, eDSP1 or eDSP2.
-- Preserve raw labels and all other outcome/amount checks.
create or replace function public.nl_recovery_source_status_key(p_status text)
returns text language sql immutable parallel safe
set search_path = ''
as $$
 select case when p_status in (
  'Recoverable - Missed SLA by eDSP',
  'Recoverable - Missed SLA by eDSP1',
  'Recoverable - Missed SLA by eDSP2'
 ) then 'Recoverable - Missed SLA by eDSP' else p_status end
$$;
revoke all on function public.nl_recovery_source_status_key(text) from public, anon;
grant execute on function public.nl_recovery_source_status_key(text) to authenticated, service_role;

CREATE OR REPLACE FUNCTION public.nl_loss_case_lifecycle_defaults()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if tg_op = 'INSERT' then
    if new.lifecycle_status is null or new.lifecycle_status = 'imported' then
      new.lifecycle_status := case
        when new.report = 'nl' and coalesce(new.data_source, 'live') = 'live'
          then 'station_dispute_or_clarification_window'
        when new.report = 'slp'
          and new.final_seen_at is null
          and not coalesce((new.details->>'in_final')::boolean, false)
          then 'imported'
        when public.nl_case_recoverable(new.company_id, new.report, new.source_status)
          then 'cluster_validation_pending'
        else 'not_recoverable'
      end;
    end if;
    new.lifecycle_updated_at := coalesce(new.lifecycle_updated_at, now());
    return new;
  end if;

  -- Source became non-recoverable before an approved plan: close the workflow.
  if not public.nl_case_recoverable(new.company_id, new.report, new.source_status)
     and old.lifecycle_status in (
       'imported','station_dispute_or_clarification_window','cluster_validation_pending',
       'returned_to_station','slp_final_confirmation_pending'
     ) then
    new.lifecycle_status := 'not_recoverable';
    new.lifecycle_version := old.lifecycle_version + 1;
    new.lifecycle_updated_at := now();
  end if;

  -- Source became recoverable again: reopen a closed not_recoverable case.
  -- Do not override an explicit UPDATE that already chose a new lifecycle.
  if public.nl_case_recoverable(new.company_id, new.report, new.source_status)
     and old.lifecycle_status = 'not_recoverable'
     and new.lifecycle_status = 'not_recoverable'
     and new.source_present then
    new.lifecycle_status := case
      when new.report = 'nl' and coalesce(new.data_source, 'live') = 'live'
        then 'station_dispute_or_clarification_window'
      when new.report = 'slp'
        and new.final_seen_at is null
        and not coalesce((new.details->>'in_final')::boolean, false)
        then 'imported'
      else 'cluster_validation_pending'
    end;
    new.lifecycle_version := old.lifecycle_version + 1;
    new.lifecycle_updated_at := now();
  end if;

  -- Amount/status drift after a locked plan → needs_review (payroll history stays).
  if old.lifecycle_status in ('recovery_approved_scheduled','recovery_in_progress','slp_final_confirmation_pending')
     and (
       round(coalesce(old.amount,0),2) is distinct from round(coalesce(new.amount,0),2)
       or (new.report <> 'slp' and public.nl_recovery_source_status_key(old.source_status) is distinct from public.nl_recovery_source_status_key(new.source_status))
     ) then
    new.lifecycle_status := 'needs_review';
    new.lifecycle_version := old.lifecycle_version + 1;
    new.lifecycle_updated_at := now();
  end if;

  if new.report = 'slp' and new.final_seen_at is null
     and coalesce((new.details->>'in_final')::boolean, false) then
    new.final_seen_at := now();
  end if;
  if tg_op = 'UPDATE' then
    new.final_seen_at := coalesce(old.final_seen_at, new.final_seen_at);
  end if;
  return new;
end $function$;
-- Lifecycle-only changes also affect payable recovery. Invalidate the existing cache;
-- do not alter published payroll, recovery keys or payment records.
CREATE OR REPLACE FUNCTION public.nl_case_bump_payout_months()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r record;
begin
 for r in
  select n.company_id, array_agg(distinct x.deduction_month) months
  from new_cases n join old_cases o on o.company_id=n.company_id and o.month=n.month and o.case_key=n.case_key
  join public.nl_loss_recoveries x on x.company_id=n.company_id and x.month=n.month and x.case_key=n.case_key and not x.is_deleted
  where (n.amount,n.source_status,n.source_present,n.final_seen_at,n.lifecycle_status) is distinct from (o.amount,o.source_status,o.source_present,o.final_seen_at,o.lifecycle_status)
   and exists(select 1 from jsonb_array_elements(x.allocations) a where a->>'ref' like 'workforce:%')
  group by n.company_id
 loop
  perform public.nl_recovery_bump_payout_months(r.company_id,r.months);
 end loop;
 return null;
end $function$;

-- One-time, evidence-backed repair of the 5 November import incident.
-- Restore only the last audited workflow state, never infer approval from allocations.
with candidates as materialized (
 select c.company_id,c.month,c.case_key,to_jsonb(c) before_case,
        e.id previous_event_id,e.to_status restore_status,to_jsonb(r) recovery_plan
 from public.nl_loss_month_cases c
 join public.nl_loss_recoveries r using(company_id,month,case_key)
 cross join lateral (
  select id,to_status,created_at from public.nl_loss_lifecycle_events e
  where e.company_id=c.company_id and e.month=c.month and e.case_key=c.case_key
  order by e.created_at desc,e.id desc limit 1
 ) e
 where c.report='nl' and c.lifecycle_status='needs_review'
  and c.lifecycle_updated_at='2026-11-04 19:21:13.639181+00'::timestamptz
  and c.source_present and not r.is_deleted
  and r.updated_at<=c.lifecycle_updated_at and e.created_at<c.lifecycle_updated_at
  and round(c.amount,2)=round(r.source_amount,2)
  and r.source_status='Recoverable - Missed SLA by eDSP'
  and c.source_status in ('Recoverable - Missed SLA by eDSP1','Recoverable - Missed SLA by eDSP2')
  and public.nl_case_recoverable(c.company_id,c.report,c.source_status)
  and (
   (r.approval_status='approved' and e.to_status in ('recovery_approved_scheduled','recovery_in_progress'))
   or (r.approval_status='proposed' and e.to_status='slp_final_confirmation_pending')
  )
  and exists (
   select 1 from public.nl_loss_source_events s
   where s.company_id=c.company_id and s.month=c.month and s.case_key=c.case_key
    and s.created_at=c.lifecycle_updated_at
    and s.before_value->>'source_status'=r.source_status
    and s.after_value->>'source_status'=c.source_status
    and (s.before_value->>'amount')::numeric=c.amount
    and (s.after_value->>'amount')::numeric=c.amount
  )
), repaired as (
 update public.nl_loss_month_cases c
 set lifecycle_status=x.restore_status,
     lifecycle_version=c.lifecycle_version+1,
     lifecycle_note='Restored prior audited state after equivalent eDSP source-label refresh.',
     lifecycle_updated_by=null,
     lifecycle_updated_by_name='Recovery source-label repair',
     lifecycle_updated_at=now()
 from candidates x
 where c.company_id=x.company_id and c.month=x.month and c.case_key=x.case_key
 returning c.company_id,c.month,c.case_key,to_jsonb(c) after_case
)
insert into public.nl_loss_lifecycle_events(
 company_id,month,case_key,action,from_status,to_status,note,actor_name,snapshot
)
select x.company_id,x.month,x.case_key,'restore_source_label_alias','needs_review',
 x.restore_status,'Equivalent eDSP label only; amount, assignments, approval and payroll keys unchanged.',
 'Recovery source-label repair',
 jsonb_build_object('previous_event_id',x.previous_event_id,'before_case',x.before_case,
                    'after_case',r.after_case,'recovery_plan',x.recovery_plan)
from repaired r join candidates x using(company_id,month,case_key);
