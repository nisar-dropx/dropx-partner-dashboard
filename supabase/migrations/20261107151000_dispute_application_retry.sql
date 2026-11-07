-- Record transient failures without losing an already-applied correction.
create or replace function public.workforce_note_dispute_application_retry(p_company uuid,p_dispute uuid,p_message text)
returns void language sql security definer set search_path='' as $$
 update public.workforce_dispute_application_jobs
 set state=case when applied_at is not null then 'awaiting_publication' else 'blocked' end,
 attempts=case when applied_at is not null then attempts else attempts+1 end,
 last_error=left(p_message,1500),updated_at=now()
 where company_id=p_company and dispute_id=p_dispute and state<>'completed'
 and exists(select 1 from public.workforce_payout_disputes d where d.id=p_dispute and d.company_id=p_company and d.status='approved_for_processing');
$$;
revoke all on function public.workforce_note_dispute_application_retry(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.workforce_note_dispute_application_retry(uuid,uuid,text) to service_role;
