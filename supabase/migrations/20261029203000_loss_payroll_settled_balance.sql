-- Created with Supabase migration new; ordered after the payroll-window boundary.
-- Available salary must subtract actual settlement, attributed to its current owner.
begin;
do $$
declare d text;
begin
 d:=pg_get_functiondef('public.loss_recovery_payroll_windows(uuid,text[])'::regprocedure);
 if position('-- Actual settled credits' in d)=0 then
  if position('coalesce(sum(b.instruction_amount) filter(where b.status=''paid''),0) paid' in d)=0 then
   raise exception 'Unexpected payroll window definition; refusing partial update';
  end if;
  d:=replace(d,'coalesce(sum(b.instruction_amount) filter(where b.status=''paid''),0) paid',
   $p$coalesce((select sum(e.settled_amount_snapshot)
    from workforce_payout_effective_paid_allocations e
    where e.company_id=p_company and e.credited_workforce_id=w.workforce_id
     and e.period_start=w.period_start and e.period_end=(w.period_start+interval '1 month -1 day')::date),0) paid -- Actual settled credits
   $p$);
  execute d;
 end if;
end $$;
notify pgrst,'reload schema';
commit;
