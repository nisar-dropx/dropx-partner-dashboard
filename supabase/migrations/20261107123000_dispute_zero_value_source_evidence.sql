begin;
create or replace function public.workforce_dispute_snapshot_value(p_snapshot jsonb, p_item jsonb)
returns numeric language plpgsql immutable set search_path='' as $$
declare result numeric; n integer; selector text := p_item->>'selector';
begin
  if selector='deduction' then
    select sum((d->>'amount')::numeric),count(*) into result,n
    from jsonb_array_elements(coalesce(p_snapshot#>'{worksheet,deduction_breakdown}','[]')) d
    where d->>'code'=p_item->>'code' and (nullif(p_item->>'recovery_key','') is null or d->>'recoveryKey'=p_item->>'recovery_key');
  elsif selector in ('addition','incentive') then
    select sum(case when selector='addition' then (l->>'adjustment_amount')::numeric else (l->>'incentive_amount')::numeric end),count(*) into result,n
    from jsonb_array_elements(coalesce(p_snapshot->'lines','[]')) l
    where l->>'source_type'=case when selector='addition' then 'additional_payment' else 'incentive' end and l#>>'{calculation_snapshot,category}'=p_item->>'code';
  elsif selector='attendance' then
    select sum((l#>>'{calculation_snapshot,workDayUnits}')::numeric),count(*) into result,n
    from jsonb_array_elements(coalesce(p_snapshot->'lines','[]')) l
    where l->>'work_date'=p_item->>'date' and l#>>'{calculation_snapshot,workDayUnits}' is not null;
  elsif selector in ('count','rate','amount') then
    select case when selector='rate' then min((v->>selector)::numeric) else sum((v->>selector)::numeric) end,count(*) into result,n
    from jsonb_array_elements(coalesce(p_snapshot->'lines','[]')) l
    cross join lateral jsonb_array_elements(coalesce(l#>'{calculation_snapshot,paymentLines}','[]')) v
    where l->>'work_date'=p_item->>'date' and v->>'code'=p_item->>'code';
    if selector='rate' and exists(
      select 1 from jsonb_array_elements(coalesce(p_snapshot->'lines','[]')) l
      cross join lateral jsonb_array_elements(coalesce(l#>'{calculation_snapshot,paymentLines}','[]')) v
      where l->>'work_date'=p_item->>'date' and v->>'code'=p_item->>'code' and (v->>'rate')::numeric<>result
    ) then return null; end if;
  else return null;
  end if;
  if n=0 then return null; end if;
  return round(result,2);
end $$;
revoke all on function public.workforce_dispute_snapshot_value(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.workforce_dispute_snapshot_value(jsonb,jsonb) to service_role;


commit;
