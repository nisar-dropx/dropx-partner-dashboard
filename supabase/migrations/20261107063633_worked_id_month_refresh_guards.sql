-- Attendance units, paid-off credit and production minimums are month-based.
-- A correction can affect later dates and other stations in the same month.
create or replace function public.worked_id_check_open(p_company uuid,p_worker uuid,p_date date) returns void
language plpgsql set search_path='' as $$
declare month_from date:=date_trunc('month',p_date)::date;
 month_to date:=(date_trunc('month',p_date)+interval '1 month - 1 day')::date;
begin
 if exists(select 1 from public.workforce_payout_payment_items i where i.company_id=p_company and i.workforce_id=p_worker
   and i.period_start<=month_to and i.period_end>=month_from and i.status in('processing','paid'))
 or exists(select 1 from public.workforce_payout_effective_paid_allocations a where a.company_id=p_company and a.credited_workforce_id=p_worker
   and a.period_start<=month_to and a.period_end>=month_from)
 or exists(select 1 from public.workforce_payroll_runs r join public.workforce_payroll_items i on i.payroll_run_id=r.id and i.company_id=r.company_id
   where r.company_id=p_company and i.workforce_id=p_worker and r.status in('approved','paid') and i.status<>'excluded'
   and r.period_start<=month_to and r.period_end>=month_from)
 then raise exception 'This month has an approved, paid or bank-processing payout. Finance must resolve it before changing worked IDs or attendance.';end if;
end $$;

create or replace function public.refresh_worked_id_month(p_company uuid,p_worker uuid,p_date date,p_actor uuid) returns void
language plpgsql set search_path='' as $$
declare station uuid; month_from date:=date_trunc('month',p_date)::date;
 month_to date:=(date_trunc('month',p_date)+interval '1 month - 1 day')::date;
begin
 for station in select distinct p.station_id from public.workforce_payout_publications p
  where p.company_id=p_company and p.workforce_id=p_worker and p.publication_kind='worksheet'
   and p.period_start<=month_to and p.period_end>=month_from
 loop
  perform public.enqueue_workforce_payout_dependency_refresh(p_company,p_worker,station,month_from,month_to,p_actor);
 end loop;
end $$;
revoke all on function public.refresh_worked_id_month(uuid,uuid,date,uuid) from public,anon,authenticated;
grant execute on function public.refresh_worked_id_month(uuid,uuid,date,uuid) to service_role;
do $migration$
declare body text;
begin
 body:=pg_get_functiondef('public.save_workforce_worked_id_review(uuid,uuid,uuid,uuid,date,text,text,integer,jsonb)'::regprocedure);
 body:=replace(body,'perform public.enqueue_workforce_payout_dependency_refresh(p_company,x,p_station,p_date,p_date,p_actor);',
   'perform public.refresh_worked_id_month(p_company,x,p_date,p_actor);');
 if position('perform public.refresh_worked_id_month(p_company,x,p_date,p_actor);' in body)=0 then raise exception 'Unexpected Worked ID review refresh definition';end if;
 execute body;
end $migration$;
