begin;
-- Payout disputes raised in DropX One are decided through review and approval, never by one person.
--
--   open ──reviewer proposes resolve/reject (note)──► in_review ──another person approves──► resolved | rejected
--                                                       └──sends back (note)──► open
--
-- The reviewer's note becomes the resolution the associate sees. Each step is a dispute event.
-- The single-step workforce_decide_payout_dispute stays for the currently deployed portal; the new
-- portal uses only these functions.

alter table public.workforce_payout_disputes
 add column if not exists proposed_decision text check (proposed_decision is null or proposed_decision in ('resolved','rejected')),
 add column if not exists proposed_note text,
 add column if not exists proposed_by uuid,
 add column if not exists proposed_by_name text,
 add column if not exists proposed_at timestamptz,
 add column if not exists approved_by_name text;

create or replace function public.workforce_dispute_step(p_company uuid,p_dispute uuid,p_actor uuid,p_actor_name text,p_step text,p_decision text,p_note text,p_locations uuid[])
returns public.workforce_payout_disputes language plpgsql set search_path='' as $$
declare d public.workforce_payout_disputes; note text:=nullif(btrim(coalesce(p_note,'')),''); name text:=coalesce(nullif(btrim(p_actor_name),''),'Authorised reviewer'); saved public.workforce_payout_disputes; msg text;
begin
 select * into d from public.workforce_payout_disputes where id=p_dispute and company_id=p_company for update;
 if not found or p_actor is null or (p_locations is not null and not coalesce(d.station_id=any(p_locations),false)) then raise exception 'Dispute is outside your scope'; end if;
 if note is not null and length(note)>1000 then raise exception 'Keep the note under 1,000 characters.'; end if;
 if p_step='propose' then
  if d.status<>'open' then raise exception 'This dispute is already %.',replace(d.status,'_',' '); end if;
  if p_decision not in ('resolved','rejected') then raise exception 'Choose Resolve or Reject.'; end if;
  if note is null or length(note)<10 then raise exception 'Explain the decision for the associate (at least 10 characters).'; end if;
  update public.workforce_payout_disputes set status='in_review',proposed_decision=p_decision,proposed_note=note,proposed_by=p_actor,proposed_by_name=name,proposed_at=now(),updated_at=now()
   where id=d.id returning * into saved;
  msg:='Proposed to '||case p_decision when 'resolved' then 'resolve' else 'reject' end||': '||note;
 elsif p_step in ('approve','send_back') then
  if d.status<>'in_review' or d.proposed_decision is null then raise exception 'This dispute has no decision waiting for approval.'; end if;
  if d.proposed_by=p_actor then raise exception 'You proposed this decision, so another reviewer must approve it.'; end if;
  if p_step='approve' then
   update public.workforce_payout_disputes set status=d.proposed_decision,resolution=d.proposed_note,resolved_by=p_actor,approved_by_name=name,resolved_at=now(),updated_at=now()
    where id=d.id returning * into saved;
   msg:='Approved: '||case d.proposed_decision when 'resolved' then 'resolved' else 'rejected' end||coalesce(' · '||note,'');
  else
   if note is null or length(note)<5 then raise exception 'Say why it goes back (at least 5 characters).'; end if;
   update public.workforce_payout_disputes set status='open',proposed_decision=null,proposed_note=null,proposed_by=null,proposed_by_name=null,proposed_at=null,updated_at=now()
    where id=d.id returning * into saved;
   msg:='Sent back for review: '||note;
  end if;
 else
  raise exception 'Unknown step.';
 end if;
 insert into public.workforce_payout_dispute_events(company_id,dispute_id,actor_id,actor_name,portal,message) values(p_company,d.id,p_actor,name,'workforce',msg);
 return saved;
end $$;
revoke all on function public.workforce_dispute_step(uuid,uuid,uuid,text,text,text,text,uuid[]) from public,anon,authenticated;
grant execute on function public.workforce_dispute_step(uuid,uuid,uuid,text,text,text,text,uuid[]) to service_role;
create index if not exists workforce_payout_disputes_open_idx on public.workforce_payout_disputes(company_id,status,created_at desc);
notify pgrst,'reload schema';
commit;
