-- Keep pending/approved training grounded when identity or work evidence changes.
create or replace function public.recheck_worked_id_training_evidence() returns trigger
language plpgsql security definer set search_path='' as $$
declare v jsonb; prior jsonb; c uuid; lo date; hi date; t public.workforce_buddy_training_requests; buddy uuid;
begin
 v:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
 prior:=case when tg_op='INSERT' then v else to_jsonb(old) end;
 if tg_table_name='workforce_worked_id_shares' then
  select r.company_id,r.work_date,r.work_date into c,lo,hi from public.workforce_worked_id_reviews r where r.id=(v->>'review_id')::uuid;
 else
  c:=(v->>'company_id')::uuid;
  lo:=least(coalesce((v->>'work_date')::date,(v->>'effective_from')::date),coalesce((prior->>'work_date')::date,(prior->>'effective_from')::date));
  hi:=greatest(coalesce((v->>'work_date')::date,(v->>'effective_to')::date,'infinity'::date),coalesce((prior->>'work_date')::date,(prior->>'effective_to')::date,'infinity'::date));
 end if;
 if exists(select 1 from public.workforce_buddy_training_requests r where r.company_id=c and r.work_date between lo and hi and r.status in('pending','approved')) then
  perform public.lock_workforce_payment_allocation_company(c);
  for t in select * from public.workforce_buddy_training_requests r where r.company_id=c and r.work_date between lo and hi and r.status in('pending','approved') loop
   begin
    buddy:=public.worked_id_training_buddy(t.company_id,t.workforce_id,t.station_id,t.work_date,t.buddy_source_id);
    if buddy<>t.buddy_workforce_id then raise exception 'The recorded buddy identity would change.';end if;
   exception when others then
    raise exception 'This change conflicts with buddy training on %. Resolve that training request first. %',t.work_date,sqlerrm;
   end;
  end loop;
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
revoke all on function public.recheck_worked_id_training_evidence() from public,anon,authenticated;
drop trigger if exists worked_id_training_evidence_recheck on public.field_executive_provider_mappings;
create trigger worked_id_training_evidence_recheck after insert or update or delete on public.field_executive_provider_mappings for each row execute function public.recheck_worked_id_training_evidence();
drop trigger if exists worked_id_training_evidence_recheck on public.workforce_payment_allocations;
create trigger worked_id_training_evidence_recheck after insert or update or delete on public.workforce_payment_allocations for each row execute function public.recheck_worked_id_training_evidence();
drop trigger if exists worked_id_training_evidence_recheck on public.workforce_worked_id_reviews;
create trigger worked_id_training_evidence_recheck after insert or update or delete on public.workforce_worked_id_reviews for each row execute function public.recheck_worked_id_training_evidence();
drop trigger if exists worked_id_training_evidence_recheck on public.workforce_worked_id_shares;
create trigger worked_id_training_evidence_recheck after insert or update or delete on public.workforce_worked_id_shares for each row execute function public.recheck_worked_id_training_evidence();
drop trigger if exists worked_id_training_evidence_recheck on public.cps_shipment_daily;
create trigger worked_id_training_evidence_recheck after insert or update or delete on public.cps_shipment_daily for each row execute function public.recheck_worked_id_training_evidence();
