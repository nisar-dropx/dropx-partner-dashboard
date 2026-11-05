do $migration$
declare definition text;
begin
 definition:=pg_get_functiondef('public.nl_loss_close_period(uuid,text,text,text[],uuid,text)'::regprocedure);
 if position('-- Do not strand active reviews' in definition)=0 then
  if position('insert into public.nl_loss_period_closures' in definition)=0 then raise exception 'Period closure anchor not found'; end if;
  definition:=replace(definition,'insert into public.nl_loss_period_closures',$body$
 -- Do not strand active reviews behind an irreversible manual-write lock.
 if exists(select 1 from public.nl_loss_month_cases c
   join public.nl_case_response_windows w on w.company_id=c.company_id and w.month=c.month and w.case_key=c.case_key
   where c.company_id=p_company and c.report=p_report and c.station_code=any(p_stations)
    and (case when c.report='slp' then coalesce(nullif(c.details->>'period',''),c.month) else c.month end)=p_period
    and w.enabled) then
  raise exception 'Cannot close this period: active redisputes remain. Complete their review and final outcome, or revoke them in Exceptions.';
 end if;
 if exists(select 1 from public.nl_loss_month_cases c
   join public.nl_loss_recoveries r on r.company_id=c.company_id and r.month=c.month and r.case_key=c.case_key
   where c.company_id=p_company and c.report=p_report and c.station_code=any(p_stations)
    and (case when c.report='slp' then coalesce(nullif(c.details->>'period',''),c.month) else c.month end)=p_period
    and not r.is_deleted and r.approval_status in ('proposed','needs_review','returned')) then
  raise exception 'Cannot close this period: recovery plans still require approval or correction.';
 end if;
 insert into public.nl_loss_period_closures$body$);
  execute definition;
 end if;
end $migration$;
