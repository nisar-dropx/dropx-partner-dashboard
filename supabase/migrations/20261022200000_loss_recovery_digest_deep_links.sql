-- Fix digest deep links: Losses tabs are slp-initial / slp-final, not /slp.
-- Safe to re-apply.

create or replace function public.nl_loss_recovery_action_items(p_company uuid)
returns table(
  station_code text, month text, case_key text, report text, amount numeric,
  lifecycle_status text, action_key text, action_label text, owner_role text,
  age_days int, due_month text, blocker text, deep_link text
) language sql stable security invoker set search_path=public as $$
 select c.station_code, c.month, c.case_key, c.report, c.amount, c.lifecycle_status,
  v.action_key, v.action_label, v.owner_role,
  greatest(0, (timezone('Asia/Kolkata', now()))::date
    - coalesce(c.lifecycle_updated_at, c.last_seen_at, c.source_updated_at)::date) age_days,
  r.deduction_month,
  case
    when c.lifecycle_status = 'needs_review' then coalesce(nullif(c.lifecycle_note,''),'Needs review')
    when c.lifecycle_status = 'exit_balance' then 'Exit balance outstanding'
    when c.report = 'slp' and c.final_seen_at is null then 'Awaiting SLP Final'
    else null
  end blocker,
  '/team-ops/losses/'
    || case
         when c.report = 'slp' and c.final_seen_at is null then 'slp-initial'
         when c.report = 'slp' then 'slp-final'
         else 'nl'
       end
    || '?month=' || c.month
    || '&station=' || c.station_code
    || '&case=' || replace(replace(replace(c.case_key, '%', '%25'), '|', '%7C'), ':', '%3A')
 from nl_loss_month_cases c
 left join nl_loss_recoveries r
   on r.company_id=c.company_id and r.month=c.month and r.case_key=c.case_key and not r.is_deleted
 cross join lateral (
  select * from (values
   ('station_dispute_or_clarification_window','station_clarification','Station dispute / clarification','station'),
   ('returned_to_station','station_clarification','Returned to station','station'),
   ('cluster_validation_pending','cluster_validation','Cluster validation','cluster'),
   ('imported','cluster_validation','Ready for cluster validation','cluster'),
   ('slp_final_confirmation_pending','slp_confirmation','SLP final confirmation','slp'),
   ('needs_review','recovery_review','Recovery needs review','cluster'),
   ('exit_balance','recovery_blocked','Exit balance','slp'),
   ('recovery_approved_scheduled','recovery_due','Approved — schedule / due','recovery_owner')
  ) as x(status, action_key, action_label, owner_role)
  where x.status = c.lifecycle_status
 ) v
 where c.company_id = p_company and c.source_present
   and nl_case_recoverable(p_company, c.report, c.source_status)
$$;

revoke all on function public.nl_loss_recovery_action_items(uuid) from public, anon, authenticated;
grant execute on function public.nl_loss_recovery_action_items(uuid) to service_role;
