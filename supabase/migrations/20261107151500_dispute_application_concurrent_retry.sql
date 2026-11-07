-- A second worker may observe changed evidence after the first applied it.
-- Preserve verification in that race; an explicit manual processor can still pause it.
create or replace function public.workforce_pause_dispute_application(p_company uuid,p_dispute uuid,p_message text)
returns void language sql security definer set search_path='' as $$
 update public.workforce_dispute_application_jobs j
 set state='blocked',attempts=3,last_error=left(p_message,1500),updated_at=now()
 where j.company_id=p_company and j.dispute_id=p_dispute and j.state<>'completed'
 and (j.applied_at is null or exists(select 1 from public.workforce_payout_disputes d
   where d.id=p_dispute and d.company_id=p_company and d.status in ('processing','processing_blocked')));
$$;
revoke all on function public.workforce_pause_dispute_application(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.workforce_pause_dispute_application(uuid,uuid,text) to service_role;
