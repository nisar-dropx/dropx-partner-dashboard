-- One-time administrative closure explicitly requested by Managing Partner.
-- Preserve original rows in immutable events. Never manufacture a payroll correction.
do $$
declare actor record; item record; total integer; already_closed integer;
begin
 select p.id,p.company_id,p.full_name into actor from public.profiles p
 where lower(p.email)='jamsheer@dropxlogistics.com' and p.is_active;
 if not found then return; end if;
 select count(*) into already_closed from public.workforce_payout_dispute_events
 where company_id=actor.company_id and event_type='historical_closure_20261101';
 if already_closed=45 then return; end if;
 if already_closed<>0 then raise exception 'Unexpected partial legacy closure; inspect before continuing'; end if;
 perform 1 from public.workforce_payout_disputes d
 where d.company_id=actor.company_id and d.status in ('open','pending_final_approval')
 and d.created_at < '2026-10-16T00:00:00Z'::timestamptz for update;
 select count(*) into total from public.workforce_payout_disputes d
 join public.workforce_payout_publications p on p.id=d.publication_id
 where d.company_id=actor.company_id and d.status in ('open','pending_final_approval')
 and d.created_at < '2026-10-16T00:00:00Z'::timestamptz
 and p.period_start='2026-09-01' and p.period_end='2026-09-30';
 if total<>45 then raise exception 'Legacy cohort changed: expected 45, found %',total; end if;
 for item in select d.* from public.workforce_payout_disputes d
 join public.workforce_payout_publications p on p.id=d.publication_id
 where d.company_id=actor.company_id and d.status in ('open','pending_final_approval')
 and d.created_at < '2026-10-16T00:00:00Z'::timestamptz
 and p.period_start='2026-09-01' and p.period_end='2026-09-30'
 loop
  update public.workforce_payout_disputes set status='resolved',
   resolution='Closed previously: Managing Partner confirmed this dispute was already settled. Historical closure only; no new payout adjustment.',
   resolved_by=actor.id,resolved_at=clock_timestamp(),updated_at=clock_timestamp(),
   version=item.version+1,legacy_resolution_unverified=true
   where id=item.id and version=item.version;
  insert into public.workforce_payout_dispute_events
   (company_id,dispute_id,actor_id,actor_name,portal,message,event_type,from_status,to_status,metadata,dispute_version)
  values(actor.company_id,item.id,actor.id,actor.full_name,'ops',
   'Previously settled; closed on Managing Partner instruction. Original history retained. No payout changed.',
   'historical_closure_20261101',item.status,'resolved',
   jsonb_build_object('before',to_jsonb(item),'net_change_verified',false),item.version+1);
 end loop;
end $$;

